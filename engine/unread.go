package main

import (
	"strings"

	"github.com/emersion/go-imap"
)

type unreadAccount struct {
	Total   int            `json:"total"`
	Folders map[string]int `json:"folders"`
}
type unreadSnapshot struct {
	Total    int                      `json:"total"`
	Accounts map[string]unreadAccount `json:"accounts"`
}

// Count from mailbox flags, independently of the message-list display limit.
func (s *mailStore) unreadCounts() (unreadSnapshot, error) {
	result := unreadSnapshot{Accounts: map[string]unreadAccount{}}
	accounts, err := s.listAccounts()
	if err != nil {
		return result, err
	}
	addresses := []string{"catchall"}
	for _, account := range accounts {
		addresses = append(addresses, account.Address)
	}
	for _, address := range addresses {
		userAddress := address
		if address == "catchall" {
			userAddress = catchAll
		}
		user, err := s.mail.GetUser(userAddress)
		if err != nil {
			return result, err
		}
		folders, err := user.ListMailboxes(false)
		if err != nil {
			return result, err
		}
		counts := unreadAccount{Folders: map[string]int{}}
		for _, folder := range folders {
			name := folder.Name()
			if strings.EqualFold(name, "Sent") || strings.EqualFold(name, "Trash") {
				continue
			}
			// The pinned backend combines multiple negative flags incorrectly.
			// Use single-flag searches, then exclude deleted UIDs explicitly.
			uids, err := folder.SearchMessages(true, &imap.SearchCriteria{WithoutFlags: []string{imap.SeenFlag}})
			if err != nil {
				return result, err
			}
			deleted, err := folder.SearchMessages(true, &imap.SearchCriteria{WithFlags: []string{imap.DeletedFlag}})
			if err != nil {
				return result, err
			}
			excluded := make(map[uint32]bool, len(deleted))
			for _, uid := range deleted {
				excluded[uid] = true
			}
			count := 0
			for _, uid := range uids {
				if !excluded[uid] {
					count++
				}
			}
			counts.Folders[name] = count
			counts.Total += count
		}
		result.Accounts[address] = counts
		result.Total += counts.Total
	}
	return result, nil
}
