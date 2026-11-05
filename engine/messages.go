package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/mail"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	message "github.com/emersion/go-message"
	"github.com/emersion/go-message/charset"
	mailreader "github.com/emersion/go-message/mail"
)

type summary struct {
	UID     uint32 `json:"uid"`
	Subject string `json:"subject"`
	From    string `json:"from"`
	To      string `json:"to"`
	Date    int64  `json:"date"`
	Size    uint32 `json:"size"`
	Unread  bool   `json:"unread"`
}
type attachment struct {
	Index int    `json:"index"`
	Name  string `json:"name"`
	Type  string `json:"type"`
	Size  int    `json:"size"`
	Data  string `json:"data,omitempty"`
}
type detail struct {
	UID         uint32       `json:"uid"`
	Subject     string       `json:"subject"`
	From        string       `json:"from"`
	To          string       `json:"to"`
	DeliveredTo string       `json:"deliveredTo"`
	Date        string       `json:"date"`
	Text        string       `json:"text"`
	HTML        string       `json:"html"`
	Raw         string       `json:"raw"`
	Headers     string       `json:"headers"`
	Attachments []attachment `json:"attachments"`
}

func addresses(items []*imap.Address) string {
	parts := []string{}
	for _, a := range items {
		if a != nil {
			parts = append(parts, a.Address())
		}
	}
	return strings.Join(parts, ", ")
}

func (s *mailStore) listMessages(address, folder, query string, limit int) ([]summary, error) {
	m, uids, err := s.allUIDs(address, folder)
	if err != nil {
		return nil, err
	}
	if len(uids) == 0 {
		return []summary{}, nil
	}
	// Fetch in small batches; search is local and typical test inboxes are small.
	msgs, err := fetchMessages(m, uids, []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope, imap.FetchFlags, imap.FetchInternalDate, imap.FetchRFC822Size})
	if err != nil {
		return nil, err
	}
	query = strings.ToLower(strings.TrimSpace(query))
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	result := []summary{}
	for _, msg := range msgs {
		v := summary{UID: msg.Uid, Date: msg.InternalDate.Unix(), Size: msg.Size, Unread: true}
		if msg.Envelope != nil {
			v.Subject = decodeHeader(msg.Envelope.Subject)
			v.From = addresses(msg.Envelope.From)
			v.To = addresses(msg.Envelope.To)
		}
		for _, flag := range msg.Flags {
			if strings.EqualFold(flag, imap.SeenFlag) {
				v.Unread = false
			}
		}
		if query != "" && !strings.Contains(strings.ToLower(v.Subject+" "+v.From+" "+v.To), query) {
			continue
		}
		result = append(result, v)
		if len(result) >= limit {
			break
		}
	}
	return result, nil
}

func (s *mailStore) messageDetail(address, folder string, uid uint32) (detail, error) {
	raw, err := s.rawMessage(address, folder, uid)
	if err != nil {
		return detail{}, err
	}
	return parseDetail(uid, raw, false)
}

func parseDetail(uid uint32, raw []byte, includeData bool) (detail, error) {
	d := detail{UID: uid, Raw: string(raw), Attachments: []attachment{}}
	if idx := bytes.Index(raw, []byte("\r\n\r\n")); idx >= 0 {
		d.Headers = string(raw[:idx])
	} else if idx := bytes.Index(raw, []byte("\n\n")); idx >= 0 {
		d.Headers = string(raw[:idx])
	}
	msg, err := mail.ReadMessage(bytes.NewReader(raw))
	if err == nil {
		d.Subject = decodeHeader(msg.Header.Get("Subject"))
		d.From = decodeHeader(msg.Header.Get("From"))
		d.To = decodeHeader(msg.Header.Get("To"))
		d.DeliveredTo = msg.Header.Get("X-MailGrid-Recipients")
		d.Date = msg.Header.Get("Date")
	}
	r, err := mailreader.CreateReader(bytes.NewReader(raw))
	if err != nil && !message.IsUnknownCharset(err) {
		return d, nil
	}
	if r == nil {
		return d, nil
	}
	for {
		part, err := r.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil && !message.IsUnknownCharset(err) {
			break
		}
		if part == nil {
			continue
		}
		data, readErr := io.ReadAll(io.LimitReader(part.Body, maxMessageBytes+1))
		if readErr != nil {
			continue
		}
		mediaType, _, _ := mime.ParseMediaType(part.Header.Get("Content-Type"))
		switch h := part.Header.(type) {
		case *mailreader.InlineHeader:
			if mediaType == "text/html" && d.HTML == "" {
				d.HTML = string(data)
			} else if mediaType == "text/plain" && d.Text == "" {
				d.Text = string(data)
			}
		case *mailreader.AttachmentHeader:
			name, _ := h.Filename()
			if name == "" {
				name = fmt.Sprintf("attachment-%d", len(d.Attachments)+1)
			}
			a := attachment{Index: len(d.Attachments), Name: name, Type: mediaType, Size: len(data)}
			if includeData {
				a.Data = base64.StdEncoding.EncodeToString(data)
			}
			d.Attachments = append(d.Attachments, a)
		}
	}
	return d, nil
}

func decodeHeader(value string) string {
	decoded, err := (&mime.WordDecoder{CharsetReader: charset.Reader}).DecodeHeader(value)
	if err == nil {
		return decoded
	}
	return value
}

func (s *mailStore) getAttachment(address, folder string, uid uint32, index int) (attachment, error) {
	raw, err := s.rawMessage(address, folder, uid)
	if err != nil {
		return attachment{}, err
	}
	d, err := parseDetail(uid, raw, true)
	if err != nil {
		return attachment{}, err
	}
	if index < 0 || index >= len(d.Attachments) {
		return attachment{}, errors.New("attachment not found")
	}
	return d.Attachments[index], nil
}

type composeRequest struct {
	From    string   `json:"from"`
	To      []string `json:"to"`
	Subject string   `json:"subject"`
	Text    string   `json:"text"`
	HTML    string   `json:"html"`
}

func (s *mailStore) compose(req composeRequest) error {
	from, err := normalizeAddress(req.From)
	if err != nil {
		return err
	}
	if !s.accountExists(from) {
		return errors.New("choose a created account as sender")
	}
	if len(req.To) == 0 {
		return errors.New("add a recipient")
	}
	to := make([]string, 0, len(req.To))
	for _, v := range req.To {
		a, err := normalizeAddress(v)
		if err != nil {
			return err
		}
		to = append(to, a)
	}
	if strings.ContainsAny(req.Subject, "\r\n") {
		return errors.New("invalid subject")
	}
	if len(req.Text)+len(req.HTML) > maxMessageBytes-4096 {
		return errors.New("message too large")
	}
	id := make([]byte, 12)
	if _, err := rand.Read(id); err != nil {
		return err
	}
	var b bytes.Buffer
	fmt.Fprintf(&b, "From: <%s>\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nMessage-ID: <%s@mailgrid.test>\r\nMIME-Version: 1.0\r\n", from, strings.Join(to, ", "), mime.QEncoding.Encode("utf-8", req.Subject), time.Now().Format(time.RFC1123Z), hex.EncodeToString(id))
	if req.HTML != "" {
		boundary := "mailgrid-" + hex.EncodeToString(id)
		fmt.Fprintf(&b, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", boundary)
		fmt.Fprintf(&b, "--%s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n", boundary, normalizeCRLF(req.Text))
		fmt.Fprintf(&b, "--%s\r\nContent-Type: text/html; charset=utf-8\r\n\r\n%s\r\n--%s--\r\n", boundary, normalizeCRLF(req.HTML), boundary)
	} else {
		fmt.Fprintf(&b, "Content-Type: text/plain; charset=utf-8\r\n\r\n%s\r\n", normalizeCRLF(req.Text))
	}
	return s.deliver(b.Bytes(), to, from)
}

func normalizeCRLF(v string) string {
	v = strings.ReplaceAll(v, "\r\n", "\n")
	v = strings.ReplaceAll(v, "\r", "\n")
	return strings.ReplaceAll(v, "\n", "\r\n")
}

func sortSummariesByDate(items []summary) {
	sort.Slice(items, func(i, j int) bool { return items[i].Date > items[j].Date })
}
