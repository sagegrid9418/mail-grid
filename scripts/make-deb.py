"""Create a standard Debian ar package on any host, without installing system tools."""
import argparse
import gzip
import hashlib
import io
import os
from pathlib import Path
import shutil
import tarfile
import tempfile


def ar_member(output, name, content):
    size = content.stat().st_size
    header = f"{name + '/':<16}{0:<12}{0:<6}{0:<6}{'100644':<8}{size:<10}`\n"
    output.write(header.encode('ascii'))
    with content.open('rb') as stream:
        shutil.copyfileobj(stream, output)
    if size % 2:
        output.write(b'\n')


def root_owned(info):
    info.uid = info.gid = 0
    info.uname = info.gname = 'root'
    info.mtime = 0
    if info.name == './opt/mail-grid/chrome-sandbox':
        info.mode = 0o4755
    return info


def stage_file(source, destination):
    # Staging is read-only: hard links avoid duplicating a complete Electron
    # runtime on space-constrained build machines. Different volumes copy normally.
    try:
        os.link(source, destination)
        return destination
    except OSError:
        return shutil.copy2(source, destination)


def archive_tree(source, output):
    with output.open('wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as zipped:
        with tarfile.open(fileobj=zipped, mode='w', format=tarfile.GNU_FORMAT) as archive:
            for entry in sorted(source.iterdir()):
                archive.add(entry, arcname='./' + entry.name, filter=root_owned)


def build(app, icon, version, output):
    with tempfile.TemporaryDirectory(prefix='mailgrid-deb-') as temp:
        temp = Path(temp)
        data, control = temp / 'data', temp / 'control'
        install = data / 'opt' / 'mail-grid'
        install.parent.mkdir(parents=True)
        shutil.copytree(app, install, symlinks=True, copy_function=stage_file)
        launcher = data / 'usr/bin/mail-grid'
        launcher.parent.mkdir(parents=True)
        launcher.symlink_to('/opt/mail-grid/mail-grid')
        desktop = data / 'usr/share/applications/mail-grid.desktop'
        desktop.parent.mkdir(parents=True)
        desktop.write_text('[Desktop Entry]\nType=Application\nName=Mail Grid\nComment=Local email for developers\nExec=/opt/mail-grid/mail-grid\nIcon=mail-grid\nTerminal=false\nCategories=Development;Network;Email;\nStartupWMClass=Mail Grid\n')
        app_icon = data / 'usr/share/icons/hicolor/512x512/apps/mail-grid.png'
        app_icon.parent.mkdir(parents=True)
        shutil.copyfile(icon, app_icon)
        control.mkdir()
        installed_kb = sum(p.stat().st_size for p in data.rglob('*') if p.is_file() and not p.is_symlink()) // 1024
        (control / 'control').write_text(f'''Package: mail-grid
Version: {version}
Architecture: amd64
Maintainer: Mail Grid contributors
Section: devel
Priority: optional
Installed-Size: {installed_kb}
Depends: libc6 (>= 2.31), libgcc-s1, libstdc++6, libnss3, libnspr4, libatk1.0-0t64 | libatk1.0-0, libatk-bridge2.0-0t64 | libatk-bridge2.0-0, libatspi2.0-0t64 | libatspi2.0-0, libdrm2, libdbus-1-3, libcups2t64 | libcups2, libgtk-3-0t64 | libgtk-3-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxrandr2, libgbm1, libxkbcommon0, libasound2t64 | libasound2, libpango-1.0-0, libcairo2, libglib2.0-0t64 | libglib2.0-0, xdg-utils
Description: Local email workspace for developers
 Capture SMTP mail locally and inspect it with a desktop inbox, IMAP, or POP3.
 Messages stay on this computer; no internet delivery or hosted account.
''')
        sums = []
        for file in sorted(data.rglob('*')):
            if file.is_file() and not file.is_symlink():
                sums.append(f'{hashlib.md5(file.read_bytes()).hexdigest()}  {file.relative_to(data).as_posix()}\n')
        (control / 'md5sums').write_text(''.join(sums))
        # No recursive removal or user-data deletion in package lifecycle scripts.
        for name in ['postinst', 'postrm']:
            script = control / name
            script.write_text('''#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database /usr/share/applications || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true; fi
exit 0
''')
            script.chmod(0o755)
        archive_tree(data, temp / 'data.tar.gz')
        archive_tree(control, temp / 'control.tar.gz')
        (temp / 'debian-binary').write_bytes(b'2.0\n')
        with output.open('wb') as package:
            package.write(b'!<arch>\n')
            for name in ['debian-binary', 'control.tar.gz', 'data.tar.gz']:
                ar_member(package, name, temp / name)
        print(output)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--app', type=Path, required=True)
    parser.add_argument('--icon', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    build(args.app, args.icon, args.version, args.output)
