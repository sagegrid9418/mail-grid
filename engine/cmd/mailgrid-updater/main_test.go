//go:build darwin

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/sha512"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
)

func TestAtomicAppExchange(t *testing.T) {
	root := t.TempDir()
	left, right := filepath.Join(root, "Mail Grid.app"), filepath.Join(root, "stage")
	for p, value := range map[string]string{left: "old", right: "new"} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
		os.WriteFile(filepath.Join(p, "version"), []byte(value), 0600)
	}
	if err := atomicSwap(left, right); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(filepath.Join(left, "version"))
	b, _ := os.ReadFile(filepath.Join(right, "version"))
	if string(a) != "new" || string(b) != "old" {
		t.Fatal("exchange lost an application")
	}
	if err := atomicSwap(left, right); err != nil {
		t.Fatal(err)
	}
	a, _ = os.ReadFile(filepath.Join(left, "version"))
	if string(a) != "old" {
		t.Fatal("rollback failed")
	}
}
func TestVerifyFreeSignatureAndArtifact(t *testing.T) {
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(public)
	trust, _ := json.Marshal(map[string]any{"publicKeys": []string{string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))}})
	trustBase64 = base64.StdEncoding.EncodeToString(trust)
	data := []byte("Harmless test artifact")
	file := filepath.Join(t.TempDir(), "test.dmg")
	os.WriteFile(file, data, 0600)
	s256, s512 := sha256.Sum256(data), sha512.Sum512(data)
	r := release{Schema: 2, Version: "1.0.0", Targets: []target{{Platform: "darwin", Arch: "universal", Package: "mac", Files: []artifact{{Name: "test.dmg", Size: int64(len(data)), SHA256: hex.EncodeToString(s256[:]), SHA512: base64.StdEncoding.EncodeToString(s512[:]), Roles: []string{"installer", "update"}}}}}}
	body, _ := json.Marshal(r)
	id := sha256.Sum256(der)
	p := plan{Artifact: file, Envelope: envelope{KeyID: hex.EncodeToString(id[:]), Payload: base64.StdEncoding.EncodeToString(body), Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, body))}}
	if _, err := verify(p); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(file, []byte("changed"), 0600)
	if _, err := verify(p); err == nil {
		t.Fatal("accepted changed artifact")
	}
	os.WriteFile(file, data, 0600)
	p.Envelope.Signature = base64.StdEncoding.EncodeToString(make([]byte, 64))
	if _, err := verify(p); err == nil {
		t.Fatal("accepted forged signature")
	}
}
