"""Inspect release payloads on macOS without executing Windows/Linux installers."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'out/installers'


def check_current_bundle(archive):
    # A valid installer can still contain stale application code. Compare its
    # compiled UI/main files with this build before accepting the artifact.
    subprocess.run(['node', '-e', r'''
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const asar = require('@electron/asar');
const archive = process.argv[1], root = process.argv[2];
const expected = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
const actual = JSON.parse(asar.extractFile(archive, 'package.json'));
assert.equal(actual.version, expected.version);
assert.equal(actual.main, expected.main);
assert.ok(asar.listPackage(archive).includes('/node_modules/electron-updater/package.json'), 'Missing production updater dependency');
function check(folder) {
  for (const entry of fs.readdirSync(path.join(root, folder), {withFileTypes: true})) {
    const relative = path.join(folder, entry.name);
    if (entry.isDirectory()) check(relative);
    else assert.ok(asar.extractFile(archive, relative).equals(fs.readFileSync(path.join(root, relative))), `Stale installer payload: ${relative}`);
  }
}
check('dist-electron'); check('dist-ui');check('assets/locales');assert.ok(asar.extractFile(archive,'assets/update-trust.json').equals(fs.readFileSync(path.join(root,'assets/update-trust.json'))),'Public verification key differs');
''', str(archive), str(ROOT)], cwd=ROOT, check=True)


def check_engine(data, platform):
    # Recompile the pinned source to reject an installer with a stale engine.
    go = os.environ.get('MAILGRID_GO', 'go')
    with tempfile.TemporaryDirectory(prefix='mailgrid-engine-identity-') as temp:
        expected = Path(temp) / ('engine.exe' if platform == 'windows' else 'engine')
        subprocess.run([go, 'build', '-trimpath', '-o', str(expected), '.'], cwd=ROOT/'engine', env={**os.environ, 'GOOS':platform, 'GOARCH':'amd64', 'CGO_ENABLED':'0'}, check=True)
        assert data == expected.read_bytes(), f'Stale source/dependencies in {platform} engine'


def deb_members(path):
    with path.open('rb') as stream:
        assert stream.read(8) == b'!<arch>\n', 'Invalid Debian ar header'
        while header := stream.read(60):
            assert len(header) == 60 and header[-2:] == b'`\n'
            name = header[:16].decode().strip().rstrip('/')
            size = int(header[48:58])
            payload = stream.read(size)
            assert len(payload) == size
            if size % 2:
                stream.read(1)
            yield name, payload


def is_pe_amd64(data):
    assert data[:2] == b'MZ', 'Missing Windows PE header'
    pointer = struct.unpack_from('<I', data, 0x3c)[0]
    assert data[pointer:pointer + 4] == b'PE\0\0'
    assert struct.unpack_from('<H', data, pointer + 4)[0] == 0x8664, 'Not Windows x64'


def is_elf_amd64(data):
    assert data[:6] == b'\x7fELF\x02\x01', 'Not 64-bit little-endian ELF'
    assert struct.unpack_from('<H', data, 18)[0] == 62, 'Not Linux x86-64'


def check_deb(path):
    members = dict(deb_members(path))
    assert members['debian-binary'] == b'2.0\n'
    with tarfile.open(fileobj=io.BytesIO(members['control.tar.gz']), mode='r:gz') as archive:
        control = archive.extractfile('./control').read().decode()
        assert 'Package: mail-grid\n' in control and 'Architecture: amd64\n' in control and 'Depends: libc6' in control
        assert 'Version: '+json.loads((ROOT/'package.json').read_text())['version']+'\n' in control
        expected_sums = archive.extractfile('./md5sums').read().decode().splitlines()
        assert archive.getmember('./postinst').mode == 0o755
        assert archive.getmember('./postrm').mode == 0o755
    with tarfile.open(fileobj=io.BytesIO(members['data.tar.gz']), mode='r:gz') as archive:
        files = {member.name: member for member in archive.getmembers()}
        is_elf_amd64(archive.extractfile('./opt/mail-grid/mail-grid').read(512))
        engine=archive.extractfile('./opt/mail-grid/resources/mailgrid-engine').read()
        is_elf_amd64(engine)
        check_engine(engine,'linux')
        assert archive.extractfile('./opt/mail-grid/resources/package-type').read().strip()==b'deb'
        assert json.loads(archive.extractfile('./opt/mail-grid/resources/app-update.yml').read())['url']=='https://mail-dev.sagegrid.org'
        assert files['./opt/mail-grid/mail-grid'].mode & 0o111
        sandbox = files['./opt/mail-grid/chrome-sandbox']
        assert sandbox.uid == 0 and sandbox.gid == 0 and sandbox.mode == 0o4755, 'Chromium sandbox permissions incorrect'
        assert files['./usr/bin/mail-grid'].issym() and files['./usr/bin/mail-grid'].linkname == '/opt/mail-grid/mail-grid'
        assert b'Exec=/opt/mail-grid/mail-grid\n' in archive.extractfile('./usr/share/applications/mail-grid.desktop').read()
        assert files['./opt/mail-grid/resources/app.asar'].size > 500000
        with tempfile.TemporaryDirectory(prefix='mailgrid-deb-bundle-') as temp:
            bundle = Path(temp) / 'app.asar'
            bundle.write_bytes(archive.extractfile('./opt/mail-grid/resources/app.asar').read())
            check_current_bundle(bundle)
        for line in expected_sums:
            expected, name = line.split('  ', 1)
            data = archive.extractfile('./' + name).read()
            assert hashlib.md5(data).hexdigest() == expected, f'Debian file checksum mismatch: {name}'
        assert all(not name.startswith(('./home/', './Users/')) for name in files)
    print('PASS: DEB current application bundle, control/dependencies, Linux runtime and engine architecture, launcher, sandbox ownership/mode, all file checksums')


def check_windows(path, seven_zip):
    # The NSIS bootstrap is x86 and installs the x64 app; inspect the installed app, not just the bootstrap.
    subprocess.run([seven_zip, 't', str(path), '-bso0', '-bsp0'], check=True)
    with tempfile.TemporaryDirectory(prefix='mailgrid-exe-check-') as temp:
        subprocess.run([seven_zip, 'x', str(path), '-o' + temp, '-y', '-bso0', '-bsp0'], check=True)
        files = list(Path(temp).rglob('*'))
        app = next(file for file in files if file.name == 'mail-grid.exe')
        engine = next(file for file in files if file.name == 'mailgrid-engine.exe')
        is_pe_amd64(app.read_bytes())
        is_pe_amd64(engine.read_bytes())
        check_engine(engine.read_bytes(),'windows')
        configuration=json.loads((engine.parent/'app-update.yml').read_text())
        assert configuration['url']=='https://mail-dev.sagegrid.org' and configuration['verifyUpdateCodeSignature'] is False
        archive = next(file for file in files if file.name == 'app.asar')
        assert archive.stat().st_size > 500000
        check_current_bundle(archive)
        subprocess.run(['node', '--input-type=module', '-e', r'''
import fs from 'node:fs'; import crypto from 'node:crypto'; import assert from 'node:assert/strict';
import {NtExecutable,NtExecutableResource,Resource} from 'resedit'; import * as asar from '@electron/asar';
const [exePath,archive,root]=process.argv.slice(1),expected=JSON.parse(fs.readFileSync(root+'/package.json')).version;
const resource=NtExecutableResource.from(NtExecutable.from(fs.readFileSync(exePath)));
const version=Resource.VersionInfo.fromEntries(resource.entries)[0];
const strings=version.getStringValues(version.getAllLanguagesForStringValues()[0]);
assert.equal(strings.FileVersion,expected);assert.equal(strings.ProductVersion,expected);
const entries=resource.entries.filter(entry=>entry.type==='INTEGRITY'&&entry.id==='ELECTRONASAR');assert.equal(entries.length,1);
const integrity=JSON.parse(Buffer.from(entries[0].bin).toString('utf8'));
assert.equal(integrity[0].file,'resources\\app.asar');assert.equal(integrity[0].alg,'SHA256');
assert.equal(integrity[0].value,crypto.createHash('sha256').update(asar.getRawHeader(archive).headerString).digest('hex'));
''', str(app), str(archive), str(ROOT)], cwd=ROOT, check=True)
        assert any(file.name == 'WinShell.dll' for file in files), 'Missing shortcut AppUserModelID helper'
        assert b'MZ' == path.read_bytes()[:2]
    print('PASS: Windows current application bundle, installer archive integrity, x64 runtime and Go engine, shortcut identity helper')


def check_manifest():
    lines = (OUTPUT / 'SHA256SUMS').read_text().splitlines()
    assert len(lines) == 3, 'Expected exactly three installer checksums'
    for line in lines:
        expected, name = line.split('  ', 1)
        file = OUTPUT / name
        with file.open('rb') as stream:
            actual = hashlib.file_digest(stream, 'sha256').hexdigest()
        assert actual == expected, f'Installer checksum mismatch: {name}'
    print('PASS: SHA-256 checksums for all three installers')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--seven-zip', required=True)
    args = parser.parse_args()
    check_deb(next(OUTPUT.glob('*.deb')))
    check_windows(next(OUTPUT.glob('*.exe')), args.seven_zip)
    check_manifest()
