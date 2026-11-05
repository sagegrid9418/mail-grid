package main

import (
	"fmt"
	"testing"

	"github.com/emersion/go-imap"
)

func TestBulkActionsAndTrashPersistence(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.close() }()
	address := "bulk@mailgrid.test"
	if _, err := s.createAccount(address, "green"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 503; i++ {
		subject := "Match"
		if i == 502 {
			subject = "Other"
		}
		raw := fmt.Sprintf("From: app@example.test\r\nTo: %s\r\nSubject: %s %d\r\n\r\nbody\r\n", address, subject, i)
		if err := s.deliver([]byte(raw), []string{address, "unknown@example.test"}, ""); err != nil {
			t.Fatal(err)
		}
	}
	selected := messageAction{Account: address, Folder: "INBOX", All: true, Query: "Match", Action: "read"}
	if n, err := s.updateMessages(selected); err != nil || n != 502 {
		t.Fatalf("all matches beyond UI limit: %d %v", n, err)
	}
	items, err := s.listMessages(address, "INBOX", "Match", 500)
	if err != nil || len(items) != 500 {
		t.Fatalf("listed: %d %v", len(items), err)
	}
	for _, item := range items {
		if item.Unread {
			t.Fatal("bulk mark read failed")
		}
	}
	selected.Action = "trash"
	if n, err := s.updateMessages(selected); err != nil || n != 502 {
		t.Fatalf("bulk trash: %d %v", n, err)
	}
	_, uids, err := s.allUIDs(address, "Trash")
	if err != nil || len(uids) != 502 {
		t.Fatalf("trash size: %d %v", len(uids), err)
	}
	if items, err := s.listMessages(address, "INBOX", "", 100); err != nil || len(items) != 1 {
		t.Fatal("unmatched mail affected", err)
	}
	if items, err := s.listMessages("catchall", "INBOX", "", 500); err != nil || len(items) != 500 {
		t.Fatal("other account affected", err)
	}
	s.close()
	s, err = openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	_, uids, err = s.allUIDs(address, "Trash")
	if err != nil || len(uids) != 502 {
		t.Fatal("Trash lost after restart", err)
	}
	if n, err := s.updateMessages(messageAction{Account: address, Folder: "Trash", UIDs: uids[:2], Action: "unread"}); err != nil || n != 2 {
		t.Fatalf("unread: %d %v", n, err)
	}
	if n, err := s.updateMessages(messageAction{Account: address, Folder: "Trash", UIDs: uids[:1], Action: "restore"}); err != nil || n != 1 {
		t.Fatalf("restore: %d %v", n, err)
	}
	// Permanently deleting one selected item must not expunge unrelated IMAP-deleted items.
	m, err := s.mailbox(address, "Trash")
	if err != nil {
		t.Fatal(err)
	}
	set := new(imap.SeqSet)
	set.AddNum(uids[2])
	if err := m.UpdateMessagesFlags(true, set, imap.AddFlags, []string{imap.DeletedFlag}); err != nil {
		t.Fatal(err)
	}
	if n, err := s.updateMessages(messageAction{Account: address, Folder: "Trash", UIDs: uids[1:2], Action: "delete"}); err != nil || n != 1 {
		t.Fatalf("delete: %d %v", n, err)
	}
	if _, err := s.rawMessage(address, "Trash", uids[2]); err != nil {
		t.Fatal("unselected message was expunged", err)
	}
	if _, err := s.updateMessages(messageAction{Account: address, Folder: "INBOX", UIDs: []uint32{0}, Action: "trash"}); err == nil {
		t.Fatal("zero UID accepted")
	}
	if _, err := s.updateMessages(messageAction{Account: address, Folder: "INBOX", All: true, Action: "delete"}); err == nil {
		t.Fatal("permanent deletion outside Trash accepted")
	}
	// POP3/single delete uses the same Trash semantics for catch-all as the desktop.
	catch, err := s.listMessages("catchall", "INBOX", "", 1)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.deleteMessage("catchall", "INBOX", catch[0].UID); err != nil {
		t.Fatal(err)
	}
	if items, err := s.listMessages("catchall", "Trash", "", 100); err != nil || len(items) != 1 {
		t.Fatal("catch-all Trash missing", err)
	}
}
