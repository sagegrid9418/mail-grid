package main

import (
	"fmt"
	"github.com/emersion/go-imap"
	"testing"
)

func TestUnreadCountsAcrossMailboxesAndRestart(t *testing.T) {
	dir := t.TempDir()
	s, err := openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { s.close() }()
	alice, bob := "alice@mailgrid.test", "bob@mailgrid.test"
	for _, address := range []string{alice, bob} {
		if _, err := s.createAccount(address, "a"); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 503; i++ {
		raw := []byte(fmt.Sprintf("From: bob@mailgrid.test\r\nTo: alice@mailgrid.test\r\nSubject: Unread %d\r\n\r\nbody\r\n", i))
		if err := s.deliver(raw, []string{alice, "unknown@example.test"}, bob); err != nil {
			t.Fatal(err)
		}
	}
	check := func(total, aliceCount, inbox, archive int) {
		t.Helper()
		counts, err := s.unreadCounts()
		if err != nil {
			t.Fatal(err)
		}
		if counts.Total != total || counts.Accounts[alice].Total != aliceCount || counts.Accounts[alice].Folders["INBOX"] != inbox || counts.Accounts[alice].Folders["Archive"] != archive || counts.Accounts[bob].Total != 0 || counts.Accounts["catchall"].Total != 503 {
			t.Fatalf("incorrect counts: %+v", counts)
		}
	}
	check(1006, 503, 503, 0)
	m, uids, err := s.allUIDs(alice, "INBOX")
	if err != nil {
		t.Fatal(err)
	}
	flag := func(uid uint32, value string) {
		t.Helper()
		set := new(imap.SeqSet)
		set.AddNum(uid)
		if err := m.UpdateMessagesFlags(true, set, imap.AddFlags, []string{value}); err != nil {
			t.Fatal(err)
		}
	}
	flag(uids[0], imap.SeenFlag)
	flag(uids[1], imap.DeletedFlag)
	check(1004, 501, 501, 0)
	if _, err := s.updateMessages(messageAction{Account: alice, Folder: "INBOX", UIDs: uids[2:3], Action: "trash"}); err != nil {
		t.Fatal(err)
	}
	check(1003, 500, 500, 0)
	user, err := s.mail.GetUser(alice)
	if err != nil {
		t.Fatal(err)
	}
	if err := user.CreateMailbox("Archive"); err != nil {
		t.Fatal(err)
	}
	set := new(imap.SeqSet)
	set.AddNum(uids[3])
	if err := m.MoveMessages(true, set, "Archive"); err != nil {
		t.Fatal(err)
	}
	check(1003, 500, 499, 1)
	s.close()
	s, err = openStore(dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	check(1003, 500, 499, 1)
	if err := s.deleteAccount(alice); err != nil {
		t.Fatal(err)
	}
	counts, err := s.unreadCounts()
	if err != nil {
		t.Fatal(err)
	}
	if counts.Total != 503 {
		t.Fatalf("deleted account remained counted: %+v", counts)
	}
	if _, found := counts.Accounts[alice]; found {
		t.Fatal("deleted account remained in snapshot")
	}
}
