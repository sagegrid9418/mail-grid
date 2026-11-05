package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net/mail"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap"
	"github.com/emersion/go-message/textproto"
	imapsql "github.com/foxcpp/go-imap-sql"
	"golang.org/x/crypto/bcrypt"
	"modernc.org/sqlite"
)

const catchAll = "catchall@mailgrid.internal"
const maxMessageBytes = 25 << 20

func init() {
	for _, name := range sql.Drivers() {
		if name == "sqlite3" {
			return
		}
	}
	sql.Register("sqlite3", &sqlite.Driver{})
}

type storeLogger struct{}

func (storeLogger) Printf(format string, args ...interface{}) { log.Printf(format, args...) }
func (storeLogger) Println(args ...interface{})               { log.Println(args...) }
func (storeLogger) Debugf(string, ...interface{})             {}
func (storeLogger) Debugln(...interface{})                    {}

type account struct {
	Address string `json:"address"`
	Created int64  `json:"created"`
}

type mailStore struct {
	accounts *sql.DB
	mail     *imapsql.Backend
	events   func(string, any)
	popLocks sync.Map
}

func openStore(dataDir string, events func(string, any)) (*mailStore, error) {
	if err := os.MkdirAll(filepath.Join(dataDir, "blobs"), 0700); err != nil {
		return nil, err
	}
	accountDB, err := sql.Open("sqlite3", filepath.Join(dataDir, "accounts.db"))
	if err != nil {
		return nil, err
	}
	accountDB.SetMaxOpenConns(1)
	if _, err = accountDB.Exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
		CREATE TABLE IF NOT EXISTS accounts(address TEXT PRIMARY KEY, password_hash BLOB NOT NULL, created INTEGER NOT NULL);`); err != nil {
		accountDB.Close()
		return nil, err
	}
	limit := uint32(maxMessageBytes)
	mail, err := imapsql.New("sqlite3", filepath.Join(dataDir, "mail.db"), &imapsql.FSStore{Root: filepath.Join(dataDir, "blobs")}, imapsql.Opts{MaxMsgBytes: &limit, LazyUpdatesInit: true, Log: storeLogger{}})
	if err != nil {
		accountDB.Close()
		return nil, err
	}
	s := &mailStore{accounts: accountDB, mail: mail, events: events}
	if _, err := mail.GetOrCreateUser(catchAll); err != nil {
		s.close()
		return nil, err
	}
	rows, err := accountDB.Query(`SELECT address FROM accounts`)
	if err != nil {
		s.close()
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var address string
		if err := rows.Scan(&address); err != nil {
			s.close()
			return nil, err
		}
		if _, err := mail.GetOrCreateUser(address); err != nil {
			s.close()
			return nil, err
		}
	}
	if err := rows.Err(); err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *mailStore) close() {
	if s.mail != nil {
		_ = s.mail.Close()
	}
	if s.accounts != nil {
		_ = s.accounts.Close()
	}
}

func normalizeAddress(v string) (string, error) {
	v = strings.ToLower(strings.TrimSpace(v))
	if len(v) > 254 || len(v) < 3 || strings.Count(v, "@") != 1 || strings.ContainsAny(v, " \t\r\n<>;,/") {
		return "", errors.New("enter a valid email address")
	}
	parts := strings.SplitN(v, "@", 2)
	if parts[0] == "" || parts[1] == "" {
		return "", errors.New("enter a valid email address")
	}
	return v, nil
}

func generatePassword() (string, error) {
	b := make([]byte, 18)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Prehash new passwords so bcrypt does not impose its 72-byte input limit.
// The prefix keeps existing bcrypt-only account hashes compatible.
func hashPassword(password string) ([]byte, error) {
	digest := sha256.Sum256([]byte(password))
	hash, err := bcrypt.GenerateFromPassword(digest[:], bcrypt.DefaultCost)
	if err != nil {
		return nil, err
	}
	return append([]byte("sha256:"), hash...), nil
}

func (s *mailStore) createAccount(address, password string) (map[string]string, error) {
	var err error
	address, err = normalizeAddress(address)
	if err != nil {
		return nil, err
	}
	if address == catchAll {
		return nil, errors.New("this address is reserved")
	}
	if s.accountExists(address) {
		return nil, errors.New("an account with this email address already exists")
	}
	if password == "" {
		password, err = generatePassword()
		if err != nil {
			return nil, err
		}
	}
	hash, err := hashPassword(password)
	if err != nil {
		return nil, err
	}
	if _, err = s.accounts.Exec(`INSERT INTO accounts(address,password_hash,created) VALUES(?,?,?)`, address, hash, time.Now().Unix()); err != nil {
		return nil, err
	}
	if _, err = s.mail.GetOrCreateUser(address); err != nil {
		_, _ = s.accounts.Exec(`DELETE FROM accounts WHERE address=?`, address)
		return nil, err
	}
	return map[string]string{"address": address, "password": password}, nil
}

func (s *mailStore) listAccounts() ([]account, error) {
	rows, err := s.accounts.Query(`SELECT address, created FROM accounts ORDER BY address`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []account{}
	for rows.Next() {
		var a account
		if err := rows.Scan(&a.Address, &a.Created); err != nil {
			return nil, err
		}
		items = append(items, a)
	}
	return items, rows.Err()
}

func (s *mailStore) accountExists(address string) bool {
	var n int
	err := s.accounts.QueryRow(`SELECT 1 FROM accounts WHERE address=?`, strings.ToLower(address)).Scan(&n)
	return err == nil
}

func (s *mailStore) authenticate(address, password string) bool {
	var hash []byte
	if err := s.accounts.QueryRow(`SELECT password_hash FROM accounts WHERE address=?`, strings.ToLower(address)).Scan(&hash); err != nil {
		return false
	}
	if bytes.HasPrefix(hash, []byte("sha256:")) {
		digest := sha256.Sum256([]byte(password))
		return bcrypt.CompareHashAndPassword(hash[len("sha256:"):], digest[:]) == nil
	}
	return bcrypt.CompareHashAndPassword(hash, []byte(password)) == nil
}

func (s *mailStore) resetPassword(address string) (string, error) {
	return s.updatePassword(address, "")
}

func (s *mailStore) updatePassword(address, password string) (string, error) {
	var err error
	if password == "" {
		password, err = generatePassword()
		if err != nil {
			return "", err
		}
	}
	hash, err := hashPassword(password)
	if err != nil {
		return "", err
	}
	res, err := s.accounts.Exec(`UPDATE accounts SET password_hash=? WHERE address=?`, hash, strings.ToLower(address))
	if err != nil {
		return "", err
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return "", errors.New("account not found")
	}
	return password, nil
}

func (s *mailStore) deleteAccount(address string) error {
	address = strings.ToLower(address)
	if !s.accountExists(address) {
		return errors.New("account not found")
	}
	if err := s.mail.DeleteUser(address); err != nil {
		return err
	}
	_, err := s.accounts.Exec(`DELETE FROM accounts WHERE address=?`, address)
	return err
}

func (s *mailStore) deliver(raw []byte, recipients []string, sentBy string) error {
	if len(raw) > maxMessageBytes {
		return errors.New("message exceeds 25 MB limit")
	}
	if len(recipients) == 0 {
		return errors.New("no recipients")
	}
	targets := map[string][]string{}
	for _, value := range recipients {
		address, err := normalizeAddress(value)
		if err != nil {
			return err
		}
		target := catchAll
		if s.accountExists(address) {
			target = address
		}
		targets[target] = append(targets[target], address)
	}
	d := s.mail.NewDelivery()
	defer d.Abort()
	for target, originals := range targets {
		var h textproto.Header
		h.Add("X-MailGrid-Recipients", strings.Join(originals, ", "))
		if err := d.AddRcpt(target, h); err != nil {
			return err
		}
	}
	if err := d.BodyRaw(bytes.NewReader(raw)); err != nil {
		return err
	}
	if err := d.Commit(); err != nil {
		return err
	}
	if sentBy != "" && s.accountExists(sentBy) {
		copy := s.mail.NewDelivery()
		defer copy.Abort()
		err := copy.AddRcpt(sentBy, textproto.Header{})
		if err == nil {
			err = copy.Mailbox("Sent")
			if err == nil {
				err = copy.BodyRaw(bytes.NewReader(raw))
			}
			if err == nil {
				err = copy.Commit()
			}
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "sent-copy error:", err)
		}
	}
	if s.events != nil {
		event := map[string]any{"recipients": recipients, "account": "catchall", "subject": "(no subject)", "from": "Unknown sender"}
		for _, recipient := range recipients {
			address, _ := normalizeAddress(recipient)
			if s.accountExists(address) {
				event["account"] = address
				break
			}
		}
		if message, err := mail.ReadMessage(bytes.NewReader(raw)); err == nil {
			if value := decodeHeader(message.Header.Get("Subject")); value != "" {
				event["subject"] = value
			}
			if value := decodeHeader(message.Header.Get("From")); value != "" {
				event["from"] = value
			}
		}
		s.events("message_received", event)
	}
	return nil
}

func (s *mailStore) mailbox(address, folder string) (*imapsql.Mailbox, error) {
	if address == "catchall" {
		address = catchAll
	}
	if address != catchAll && !s.accountExists(address) {
		return nil, errors.New("account not found")
	}
	if folder == "" {
		folder = "INBOX"
	}
	u, err := s.mail.GetUser(address)
	if err != nil {
		return nil, err
	}
	m, err := u.GetMailbox(folder)
	if err != nil && (folder == "Sent" || folder == "Trash") {
		_ = u.CreateMailbox(folder)
		m, err = u.GetMailbox(folder)
	}
	if err != nil {
		return nil, err
	}
	return m.(*imapsql.Mailbox), nil
}

func fetchMessages(m *imapsql.Mailbox, uids []uint32, items []imap.FetchItem) ([]*imap.Message, error) {
	if len(uids) == 0 {
		return []*imap.Message{}, nil
	}
	set := new(imap.SeqSet)
	set.AddNum(uids...)
	ch := make(chan *imap.Message, len(uids))
	done := make(chan error, 1)
	go func() { done <- m.ListMessages(true, set, items, ch) }()
	msgs := []*imap.Message{}
	for msg := range ch {
		msgs = append(msgs, msg)
	}
	if err := <-done; err != nil {
		return nil, err
	}
	sort.Slice(msgs, func(i, j int) bool { return msgs[i].Uid > msgs[j].Uid })
	return msgs, nil
}

func (s *mailStore) allUIDs(address, folder string) (*imapsql.Mailbox, []uint32, error) {
	m, err := s.mailbox(address, folder)
	if err != nil {
		return nil, nil, err
	}
	uids, err := m.SearchMessages(true, &imap.SearchCriteria{})
	return m, uids, err
}

func (s *mailStore) rawMessage(address, folder string, uid uint32) ([]byte, error) {
	m, err := s.mailbox(address, folder)
	if err != nil {
		return nil, err
	}
	section := &imap.BodySectionName{Peek: true}
	msgs, err := fetchMessages(m, []uint32{uid}, []imap.FetchItem{imap.FetchUid, section.FetchItem()})
	if err != nil {
		return nil, err
	}
	if len(msgs) == 0 {
		return nil, errors.New("message not found")
	}
	for _, body := range msgs[0].Body {
		return io.ReadAll(io.LimitReader(body, maxMessageBytes+1))
	}
	return nil, errors.New("message body unavailable")
}

func (s *mailStore) deleteMessage(address, folder string, uid uint32) error {
	_, err := s.updateMessages(messageAction{Account: address, Folder: folder, UIDs: []uint32{uid}, Action: "trash"})
	return err
}
