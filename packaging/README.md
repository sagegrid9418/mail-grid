# Mail Grid 0.3.2 installer builds

Build the current renderer and main process before packaging:

```sh
npm run build:main
npm run build:ui
npm run release:key
npm run installers -- macos
MAILGRID_MAKENSIS=/path/to/nsis-bundle/makensis npm run installers -- windows
npm run installers -- linux
```

Requirements: Node 24, Python 3, Go matching `engine/go.mod`, installed npm dependencies, and at least 5 GiB free for the universal Mac build. Set `MAILGRID_GO` when Go is not on PATH. Mac packaging must run on macOS. Network access is needed for official Electron runtimes unless cached.

## Generated packages

`out/installers/` contains:

- `Mail-Grid-0.3.2-macOS-Universal.dmg`: one native Intel/Apple Silicon installer. Electron, the Go mail engine, and the detached Go updater helper are merged for both architectures. The build applies local/ad-hoc signatures and embeds the public release-verification key.
- `Mail-Grid-0.3.2-Windows-x64-Setup.exe`: unsigned NSIS per-user installer, Start menu shortcut and uninstaller. Supports the updater's `--updated` and `--force-run` arguments and retains the existing install location.
- `mail-grid_0.3.2_amd64.deb`: Ubuntu/Debian AMD64 package with desktop integration, dependency metadata, file checksums, and the Chromium sandbox helper owned by root with mode 4755.
- `SHA256SUMS` and `INSTALL.txt`.

Windows and Linux are cross-built with CGO disabled. Their bundled official Electron runtime, freshly built Go engine, production dependencies, public trust file, updater configuration and application archive are checked before producing installers. Package removal preserves per-user mail. Earlier released installers should be kept in a separate versioned archive, never renamed as current builds.

The NSIS compiler used here is the official electron-builder-binaries `nsis@2.0.2` bundle (`nsis-bundle-3.12.tar.gz`), SHA-256 `83d80ee578cb19008b2a99e4fccfb5e7c023cc9bb791eb38f6048fccc875f62c`. Obtain it from https://github.com/electron-userland/electron-builder-binaries/releases/tag/nsis%402.0.2. Its `makensis` wrapper chooses the host binary and configures NSISDIR. The script sets a supported UTF-8 locale on macOS. The EXE uses streaming zlib compression to keep rebuild times practical.

## Free release verification and publishing

Paid Apple/Windows signing and notarization are optional. Free Ed25519 metadata verification and SHA checksums remain mandatory. Only public keys go into installers and the separate release service. Securely back up `.release-private/` outside the build computer; never upload it or include it in public artifacts.

Use `npm run release:prepare -- --os macos --notes notes.md` (or `windows` / `linux`) to produce one OS release ZIP. Upload that generated ZIP through release control. Another OS may join the same version later. Published target/version files cannot be replaced. See [RELEASING.md](../RELEASING.md) and [SIGNING.md](../SIGNING.md).

Linux AppImage builds remain available through native `electron-builder --config electron-builder.cjs --linux AppImage --x64`; release bundles can include an AppImage independently from DEB. This machine's beta delivery uses DEB; do not imply an AppImage was tested or delivered when it was not built.

## Verification

```sh
python3 tests/installers.py --seven-zip /path/to/7zz
hdiutil verify out/installers/Mail-Grid-0.3.2-macOS-Universal.dmg
```

The Windows/DEB checks inspect current version, every compiled UI/main file, public trust, production updater dependencies and native binary architecture. They inspect archives without executing a target-platform installer. Verify each bundled Mac Mach-O executable contains x86_64 and arm64 and run `codesign --verify --deep --strict` on the mounted app.

Run real clean-install/update/recovery workflows on Windows, Linux, Intel Mac and Apple Silicon before claiming native platform verification. Installer generation does not install or publish anything. Never test against the user's real mailbox or owner database.

`MAILGRID_WINDOWS_APP_DIR` and `MAILGRID_LINUX_APP_DIR` can reuse a freshly assembled native runtime directory, but its ASAR must match every current compiled file, version, production dependency and public key. Rebuild the engine when its source or dependencies change. Staging directories are removed after packaging unless `MAILGRID_KEEP_STAGING` is explicitly enabled.

Linux formats are independent. `npm run release:prepare -- --os linux --package-type deb --notes notes.md` selects DEB (the default); use `--package-type appimage` for an AppImage ZIP. Each gets a separate output filename and can be published without the other.
