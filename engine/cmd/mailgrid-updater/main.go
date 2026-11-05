//go:build darwin

// mailgrid-updater performs only verified Mail Grid application replacement.
// It runs outside the app bundle so replacement cannot invalidate its executable.
package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
)

var trustBase64 string // Public trust document only, injected by the build.
const appID = "dev.mailgrid.app"

type envelope struct {
	KeyID     string `json:"keyId"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}
type artifact struct {
	Name   string   `json:"name"`
	Size   int64    `json:"size"`
	SHA256 string   `json:"sha256"`
	SHA512 string   `json:"sha512"`
	Roles  []string `json:"roles"`
}
type target struct {
	Platform string     `json:"platform"`
	Arch     string     `json:"arch"`
	Package  string     `json:"packageType"`
	Files    []artifact `json:"files"`
}
type release struct {
	Schema  int      `json:"schema"`
	Version string   `json:"version"`
	Targets []target `json:"targets"`
}
type plan struct {
	App      string   `json:"app"`
	Artifact string   `json:"artifact"`
	Token    string   `json:"token"`
	Parent   int      `json:"parent"`
	Profile  string   `json:"profile,omitempty"`
	TestMode bool     `json:"testMode,omitempty"`
	Envelope envelope `json:"envelope"`
	Phase    string   `json:"phase"`
	Runner   int      `json:"runner,omitempty"`
	Boot     string   `json:"boot,omitempty"`
	Error    string   `json:"error,omitempty"`
}
type health struct {
	Token   string `json:"token"`
	Version string `json:"version"`
	PID     int    `json:"pid"`
}

var tokenPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

func command(name string, args ...string) error {
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %w: %s", filepath.Base(name), err, strings.TrimSpace(string(out)))
	}
	return nil
}
func quote(value string) string { return "'" + strings.ReplaceAll(value, "'", "'\\''") + "'" }
func writePlan(file string, p plan) error {
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	temp := file + ".tmp"
	if err = os.WriteFile(temp, data, 0600); err != nil {
		return err
	}
	if os.Geteuid() == 0 {
		if st, e := os.Stat(filepath.Dir(file)); e == nil {
			s := st.Sys().(*syscall.Stat_t)
			_ = os.Chown(temp, int(s.Uid), int(s.Gid))
		}
	}
	return os.Rename(temp, file)
}
func load(file string) (plan, error) {
	var p plan
	b, err := os.ReadFile(file)
	if err != nil {
		return p, err
	}
	if len(b) > 1048576 {
		return p, errors.New("update plan too large")
	}
	if err = json.Unmarshal(b, &p); err != nil {
		return p, err
	}
	work := filepath.Dir(file)
	exe, err := os.Executable()
	if err != nil {
		return p, err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	if filepath.Dir(exe) != work || filepath.Base(file) != "plan.json" || !filepath.IsAbs(file) || !tokenPattern.MatchString(p.Token) || p.Parent < 2 || filepath.Base(p.App) != "Mail Grid.app" || !filepath.IsAbs(p.App) || strings.HasPrefix(p.App, "/Volumes/") || filepath.Dir(p.Artifact) != work {
		return p, errors.New("invalid installation location or plan")
	}
	if p.Profile != "" && filepath.Join(p.Profile, "updates") != filepath.Dir(work) {
		return p, errors.New("update profile does not match its private work directory")
	}
	if p.TestMode && p.Profile == "" {
		return p, errors.New("isolated update tests require a profile")
	}
	for _, name := range []string{file, p.Artifact, p.App, work} {
		st, e := os.Lstat(name)
		if e != nil {
			return p, e
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return p, errors.New("symlink in installation plan")
		}
	}
	resolved, err := filepath.EvalSymlinks(p.App)
	if err != nil || resolved != p.App {
		return p, errors.New("installation path is not canonical")
	}
	return p, nil
}
func verify(p plan) (release, error) {
	var r release
	var trust struct {
		PublicKeys []string `json:"publicKeys"`
	}
	raw, err := base64.StdEncoding.DecodeString(trustBase64)
	if err != nil {
		return r, err
	}
	if err = json.Unmarshal(raw, &trust); err != nil {
		return r, err
	}
	body, err := base64.StdEncoding.DecodeString(p.Envelope.Payload)
	if err != nil {
		return r, err
	}
	sig, err := base64.StdEncoding.DecodeString(p.Envelope.Signature)
	if err != nil {
		return r, err
	}
	valid := false
	for _, text := range trust.PublicKeys {
		block, _ := pem.Decode([]byte(text))
		if block == nil {
			continue
		}
		key, e := x509.ParsePKIXPublicKey(block.Bytes)
		if e != nil {
			continue
		}
		public, ok := key.(ed25519.PublicKey)
		if !ok {
			continue
		}
		sum := sha256.Sum256(block.Bytes)
		if hex.EncodeToString(sum[:]) == p.Envelope.KeyID && ed25519.Verify(public, body, sig) {
			valid = true
			break
		}
	}
	if !valid {
		return r, errors.New("release signature is not trusted")
	}
	if err = json.Unmarshal(body, &r); err != nil {
		return r, err
	}
	if r.Schema != 2 {
		return r, errors.New("Mac self-updates require release schema 2")
	}
	var file *artifact
	for _, t := range r.Targets {
		if t.Platform == "darwin" && t.Arch == "universal" && t.Package == "mac" {
			for _, f := range t.Files {
				if f.Name == filepath.Base(p.Artifact) && strings.HasSuffix(f.Name, ".dmg") {
					for _, role := range f.Roles {
						if role == "update" {
							copy := f
							file = &copy
						}
					}
				}
			}
		}
	}
	if file == nil {
		return r, errors.New("no universal Mac DMG in this release")
	}
	stream, err := os.Open(p.Artifact)
	if err != nil {
		return r, err
	}
	defer stream.Close()
	h256, h512 := sha256.New(), sha512.New()
	count, err := io.Copy(io.MultiWriter(h256, h512), stream)
	if err != nil {
		return r, err
	}
	if count != file.Size || hex.EncodeToString(h256.Sum(nil)) != file.SHA256 || base64.StdEncoding.EncodeToString(h512.Sum(nil)) != file.SHA512 {
		return r, errors.New("download checksum mismatch")
	}
	return r, nil
}
func bundleInfo(app string) (map[string]any, error) {
	out, err := exec.Command("/usr/bin/plutil", "-convert", "json", "-o", "-", filepath.Join(app, "Contents/Info.plist")).Output()
	if err != nil {
		return nil, err
	}
	var info map[string]any
	err = json.Unmarshal(out, &info)
	return info, err
}
func validateApp(app, version string) error {
	info, err := bundleInfo(app)
	if err != nil {
		return err
	}
	if info["CFBundleIdentifier"] != appID || info["CFBundleShortVersionString"] != version || info["CFBundleExecutable"] != "Mail Grid" {
		return errors.New("application identity or version mismatch")
	}
	for _, binary := range []string{"Contents/MacOS/Mail Grid", "Contents/Resources/mailgrid-engine", "Contents/Resources/mailgrid-updater"} {
		out, e := exec.Command("/usr/bin/lipo", "-archs", filepath.Join(app, binary)).Output()
		if e != nil || !strings.Contains(string(out), "x86_64") || !strings.Contains(string(out), "arm64") {
			return errors.New("update does not contain universal executable: " + binary)
		}
	}
	return command("/usr/bin/codesign", "--verify", "--deep", "--strict", app)
}
func mount(p plan) (string, func(), error) {
	dir, err := os.MkdirTemp(filepath.Dir(p.Artifact), "mount-")
	if err != nil {
		return "", func() {}, err
	}
	cleanup := func() { _ = command("/usr/bin/hdiutil", "detach", dir); _ = os.Remove(dir) }
	if err = command("/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", dir, p.Artifact); err != nil {
		_ = os.Remove(dir)
		return "", func() {}, err
	}
	return filepath.Join(dir, "Mail Grid.app"), cleanup, nil
}
func sizeOf(root string) (int64, error) {
	var size int64
	err := filepath.Walk(root, func(_ string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			size += info.Size()
		}
		return nil
	})
	return size, err
}
func check(p plan) (release, error) {
	r, err := verify(p)
	if err != nil {
		return r, err
	}
	info, err := bundleInfo(p.App)
	if err != nil || info["CFBundleIdentifier"] != appID {
		return r, errors.New("the installed application is not Mail Grid")
	}
	source, detach, err := mount(p)
	if err != nil {
		return r, err
	}
	defer detach()
	if err = validateApp(source, r.Version); err != nil {
		return r, err
	}
	size, err := sizeOf(source)
	if err != nil {
		return r, err
	}
	var st syscall.Statfs_t
	if err = syscall.Statfs(filepath.Dir(p.App), &st); err != nil {
		return r, err
	}
	if uint64(st.Bavail)*uint64(st.Bsize) < uint64(size)+128*1024*1024 {
		return r, errors.New("not enough free space to stage the update")
	}
	return r, nil
}
func backupPath(p plan) string {
	return filepath.Join(filepath.Dir(p.App), ".MailGrid-backup-"+p.Token)
}
func stagePath(p plan) string { return filepath.Join(filepath.Dir(p.App), ".MailGrid-stage-"+p.Token) }
func healthy(file string, p plan, version string) bool {
	raw, err := os.ReadFile(filepath.Join(filepath.Dir(file), "health.json"))
	if err != nil {
		return false
	}
	var h health
	if json.Unmarshal(raw, &h) != nil || h.Token != p.Token || h.Version != version || h.PID < 2 {
		return false
	}
	return syscall.Kill(h.PID, 0) == nil
}
func apply(file string, p plan) error {
	r, err := verify(p)
	if err != nil {
		return err
	}
	if syscall.Kill(p.Parent, 0) == nil {
		return errors.New("Mail Grid has not stopped")
	}
	source, detach, err := mount(p)
	if err != nil {
		return err
	}
	defer detach()
	if err = validateApp(source, r.Version); err != nil {
		return err
	}
	stage, backup := stagePath(p), backupPath(p)
	if _, e := os.Lstat(backup); !errors.Is(e, os.ErrNotExist) {
		return errors.New("previous update backup already exists; recovery is required")
	}
	if err = command("/usr/bin/ditto", "--rsrc", "--extattr", source, stage); err != nil {
		_ = os.RemoveAll(stage)
		return err
	}
	if err = validateApp(stage, r.Version); err != nil {
		_ = os.RemoveAll(stage)
		return err
	}
	p.Phase = "exchanging"
	if err = writePlan(file, p); err != nil {
		_ = os.RemoveAll(stage)
		return err
	}
	if err = atomicSwap(p.App, stage); err != nil {
		_ = os.RemoveAll(stage)
		return err
	}
	if err = os.Rename(stage, backup); err != nil {
		_ = atomicSwap(p.App, stage)
		_ = os.RemoveAll(stage)
		return err
	}
	p.Phase = "installed"
	if err = writePlan(file, p); err != nil {
		_ = atomicSwap(p.App, backup)
		return err
	}
	deadline := time.Now().Add(75 * time.Second)
	for time.Now().Before(deadline) {
		if healthy(file, p, r.Version) {
			p.Phase = "committed"
			if err = writePlan(file, p); err != nil {
				return err
			}
			_ = os.RemoveAll(backup)
			return nil
		}
		time.Sleep(300 * time.Millisecond)
	}
	stopUpdatedApp(p)
	if err = atomicSwap(p.App, backup); err != nil {
		return err
	}
	_ = os.RemoveAll(backup)
	p.Phase = "rolled-back"
	p.Error = "The new application did not confirm a successful startup. The previous application was restored."
	_ = writePlan(file, p)
	return errors.New(p.Error)
}
func stopUpdatedApp(p plan) {
	out, err := exec.Command("/bin/ps", "-axo", "pid=,command=").Output()
	if err != nil {
		return
	}
	exe := filepath.Join(p.App, "Contents/MacOS/Mail Grid")
	var stopped []int
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		cut := strings.IndexAny(line, " \t")
		if cut < 0 {
			continue
		}
		pid, e := strconv.Atoi(line[:cut])
		cmd := strings.TrimSpace(line[cut:])
		if e == nil && pid > 1 && strings.HasPrefix(cmd, exe+" ") && strings.Contains(cmd, "--mailgrid-update-token "+p.Token) {
			_ = syscall.Kill(pid, syscall.SIGTERM)
			stopped = append(stopped, pid)
		}
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		alive := false
		for _, pid := range stopped {
			if syscall.Kill(pid, 0) == nil {
				alive = true
			}
		}
		if !alive {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	// These are only the exact executable/token pairs identified above.
	for _, pid := range stopped {
		if syscall.Kill(pid, 0) == nil {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}
}
func launch(p plan, file string, updated bool) error {
	var argv []string
	if updated {
		argv = append(argv, "--mailgrid-update-token", p.Token, "--mailgrid-update-work", filepath.Dir(file))
	}
	if p.TestMode {
		argv = append(argv, "--test-mode")
		child := exec.Command(filepath.Join(p.App, "Contents/MacOS/Mail Grid"), argv...)
		child.Env = append(os.Environ(), "MAILGRID_DATA_DIR="+p.Profile)
		child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := child.Start(); err != nil {
			return err
		}
		return child.Process.Release()
	}
	args := []string{"-n"}
	if p.Profile != "" {
		args = append(args, "--env", "MAILGRID_DATA_DIR="+p.Profile)
	}
	args = append(args, p.App)
	if len(argv) > 0 {
		args = append(args, "--args")
		args = append(args, argv...)
	}
	return command("/usr/bin/open", args...)
}
func orchestrate(file string, p plan) error {
	p.Runner = os.Getpid()
	p.Boot = boot()
	if err := writePlan(file, p); err != nil {
		return err
	}
	if _, err := check(p); err != nil {
		return err
	}
	deadline := time.Now().Add(30 * time.Second)
	for syscall.Kill(p.Parent, 0) == nil {
		if time.Now().After(deadline) {
			return errors.New("Mail Grid is still running; no files were replaced")
		}
		time.Sleep(200 * time.Millisecond)
	}
	exe, _ := os.Executable()
	authorized := false
	for {
		var child *exec.Cmd
		if authorized {
			shell := quote(exe) + " --apply " + quote(file)
			script := "do shell script " + strconv.Quote(shell) + " with administrator privileges"
			child = exec.Command("/usr/bin/osascript", "-e", script)
		} else {
			child = exec.Command(exe, "--apply", file)
		}
		output, err := os.OpenFile(filepath.Join(filepath.Dir(file), "helper.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		child.Stdout = output
		child.Stderr = output
		if err = child.Start(); err != nil {
			output.Close()
			return err
		}
		done := make(chan error, 1)
		go func() { done <- child.Wait() }()
		launched := false
		for {
			select {
			case err = <-done:
				output.Close()
				latest, _ := load(file)
				if err == nil && latest.Phase == "committed" {
					return nil
				}
				if !authorized && latest.Phase == "authorization-required" {
					authorized = true
					goto authorize
				}
				if latest.Phase == "exchanging" || latest.Phase == "backup" || latest.Phase == "installed" {
					return errors.New("Update interrupted. The previous application remains at " + backupPath(p) + ". Reopen Mail Grid after restoring that backup.")
				}
				_ = launch(p, file, false)
				if err != nil {
					return err
				}
				return errors.New(latest.Error)
			default:
				latest, e := load(file)
				if e == nil && latest.Phase == "installed" && !launched {
					if e = launch(p, file, true); e != nil {
						// Keep the apply process alive so its health timeout restores the backup.
						fmt.Fprintln(output, "The new app could not launch:", e)
					}
					launched = true
				}
				time.Sleep(200 * time.Millisecond)
			}
		}
	authorize:
	}
}

// Darwin renameatx_np(RENAME_SWAP), available since macOS 10.12. Both
// directory entries always exist, including across power loss between journals.
func atomicSwap(left, right string) error {
	a, err := syscall.BytePtrFromString(left)
	if err != nil {
		return err
	}
	b, err := syscall.BytePtrFromString(right)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(488, ^uintptr(1), uintptr(unsafe.Pointer(a)), ^uintptr(1), uintptr(unsafe.Pointer(b)), 2, 0)
	runtime.KeepAlive(a)
	runtime.KeepAlive(b)
	if errno != 0 {
		return errno
	}
	return nil
}
func boot() string {
	out, _ := exec.Command("/usr/sbin/sysctl", "-n", "kern.boottime").Output()
	return strings.TrimSpace(string(out))
}
func recoverInterrupted(file string, p plan) error {
	if p.Runner > 1 && p.Boot == boot() && syscall.Kill(p.Runner, 0) == nil {
		return nil
	}
	r, err := verify(p)
	if err != nil {
		return err
	}
	info, err := bundleInfo(p.App)
	if err != nil {
		return err
	}
	if info["CFBundleShortVersionString"] == r.Version && healthy(file, p, r.Version) {
		p.Phase = "committed"
		if err = writePlan(file, p); err != nil {
			return err
		}
		_ = os.RemoveAll(backupPath(p))
		_ = os.RemoveAll(stagePath(p))
		_ = os.RemoveAll(filepath.Dir(file))
		return nil
	}
	if p.Phase == "exchanging" { // Swap did not happen, or an interrupted rollback restored the old app.
		staged, e := bundleInfo(stagePath(p))
		if e == nil && staged["CFBundleShortVersionString"] == r.Version && info["CFBundleShortVersionString"] != r.Version {
			_ = os.RemoveAll(stagePath(p))
			p.Phase = "rolled-back"
			p.Error = "The interrupted update left the previous app in place."
			return writePlan(file, p)
		}
	}
	return errors.New("An interrupted update needs recovery. Keep the previous application backup at " + backupPath(p))
}
func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "Use --check, --run or --apply with a private update plan.")
		os.Exit(2)
	}
	mode, file := os.Args[1], os.Args[2]
	p, err := load(file)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	switch mode {
	case "--recover":
		err = recoverInterrupted(file, p)
	case "--check":
		_, err = check(p)
	case "--apply":
		err = apply(file, p)
	case "--run":
		err = orchestrate(file, p)
	default:
		err = errors.New("unknown update operation")
	}
	if err != nil {
		latest, _ := load(file)
		p = latest
		if mode == "--apply" && (errors.Is(err, os.ErrPermission) || strings.Contains(err.Error(), "Permission denied") || strings.Contains(err.Error(), "Operation not permitted")) {
			p.Phase = "authorization-required"
		} else if p.Phase != "rolled-back" && p.Phase != "backup" && p.Phase != "exchanging" && p.Phase != "installed" {
			p.Phase = "error"
		}
		p.Error = err.Error()
		_ = writePlan(file, p)
		fmt.Fprintln(os.Stderr, err)
		if mode == "--run" && !p.TestMode {
			_ = command("/usr/bin/osascript", "-e", "display alert \"Mail Grid update could not finish\" message "+strconv.Quote(p.Error))
		}
		os.Exit(1)
	}
	if mode == "--run" {
		_ = os.RemoveAll(filepath.Dir(file))
	}
}
