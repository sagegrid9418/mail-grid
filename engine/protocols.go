package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	imapbackend "github.com/emersion/go-imap/backend"
	imapserver "github.com/emersion/go-imap/server"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

type authIMAP struct {
	store   *mailStore
	updates <-chan imapbackend.Update
}

func (a *authIMAP) Updates() <-chan imapbackend.Update { return a.updates }

func (a *authIMAP) Login(_ *imap.ConnInfo, username, password string) (imapbackend.User, error) {
	username = strings.ToLower(strings.TrimSpace(username))
	if !a.store.authenticate(username, password) {
		return nil, imapbackend.ErrInvalidCredentials
	}
	return a.store.mail.GetUser(username)
}

type smtpSession struct {
	store *mailStore
	from  string
	rcpts []string
	user  string
}

func (s *smtpSession) Reset()        { s.from = ""; s.rcpts = nil }
func (s *smtpSession) Logout() error { return nil }
func (s *smtpSession) Mail(from string, _ *smtp.MailOptions) error {
	s.from = from
	s.rcpts = nil
	return nil
}
func (s *smtpSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	if _, err := normalizeAddress(to); err != nil {
		return &smtp.SMTPError{Code: 553, Message: "Invalid recipient"}
	}
	s.rcpts = append(s.rcpts, to)
	return nil
}
func (s *smtpSession) Data(r io.Reader) error {
	raw, err := io.ReadAll(io.LimitReader(r, maxMessageBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > maxMessageBytes {
		return &smtp.SMTPError{Code: 552, Message: "Message exceeds 25 MB limit"}
	}
	if err := s.store.deliver(raw, s.rcpts, s.user); err != nil {
		return &smtp.SMTPError{Code: 451, Message: "Local storage failed: " + err.Error()}
	}
	s.Reset()
	return nil
}
func (s *smtpSession) AuthMechanisms() []string { return []string{sasl.Plain} }
func (s *smtpSession) Auth(mech string) (sasl.Server, error) {
	if mech != sasl.Plain {
		return nil, smtp.ErrAuthUnknownMechanism
	}
	return sasl.NewPlainServer(func(identity, username, password string) error {
		username = strings.ToLower(username)
		if identity != "" && identity != username {
			return smtp.ErrAuthFailed
		}
		if !s.store.authenticate(username, password) {
			return smtp.ErrAuthFailed
		}
		s.user = username
		return nil
	}), nil
}

type listeners struct {
	smtp  *smtp.Server
	imap  *imapserver.Server
	ports ports
	all   []net.Listener
}

func startListeners(s *mailStore, p ports) (*listeners, error) {
	if p.SMTP == p.IMAP || p.SMTP == p.POP3 || p.IMAP == p.POP3 {
		return nil, errors.New("mail ports must be different")
	}
	bind := func(port int) (net.Listener, error) { return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)) }
	a, err := bind(p.SMTP)
	if err != nil {
		return nil, fmt.Errorf("SMTP port %d: %w", p.SMTP, err)
	}
	b, err := bind(p.IMAP)
	if err != nil {
		a.Close()
		return nil, fmt.Errorf("IMAP port %d: %w", p.IMAP, err)
	}
	c, err := bind(p.POP3)
	if err != nil {
		a.Close()
		b.Close()
		return nil, fmt.Errorf("POP3 port %d: %w", p.POP3, err)
	}
	smtpServer := smtp.NewServer(smtp.BackendFunc(func(_ *smtp.Conn) (smtp.Session, error) { return &smtpSession{store: s}, nil }))
	smtpServer.Domain = "mailgrid.test"
	smtpServer.AllowInsecureAuth = true // The listener is loopback only.
	smtpServer.MaxMessageBytes = maxMessageBytes
	smtpServer.MaxRecipients = 100
	smtpServer.ReadTimeout = 60 * time.Second
	smtpServer.WriteTimeout = 60 * time.Second
	updates := make(chan imapbackend.Update, 32)
	source := s.mail.Updates()
	go func() {
		for update := range source {
			if s.events != nil {
				s.events("mailbox_changed", nil)
			}
			updates <- update
		}
		// go-imap v1 does not handle a closed update channel. Leave this relay
		// open until process exit after the listeners and store are closed.
	}()
	imapServer := imapserver.New(&authIMAP{store: s, updates: updates})
	imapServer.AllowInsecureAuth = true // The listener is loopback only.
	imapServer.MaxLiteralSize = maxMessageBytes
	imapServer.AutoLogout = 30 * time.Minute
	l := &listeners{smtp: smtpServer, imap: imapServer, ports: p, all: []net.Listener{a, b, c}}
	go func() {
		if err := smtpServer.Serve(a); err != nil && !errors.Is(err, net.ErrClosed) {
			fmt.Fprintln(os.Stderr, "SMTP listener:", err)
		}
	}()
	go func() {
		if err := imapServer.Serve(b); err != nil && !errors.Is(err, net.ErrClosed) {
			fmt.Fprintln(os.Stderr, "IMAP listener:", err)
		}
	}()
	go servePOP3(c, s)
	return l, nil
}

func (l *listeners) close() {
	for _, ln := range l.all {
		_ = ln.Close()
	}
	if l.smtp != nil {
		_ = l.smtp.Close()
	}
	if l.imap != nil {
		_ = l.imap.Close()
	}
}
