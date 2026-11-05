"""End-to-end smoke test for the bundled local mail engine."""

import imaplib
import json
import os
import poplib
import smtplib
import socket
import subprocess
import tempfile
from email.message import EmailMessage
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "engine" / "bin" / ("mailgrid-engine.exe" if os.name == "nt" else "mailgrid-engine")


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Engine:
    def __init__(self, data_dir):
        self.process = subprocess.Popen(
            [str(ENGINE), "--data-dir", str(data_dir)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=None,
            text=True, bufsize=1,
        )
        ready = json.loads(self.process.stdout.readline())
        assert ready.get("event") == "ready", ready
        self.next_id = 1

    def call(self, method, params=None):
        call_id = self.next_id
        self.next_id += 1
        self.process.stdin.write(json.dumps({"id": call_id, "method": method, "params": params or {}}) + "\n")
        self.process.stdin.flush()
        while True:
            result = json.loads(self.process.stdout.readline())
            if result.get("id") != call_id:
                continue
            if result.get("error"):
                raise RuntimeError(f"{method}: {result['error']}")
            return result.get("result")

    def stop(self):
        self.call("shutdown")
        self.process.wait(timeout=5)
        if self.process.returncode:
            raise RuntimeError(f"mail engine exited with {self.process.returncode}")


def main():
    assert ENGINE.exists(), "run npm run build:engine first"
    with tempfile.TemporaryDirectory(prefix="mailgrid-test-") as temp:
        ports = {"smtp": free_port(), "imap": free_port(), "pop3": free_port()}
        while len(set(ports.values())) < 3:
            ports = {"smtp": free_port(), "imap": free_port(), "pop3": free_port()}
        Path(temp, "settings.json").write_text(json.dumps({"ports": ports, "retentionDays": 0}))
        engine = Engine(temp)
        try:
            for address in ["alice@mailgrid.test", "bob@mailgrid.test"]:
                engine.call("accounts.create", {"address": address, "password": "correct-horse-123"})

            message = EmailMessage()
            message["From"] = "app@example.test"
            message["To"] = "alice@mailgrid.test, nobody@example.test"
            message["Subject"] = "Integration receipt"
            message.set_content("Plain text version")
            message.add_alternative("<h1>HTML version</h1>", subtype="html")
            message.add_attachment(b"hello attachment", maintype="application", subtype="octet-stream", filename="sample.bin")
            with smtplib.SMTP("127.0.0.1", ports["smtp"], local_hostname="localhost", timeout=10) as smtp:
                smtp.send_message(message, to_addrs=["alice@mailgrid.test", "nobody@example.test"])

            alice = engine.call("messages.list", {"account": "alice@mailgrid.test"})
            catchall = engine.call("messages.list", {"account": "catchall"})
            assert len(alice) == 1 and len(catchall) == 1, (alice, catchall)
            detail = engine.call("messages.get", {"account": "alice@mailgrid.test", "uid": alice[0]["uid"]})
            assert "Plain text version" in detail["text"]
            assert "HTML version" in detail["html"]
            assert detail["attachments"][0]["name"] == "sample.bin"
            unknown = engine.call("messages.get", {"account": "catchall", "uid": catchall[0]["uid"]})
            assert "nobody@example.test" in unknown["deliveredTo"]
            with smtplib.SMTP("127.0.0.1", ports["smtp"], local_hostname="localhost", timeout=10) as smtp:
                smtp.ehlo()
                assert smtp.mail("app@example.test", options=["SIZE=999999999"])[0] == 552
                smtp.rset()
                try:
                    smtp.sendmail("app@example.test", ["bad@example.test"], "not a header\r\n\r\ninvalid MIME")
                    raise AssertionError("malformed headers were accepted")
                except smtplib.SMTPDataError:
                    pass
            assert len(engine.call("messages.list", {"account": "catchall"})) == 1

            with imaplib.IMAP4("127.0.0.1", ports["imap"], timeout=10) as imap:
                imap.login("alice@mailgrid.test", "correct-horse-123")
                typ, _ = imap.select("INBOX")
                assert typ == "OK"
                typ, ids = imap.search(None, "ALL")
                assert typ == "OK" and ids[0], ids
                typ, payload = imap.fetch(ids[0].split()[0], "(RFC822)")
                assert typ == "OK" and b"Integration receipt" in payload[0][1]
                assert imap.create("Archive")[0] == "OK"
                assert imap.copy(ids[0].split()[0], "Archive")[0] == "OK"
                assert imap.store(ids[0].split()[0], "+FLAGS", r"(\Deleted)")[0] == "OK"
                assert imap.expunge()[0] == "OK"
            assert engine.call("messages.list", {"account": "alice@mailgrid.test"}) == []
            assert len(engine.call("messages.list", {"account": "alice@mailgrid.test", "folder": "Archive"})) == 1

            engine.call("compose.send", {"from": "alice@mailgrid.test", "to": ["bob@mailgrid.test"], "subject": "Local hello", "text": "hello Bob"})
            sent = engine.call("messages.list", {"account": "alice@mailgrid.test", "folder": "Sent"})
            assert len(sent) == 1, sent
            with smtplib.SMTP("127.0.0.1", ports["smtp"], local_hostname="localhost", timeout=10) as smtp:
                try:
                    smtp.login("alice@mailgrid.test", "incorrect-password")
                    raise AssertionError("incorrect SMTP password accepted")
                except smtplib.SMTPAuthenticationError:
                    pass
                smtp.login("alice@mailgrid.test", "correct-horse-123")
                smtp.sendmail("alice@mailgrid.test", ["bob@mailgrid.test"], "From: alice@mailgrid.test\r\nTo: bob@mailgrid.test\r\nSubject: Authenticated SMTP\r\n\r\nhello\r\n")
            assert len(engine.call("messages.list", {"account": "alice@mailgrid.test", "folder": "Sent"})) == 2
            pop = poplib.POP3("127.0.0.1", ports["pop3"], timeout=10)
            try:
                pop.user("bob@mailgrid.test")
                pop.pass_("correct-horse-123")
                assert pop.stat()[0] == 2
                assert b"Local hello" in b"\n".join(pop.retr(1)[1])
                pop.dele(1)
                pop.rset()
                assert pop.stat()[0] == 2
                pop.dele(1)
                pop.dele(2)
            finally:
                pop.quit()
            assert engine.call("messages.list", {"account": "bob@mailgrid.test"}) == []
            engine.call("accounts.updatePassword", {"address": "alice@mailgrid.test", "password": "fixture-password"})
            engine.call("accounts.verifyPassword", {"address": "alice@mailgrid.test", "password": "fixture-password"})
            with smtplib.SMTP("127.0.0.1", ports["smtp"], local_hostname="localhost", timeout=10) as smtp:
                try:
                    smtp.login("alice@mailgrid.test", "correct-horse-123")
                    raise AssertionError("old password still accepted")
                except smtplib.SMTPAuthenticationError:
                    pass
                smtp.login("alice@mailgrid.test", "fixture-password")
            with imaplib.IMAP4("127.0.0.1", ports["imap"], timeout=10) as imap:
                imap.login("alice@mailgrid.test", "fixture-password")
            pop = poplib.POP3("127.0.0.1", ports["pop3"], timeout=10)
            try:
                pop.user("alice@mailgrid.test")
                pop.pass_("fixture-password")
            finally:
                pop.quit()
            spaced_password = " space #$ "
            engine.call("accounts.updatePassword", {"address": "alice@mailgrid.test", "password": spaced_password})
            with smtplib.SMTP("127.0.0.1", ports["smtp"], local_hostname="localhost", timeout=10) as smtp:
                smtp.login("alice@mailgrid.test", spaced_password)
            with imaplib.IMAP4("127.0.0.1", ports["imap"], timeout=10) as imap:
                imap.login("alice@mailgrid.test", spaced_password)
            pop = poplib.POP3("127.0.0.1", ports["pop3"], timeout=10)
            try:
                pop.user("alice@mailgrid.test")
                pop.pass_(spaced_password)
            finally:
                pop.quit()
            engine.call("accounts.updatePassword", {"address": "alice@mailgrid.test", "password": "fixture-password"})
            engine.process.kill()
            engine.process.wait(timeout=5)

            engine = Engine(temp)
            engine.call("accounts.verifyPassword", {"address": "alice@mailgrid.test", "password": "fixture-password"})
            assert len(engine.call("messages.list", {"account": "alice@mailgrid.test", "folder": "Archive"})) == 1
            assert len(engine.call("messages.list", {"account": "catchall"})) == 1
            print("PASS: SMTP/auth, limits/malformed mail, catch-all, MIME, IMAP moves, Sent, POP3 reset/deletion, password changes across protocols, crash persistence")
        finally:
            if engine.process.poll() is None:
                engine.stop()


if __name__ == "__main__":
    main()
