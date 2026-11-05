package main

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"net"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap"
)

type popEntry struct {
	UID     uint32
	Size    int
	Deleted bool
}

func servePOP3(listener net.Listener, store *mailStore) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if !strings.Contains(err.Error(), "closed") {
				fmt.Fprintln(os.Stderr, "POP3 listener:", err)
			}
			return
		}
		go handlePOP3(conn, store)
	}
}

func handlePOP3(conn net.Conn, store *mailStore) {
	defer conn.Close()
	reader := bufio.NewReaderSize(conn, 4096)
	writer := bufio.NewWriter(conn)
	write := func(line string) { _, _ = writer.WriteString(line + "\r\n"); _ = writer.Flush() }
	write("+OK Mail Grid local POP3 ready")
	var user string
	var authed bool
	entries := []popEntry{}
	for {
		_ = conn.SetDeadline(time.Now().Add(10 * time.Minute))
		lineBytes, err := reader.ReadSlice('\n')
		if err != nil {
			if err == bufio.ErrBufferFull {
				write("-ERR command too long")
			}
			return
		}
		line := string(lineBytes)
		if len(line) > 4096 {
			write("-ERR command too long")
			return
		}
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) == 0 {
			write("-ERR empty command")
			continue
		}
		command := strings.ToUpper(fields[0])
		arg := ""
		if len(fields) > 1 {
			arg = fields[1]
		}
		switch command {
		case "CAPA":
			write("+OK Capabilities follow")
			write("USER")
			write("UIDL")
			write("TOP")
			write("RESP-CODES")
			write("IMPLEMENTATION MailGrid")
			write(".")
		case "USER":
			if authed {
				write("-ERR already authenticated")
				continue
			}
			user = strings.ToLower(arg)
			if !store.accountExists(user) {
				user = ""
				write("-ERR unknown account")
			} else {
				write("+OK password required")
			}
		case "PASS":
			if authed {
				write("-ERR already authenticated")
				continue
			}
			_, password, hasPassword := strings.Cut(strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r"), " ")
			if user == "" || !hasPassword {
				write("-ERR send USER first")
				continue
			}
			if !store.authenticate(user, password) {
				write("-ERR invalid password")
				continue
			}
			candidate, _ := store.popLocks.LoadOrStore(user, &sync.Mutex{})
			lock := candidate.(*sync.Mutex)
			if !lock.TryLock() {
				write("-ERR mailbox is already in use")
				continue
			}
			m, uids, err := store.allUIDs(user, "INBOX")
			if err != nil {
				lock.Unlock()
				write("-ERR mailbox unavailable")
				continue
			}
			msgs, err := fetchMessages(m, uids, []imap.FetchItem{imap.FetchUid, imap.FetchRFC822Size})
			if err != nil {
				lock.Unlock()
				write("-ERR mailbox unavailable")
				continue
			}
			sort.Slice(msgs, func(i, j int) bool { return msgs[i].Uid < msgs[j].Uid })
			entries = nil
			for _, msg := range msgs {
				entries = append(entries, popEntry{UID: msg.Uid, Size: int(msg.Size)})
			}
			authed = true
			defer lock.Unlock()
			write(fmt.Sprintf("+OK %d messages", len(entries)))
		case "QUIT":
			if authed {
				for _, item := range entries {
					if item.Deleted {
						if err := store.deleteMessage(user, "INBOX", item.UID); err != nil {
							fmt.Fprintln(os.Stderr, "POP3 delete:", err)
						}
					}
				}
			}
			write("+OK goodbye")
			return
		default:
			if !authed {
				write("-ERR authenticate first")
				continue
			}
			switch command {
			case "NOOP":
				write("+OK")
			case "RSET":
				for i := range entries {
					entries[i].Deleted = false
				}
				write("+OK")
			case "STAT":
				count, size := 0, 0
				for _, e := range entries {
					if !e.Deleted {
						count++
						size += e.Size
					}
				}
				write(fmt.Sprintf("+OK %d %d", count, size))
			case "LIST", "UIDL":
				if arg != "" {
					i, e, ok := popLookup(entries, arg)
					if !ok {
						write("-ERR no such message")
						continue
					}
					if command == "LIST" {
						write(fmt.Sprintf("+OK %d %d", i, e.Size))
					} else {
						write(fmt.Sprintf("+OK %d %s", i, popUID(user, e.UID)))
					}
					continue
				}
				write("+OK message list follows")
				for i, e := range entries {
					if e.Deleted {
						continue
					}
					if command == "LIST" {
						write(fmt.Sprintf("%d %d", i+1, e.Size))
					} else {
						write(fmt.Sprintf("%d %s", i+1, popUID(user, e.UID)))
					}
				}
				write(".")
			case "DELE":
				i, _, ok := popLookup(entries, arg)
				if !ok {
					write("-ERR no such message")
					continue
				}
				entries[i-1].Deleted = true
				write("+OK marked for deletion")
			case "RETR", "TOP":
				_, e, ok := popLookup(entries, arg)
				if !ok {
					write("-ERR no such message")
					continue
				}
				raw, err := store.rawMessage(user, "INBOX", e.UID)
				if err != nil {
					write("-ERR message unavailable")
					continue
				}
				if command == "TOP" {
					if len(fields) < 3 {
						write("-ERR missing line count")
						continue
					}
					n, err := strconv.Atoi(fields[2])
					if err != nil || n < 0 {
						write("-ERR invalid line count")
						continue
					}
					raw = topLines(raw, n)
				}
				write(fmt.Sprintf("+OK %d octets", len(raw)))
				writeDotStuffed(writer, raw)
			default:
				write("-ERR unsupported command")
			}
		}
	}
}

func popLookup(entries []popEntry, arg string) (int, popEntry, bool) {
	i, err := strconv.Atoi(arg)
	if err != nil || i < 1 || i > len(entries) || entries[i-1].Deleted {
		return 0, popEntry{}, false
	}
	return i, entries[i-1], true
}
func popUID(user string, uid uint32) string { return fmt.Sprintf("%x-%d", []byte(user), uid) }

func topLines(raw []byte, n int) []byte {
	raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	parts := bytes.SplitN(raw, []byte("\n\n"), 2)
	if len(parts) < 2 {
		return raw
	}
	lines := bytes.Split(parts[1], []byte("\n"))
	if n < len(lines) {
		lines = lines[:n]
	}
	return append(append([]byte{}, parts[0]...), append([]byte("\n\n"), bytes.Join(lines, []byte("\n"))...)...)
}

func writeDotStuffed(w *bufio.Writer, raw []byte) {
	raw = bytes.ReplaceAll(raw, []byte("\r\n"), []byte("\n"))
	raw = bytes.TrimSuffix(raw, []byte("\n"))
	for _, line := range bytes.Split(raw, []byte("\n")) {
		if len(line) > 0 && line[0] == '.' {
			_, _ = w.Write([]byte{'.'})
		}
		_, _ = w.Write(line)
		_, _ = io.WriteString(w, "\r\n")
	}
	_, _ = io.WriteString(w, ".\r\n")
	_ = w.Flush()
}
