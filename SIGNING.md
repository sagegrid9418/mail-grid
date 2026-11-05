# Mail Grid: free release verification and optional platform signing

## No paid signing account is required

Mail Grid authenticates update metadata with its own **Ed25519 release key** and checks the downloaded installer's SHA-256/SHA-512 hashes. Generating this key is free. Apple Developer ID/notarization and Windows Authenticode are optional platform trust features, separate from this verification.

## First build: create and back up the free key

From the project root:

```sh
npm run release:key
npm run build:main
npm run build:ui
```

The key command creates `.release-private/release-key.pem` with restrictive filesystem permissions. It adds only the public key to `assets/update-trust.json`. Repeated runs reuse the key. Do not generate a new key for every release.

**Back up `.release-private/` securely outside this working directory.** Losing the private key prevents signing updates for existing installations; losing every trusted key requires a manual bootstrap installation. Never upload the private key to a server, an admin form, source control, an installer, a public download or a deployment ZIP. Never paste it into chat.

Installers embed the public trust file. The detached Mac helper also embeds those public keys at compile time. After changing trusted keys, rebuild every affected installer.

The separately maintained release service must trust the same public verification keys. Preserve old public keys while existing installations and releases still depend on them. The server never needs private signing keys.

## Prepare an individual OS release

Build the versioned installer first, then:

```sh
npm run release:prepare -- --os macos --notes notes.md
npm run release:prepare -- --os windows --notes notes.md
npm run release:prepare -- --os linux --notes notes.md
```

Run only the command for the OS ready to release. Each output is a separate signed release ZIP. The command reads the local private key; the ZIP contains public metadata, checksums and installer files, never the private key. Advanced builds may set `MAILGRID_RELEASE_KEY` to a private key path.

These commands do not claim that native installation tests have passed. Run and record real tests on the target systems separately.

## How app updates work

- Manual download is the default. Users may select Automatic downloads and independently enable or disable automatic checks.
- No update installs on ordinary quit. **Update now** authorizes installation and restart; Later/Close keep the running app.
- macOS uses a custom detached helper and a universal DMG. It verifies free signed metadata and the DMG bytes, validates the app identity/architectures, stages the app and safely replaces it. It waits for startup confirmation before removing the previous-app backup. Native administrator authorization may be needed for the install directory.
- Windows uses an NSIS installer with update/relaunch arguments. A paid publisher certificate is not required by this profile. OS security warnings may still appear.
- Linux AppImage/DEB updates use the supported installer flow. DEB installation may ask for native authorization.
- Existing keyless builds and older installations need one manual installation of the new updater-enabled build. Keep all local mail and settings.

No updater bypasses Gatekeeper, SmartScreen, system authorization or filesystem permissions. An unsigned/ad-hoc application can still trigger OS warnings. Paid signing does not replace Mail Grid's free release verification.

## Optional Apple signing

If you later choose Developer ID, enroll with Apple, create a **Developer ID Application** certificate and keep its private key in the build keychain. Configure `APPLE_SIGN_IDENTITY` to the exact identity. Notarization requires separate Apple credentials and explicit configuration; it is disabled in the free distribution profile. Test both Mac architectures, notification/login registration and real upgrades. Do not treat a local Apple Development certificate as public notarization.

## Optional Windows signing

Use a supported Authenticode certificate/service and configure its matching build integration. A usable PFX/P12 can use the electron-builder certificate environment variables; hardware/cloud signing needs that provider's integration. Confirm eligibility and tooling before buying anything. SmartScreen reputation warnings may remain even with a certificate.

## Local testing and troubleshooting

Development update feeds remain restricted to explicit loopback test configuration. Never ship a localhost feed override. A normal installed build contains the production origin and public key.

- **Configuration missing:** rebuild with the public trust file and install the new build once.
- **Signature mismatch:** check that the server and installed app trust the release key. Do not disable verification.
- **Checksum mismatch:** re-upload/re-download the exact artifact. Never edit a published installer.
- **No compatible release:** publish a release for that OS/package; another platform's newer release does not update this one.
- **Mac location unsupported:** install Mail Grid in Applications rather than running it from the mounted DMG.
- **Not enough space / authorization denied:** free space or grant native authorization, then retry. The updater must preserve the previous application or its recovery backup.
