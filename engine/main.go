package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap"
)

type ports struct {
	SMTP int `json:"smtp"`
	IMAP int `json:"imap"`
	POP3 int `json:"pop3"`
}
type settings struct {
	Ports                ports `json:"ports"`
	RetentionDays        int   `json:"retentionDays"`
	StartAtLogin         bool  `json:"startAtLogin"`
	NotificationsEnabled bool  `json:"notificationsEnabled"`
}

func defaults() settings {
	return settings{Ports: ports{SMTP: 1025, IMAP: 1143, POP3: 1110}, RetentionDays: 0, StartAtLogin: true, NotificationsEnabled: true}
}

func loadSettings(dir string) (settings, error) {
	v := defaults()
	b, err := os.ReadFile(filepath.Join(dir, "settings.json"))
	if errors.Is(err, os.ErrNotExist) {
		return v, nil
	}
	if err != nil {
		return v, err
	}
	if err := json.Unmarshal(b, &v); err != nil {
		return v, err
	}
	return v, validateSettings(v)
}
func validateSettings(v settings) error {
	for _, p := range []int{v.Ports.SMTP, v.Ports.IMAP, v.Ports.POP3} {
		if p < 1024 || p > 65535 {
			return errors.New("ports must be between 1024 and 65535")
		}
	}
	if v.Ports.SMTP == v.Ports.IMAP || v.Ports.SMTP == v.Ports.POP3 || v.Ports.IMAP == v.Ports.POP3 {
		return errors.New("ports must be different")
	}
	if v.RetentionDays < 0 || v.RetentionDays > 3650 {
		return errors.New("retention must be between 0 and 3650 days")
	}
	return nil
}
func saveSettings(dir string, v settings) error {
	if err := validateSettings(v); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(v, "", "  ")
	path := filepath.Join(dir, "settings.json")
	temp := path + ".tmp"
	if err := os.WriteFile(temp, b, 0600); err != nil {
		return err
	}
	return os.Rename(temp, path)
}

type request struct {
	ID     int             `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}
type response struct {
	ID     int    `json:"id,omitempty"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
	Event  string `json:"event,omitempty"`
	Data   any    `json:"data,omitempty"`
}
type rpcServer struct {
	store    *mailStore
	dir      string
	config   settings
	mu       sync.Mutex
	configMu sync.RWMutex
	out      *bufio.Writer
}

func (r *rpcServer) write(v response) {
	r.mu.Lock()
	defer r.mu.Unlock()
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	_, _ = r.out.Write(b)
	_ = r.out.WriteByte('\n')
	_ = r.out.Flush()
}
func (r *rpcServer) event(name string, data any) { r.write(response{Event: name, Data: data}) }
func (r *rpcServer) currentSettings() settings {
	r.configMu.RLock()
	defer r.configMu.RUnlock()
	return r.config
}
func (r *rpcServer) handle(req request) (any, error) {
	decode := func(v any) error { return json.Unmarshal(req.Params, v) }
	switch req.Method {
	case "status":
		return map[string]any{"running": true, "ports": r.currentSettings().Ports, "dataDir": r.dir}, nil
	case "accounts.list":
		return r.store.listAccounts()
	case "messages.unreadCounts":
		return r.store.unreadCounts()
	case "folders.list":
		var p struct {
			Account string `json:"account"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		if p.Account == "catchall" {
			p.Account = catchAll
		}
		if p.Account != catchAll && !r.store.accountExists(p.Account) {
			return nil, errors.New("account not found")
		}
		u, err := r.store.mail.GetUser(p.Account)
		if err != nil {
			return nil, err
		}
		folders, err := u.ListMailboxes(false)
		if err != nil {
			return nil, err
		}
		names := []string{}
		for _, folder := range folders {
			names = append(names, folder.Name())
		}
		return names, nil
	case "accounts.create":
		var p struct {
			Address  string `json:"address"`
			Password string `json:"password"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		return r.store.createAccount(p.Address, p.Password)
	case "accounts.updatePassword":
		var p struct {
			Address  string `json:"address"`
			Password string `json:"password"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		pw, err := r.store.updatePassword(p.Address, p.Password)
		return map[string]string{"address": strings.ToLower(p.Address), "password": pw}, err
	case "accounts.verifyPassword":
		var p struct {
			Address  string `json:"address"`
			Password string `json:"password"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		if !r.store.authenticate(p.Address, p.Password) {
			return nil, errors.New("password does not match this account")
		}
		return map[string]bool{"ok": true}, nil
	case "accounts.delete":
		var p struct {
			Address string `json:"address"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, r.store.deleteAccount(p.Address)
	case "accounts.resetPassword":
		var p struct {
			Address string `json:"address"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		pw, err := r.store.resetPassword(p.Address)
		return map[string]string{"password": pw}, err
	case "messages.list":
		var p struct {
			Account string `json:"account"`
			Folder  string `json:"folder"`
			Query   string `json:"query"`
			Limit   int    `json:"limit"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		return r.store.listMessages(p.Account, p.Folder, p.Query, p.Limit)
	case "messages.get":
		var p struct {
			Account string `json:"account"`
			Folder  string `json:"folder"`
			UID     uint32 `json:"uid"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		return r.store.messageDetail(p.Account, p.Folder, p.UID)
	case "messages.update":
		var p messageAction
		if err := decode(&p); err != nil {
			return nil, err
		}
		count, err := r.store.updateMessages(p)
		return map[string]int{"count": count}, err
	case "messages.delete":
		var p struct {
			Account string `json:"account"`
			Folder  string `json:"folder"`
			UID     uint32 `json:"uid"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, r.store.deleteMessage(p.Account, p.Folder, p.UID)
	case "messages.markRead":
		var p struct {
			Account string `json:"account"`
			Folder  string `json:"folder"`
			UID     uint32 `json:"uid"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		m, err := r.store.mailbox(p.Account, p.Folder)
		if err != nil {
			return nil, err
		}
		set := new(imap.SeqSet)
		set.AddNum(p.UID)
		return map[string]bool{"ok": true}, m.UpdateMessagesFlags(true, set, imap.AddFlags, []string{imap.SeenFlag})
	case "messages.attachment":
		var p struct {
			Account string `json:"account"`
			Folder  string `json:"folder"`
			UID     uint32 `json:"uid"`
			Index   int    `json:"index"`
		}
		if err := decode(&p); err != nil {
			return nil, err
		}
		return r.store.getAttachment(p.Account, p.Folder, p.UID, p.Index)
	case "compose.send":
		var p composeRequest
		if err := decode(&p); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, r.store.compose(p)
	case "settings.get":
		return r.currentSettings(), nil
	case "settings.update":
		var p settings
		if err := decode(&p); err != nil {
			return nil, err
		}
		if err := saveSettings(r.dir, p); err != nil {
			return nil, err
		}
		restart := p.Ports != r.currentSettings().Ports
		r.configMu.Lock()
		r.config = p
		r.configMu.Unlock()
		go r.store.prune(p.RetentionDays)
		return map[string]any{"settings": p, "restartRequired": restart}, nil
	default:
		return nil, errors.New("unknown method")
	}
}

func (s *mailStore) prune(days int) {
	if days == 0 {
		return
	}
	cutoff := time.Now().AddDate(0, 0, -days)
	accounts, err := s.listAccounts()
	if err != nil {
		return
	}
	addresses := []string{"catchall"}
	for _, a := range accounts {
		addresses = append(addresses, a.Address)
	}
	for _, address := range addresses {
		for _, folder := range []string{"INBOX", "Sent", "Trash"} {
			m, err := s.mailbox(address, folder)
			if err != nil {
				continue
			}
			uids, err := m.SearchMessages(true, &imap.SearchCriteria{Before: cutoff})
			if err != nil || len(uids) == 0 {
				continue
			}
			set := new(imap.SeqSet)
			set.AddNum(uids...)
			if err := m.UpdateMessagesFlags(true, set, imap.AddFlags, []string{imap.DeletedFlag}); err == nil {
				_ = m.Expunge()
			}
		}
	}
}

func main() {
	defaultDir, _ := os.UserConfigDir()
	dataDir := flag.String("data-dir", filepath.Join(defaultDir, "MailGrid"), "local data directory")
	flag.Parse()
	if err := os.MkdirAll(*dataDir, 0700); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	config, err := loadSettings(*dataDir)
	if err != nil {
		fmt.Fprintln(os.Stderr, "settings:", err)
		os.Exit(1)
	}
	r := &rpcServer{dir: *dataDir, config: config, out: bufio.NewWriter(os.Stdout)}
	store, err := openStore(*dataDir, r.event)
	if err != nil {
		fmt.Fprintln(os.Stderr, "storage:", err)
		os.Exit(1)
	}
	r.store = store
	defer store.close()
	listeners, err := startListeners(store, config.Ports)
	if err != nil {
		r.event("service_error", map[string]string{"message": err.Error()})
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer listeners.close()
	r.event("ready", map[string]any{"ports": config.Ports})
	go func() {
		store.prune(config.RetentionDays)
		ticker := time.NewTicker(time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			store.prune(r.currentSettings().RetentionDays)
		}
	}()
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), 64<<20)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		var req request
		if err := json.Unmarshal(line, &req); err != nil {
			r.write(response{Error: "invalid request"})
			continue
		}
		if req.Method == "shutdown" {
			r.write(response{ID: req.ID, Result: map[string]bool{"ok": true}})
			return
		}
		result, err := r.handle(req)
		resp := response{ID: req.ID, Result: result}
		if err != nil {
			resp.Result = nil
			resp.Error = err.Error()
		}
		r.write(resp)
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, "IPC:", err)
	}
}
