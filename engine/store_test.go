package main

import (
	"bytes"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestLocalDeliveryAndSentPersistence(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"alice@mailgrid.test", "bob@mailgrid.test"} {
		if _, err := s.createAccount(name, "correct-horse-123"); err != nil {
			t.Fatal(err)
		}
	}
	if s.authenticate("alice@mailgrid.test", "wrong") || !s.authenticate("alice@mailgrid.test", "correct-horse-123") {
		t.Fatal("authentication failed")
	}
	if err := s.compose(composeRequest{From: "alice@mailgrid.test", To: []string{"alice@mailgrid.test", "bob@mailgrid.test", "unknown@localhost"}, Subject: "Local receipt", Text: "test body"}); err != nil {
		t.Fatal(err)
	}
	for _, target := range []struct{ account, folder string }{{"alice@mailgrid.test", "INBOX"}, {"alice@mailgrid.test", "Sent"}, {"bob@mailgrid.test", "INBOX"}, {"catchall", "INBOX"}} {
		items, err := s.listMessages(target.account, target.folder, "", 100)
		if err != nil || len(items) != 1 {
			t.Fatalf("%+v: %v %v", target, items, err)
		}
		raw, err := s.rawMessage(target.account, target.folder, items[0].UID)
		if err != nil || !bytes.Contains(raw, []byte("test body")) {
			t.Fatalf("raw message: %s %v", raw, err)
		}
	}
	// More than the upstream default update buffer must work without a listener.
	for i := 0; i < 30; i++ {
		if err := s.deliver([]byte("Subject: Batch\r\n\r\nbody\r\n"), []string{"bob@mailgrid.test"}, ""); err != nil {
			t.Fatal(err)
		}
	}
	s.close()
	s, err = openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	items, err := s.listMessages("alice@mailgrid.test", "Sent", "", 100)
	if err != nil || len(items) != 1 {
		t.Fatalf("restart lost Sent mail: %v %v", items, err)
	}
}

func TestSettingsValidation(t *testing.T) {
	v := defaults()
	v.Ports.SMTP = v.Ports.IMAP
	if validateSettings(v) == nil {
		t.Fatal("duplicate ports accepted")
	}
	v = defaults()
	v.RetentionDays = -1
	if validateSettings(v) == nil {
		t.Fatal("negative retention accepted")
	}
}

func TestShortAccountPassword(t *testing.T) {
	s, err := openStore(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if _, err := s.createAccount("short@mailgrid.test", "a"); err != nil {
		t.Fatal(err)
	}
	if !s.authenticate("short@mailgrid.test", "a") || s.authenticate("short@mailgrid.test", "b") {
		t.Fatal("short password authentication failed")
	}
}

func TestPasswordChangeAndLegacyAccounts(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.close() }()
	address := "admin@flux-cargo.test"
	if _, err := s.createAccount(address, "old"); err != nil {
		t.Fatal(err)
	}
	legacy, err := bcrypt.GenerateFromPassword([]byte("old"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.accounts.Exec(`UPDATE accounts SET password_hash=? WHERE address=?`, legacy, address); err != nil {
		t.Fatal(err)
	}
	if !s.authenticate(address, "old") {
		t.Fatal("legacy account rejected")
	}
	if err := s.compose(composeRequest{From: address, To: []string{address}, Subject: "Kept mail", Text: "body"}); err != nil {
		t.Fatal(err)
	}
	if pw, err := s.updatePassword(address, "green"); err != nil || pw != "green" {
		t.Fatalf("custom password: %q %v", pw, err)
	}
	if s.authenticate(address, "old") || !s.authenticate(address, "green") {
		t.Fatal("password change did not apply")
	}
	long := strings.Repeat("long password$# ", 10)
	if _, err := s.updatePassword(address, long); err != nil {
		t.Fatal(err)
	}
	s.close()
	s, err = openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !s.authenticate(address, long) || s.authenticate(address, "green") {
		t.Fatal("password change lost after restart")
	}
	items, err := s.listMessages(address, "INBOX", "", 100)
	if err != nil || len(items) != 1 {
		t.Fatalf("password change affected mail: %v %v", items, err)
	}
	generated, err := s.updatePassword(address, "")
	if err != nil || generated == "" || !s.authenticate(address, generated) {
		t.Fatal("generated password failed", err)
	}
	if _, err := s.updatePassword("missing@example.test", "green"); err == nil {
		t.Fatal("missing account password changed")
	}
}
