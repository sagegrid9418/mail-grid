package main

import (
	"errors"
	"strings"

	"github.com/emersion/go-imap"
)

type messageAction struct {
	Account string   `json:"account"`
	Folder  string   `json:"folder"`
	UIDs    []uint32 `json:"uids"`
	All     bool     `json:"all"`
	Query   string   `json:"query"`
	Action  string   `json:"action"`
}

func (s *mailStore) updateMessages(p messageAction) (int, error) {
	switch p.Action {
	case "read", "unread", "trash", "restore", "delete":
	default:
		return 0, errors.New("unknown message action")
	}
	if p.Folder == "" {
		p.Folder = "INBOX"
	}
	if (p.Action == "delete" || p.Action == "restore") && p.Folder != "Trash" {
		return 0, errors.New("only messages in Trash can be restored or permanently deleted")
	}
	if p.Action == "trash" && p.Folder == "Trash" {
		return 0, errors.New("message is already in Trash")
	}
	for _, uid := range p.UIDs {
		if uid == 0 {
			return 0, errors.New("invalid message identifier")
		}
	}
	m, existing, err := s.allUIDs(p.Account, p.Folder)
	if err != nil {
		return 0, err
	}
	chosen := map[uint32]bool{}
	if p.All {
		query := strings.ToLower(strings.TrimSpace(p.Query))
		if query == "" {
			for _, uid := range existing {
				chosen[uid] = true
			}
		} else {
			messages, err := fetchMessages(m, existing, []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope})
			if err != nil {
				return 0, err
			}
			for _, message := range messages {
				if message.Envelope != nil && strings.Contains(strings.ToLower(decodeHeader(message.Envelope.Subject)+" "+addresses(message.Envelope.From)+" "+addresses(message.Envelope.To)), query) {
					chosen[message.Uid] = true
				}
			}
		}
	} else {
		if len(p.UIDs) == 0 {
			return 0, errors.New("select at least one message")
		}
		requested := map[uint32]bool{}
		for _, uid := range p.UIDs {
			requested[uid] = true
		}
		for _, uid := range existing {
			if requested[uid] {
				chosen[uid] = true
			}
		}
	}
	if len(chosen) == 0 {
		return 0, nil
	}
	set := new(imap.SeqSet)
	for uid := range chosen {
		set.AddNum(uid)
	}
	switch p.Action {
	case "read":
		err = m.UpdateMessagesFlags(true, set, imap.AddFlags, []string{imap.SeenFlag})
	case "unread":
		err = m.UpdateMessagesFlags(true, set, imap.RemoveFlags, []string{imap.SeenFlag})
	case "trash", "restore":
		destination := "Trash"
		if p.Action == "restore" {
			destination = "INBOX"
		}
		if _, err = s.mailbox(p.Account, destination); err != nil {
			return 0, err
		}
		if err = m.UpdateMessagesFlags(true, set, imap.RemoveFlags, []string{imap.DeletedFlag}); err == nil {
			err = m.MoveMessages(true, set, destination)
		}
	case "delete":
		err = m.DelMessages(true, set)
	}
	if err != nil {
		return 0, err
	}
	if s.events != nil {
		s.events("mailbox_changed", map[string]any{"account": p.Account, "folder": p.Folder})
	}
	return len(chosen), nil
}
