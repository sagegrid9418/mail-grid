package main

import (
	"mime"
	"strings"
	"testing"
)

func TestDecodedSubjectListingSearchAndBulk(t *testing.T) {
	s, err := openStore(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer s.close()
	if _, err = s.createAccount("alice@mailgrid.test", "a"); err != nil {
		t.Fatal(err)
	}
	subject := "Original subject — لا تترجم 日本語"
	raw := []byte("From: alice@example.test\r\nTo: alice@mailgrid.test\r\nSubject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<html><head><style>h1{color:purple}</style></head><body><h1>日本語</h1></body></html>\r\n")
	if err := s.deliver(raw, []string{"alice@mailgrid.test"}, ""); err != nil {
		t.Fatal(err)
	}
	messages, err := s.listMessages("alice@mailgrid.test", "INBOX", "日本語", 500)
	if err != nil || len(messages) != 1 {
		t.Fatalf("decoded subject search: %v %v", messages, err)
	}
	if messages[0].Subject != subject {
		t.Fatalf("subject was changed: %q", messages[0].Subject)
	}
	detail, err := s.messageDetail("alice@mailgrid.test", "INBOX", messages[0].UID)
	if err != nil || detail.Subject != subject || !strings.Contains(detail.HTML, "<style>h1{color:purple}</style>") || !strings.Contains(detail.HTML, "日本語") {
		t.Fatalf("original HTML/subject not preserved: %+v %v", detail, err)
	}
	if !strings.Contains(detail.Raw, "=?utf-8?") {
		t.Fatal("raw source must remain encoded and unchanged")
	}
	count, err := s.updateMessages(messageAction{Account: "alice@mailgrid.test", Folder: "INBOX", Query: "日本語", All: true, Action: "read"})
	if err != nil || count != 1 {
		t.Fatalf("bulk search disagrees with displayed search: %d %v", count, err)
	}
}
func TestNonUTF8HTMLAndHeaders(t *testing.T) {
	if got := decodeHeader("=?ISO-8859-1?Q?caf=E9?="); got != "café" {
		t.Fatal(got)
	}
	raw := []byte("Subject: =?ISO-8859-1?Q?caf=E9?=\r\nContent-Type: text/html; charset=iso-8859-1\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n<p>caf=E9</p>\r\n")
	d, err := parseDetail(1, raw, false)
	if err != nil || !strings.Contains(d.HTML, "café") {
		t.Fatalf("HTML charset not decoded: %+v %v", d, err)
	}
}
