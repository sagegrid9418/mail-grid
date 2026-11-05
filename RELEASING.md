# Mail Grid releases

## Prerequisites

Use Node, the project's pinned dependencies, Go compatible with `engine/go.mod`, and native packaging tools. macOS universal builds require both Electron architectures and enough free space (the installer command checks for at least 5 GiB). Native Windows/Linux/Mac installation and update tests remain required before claiming those platforms verified.

Paid certificates and notarization are optional. **Free Ed25519 verification is mandatory.** Follow SIGNING.md to generate and back up the private key before building.

## Finish a desktop change

1. Increment the app version once for the completed batch. Keep the root package and lockfile versions aligned.
2. Build the current engine, main process and renderer. Run the tests relevant to the changed behavior.
3. Regenerate the universal macOS DMG, Windows x64 NSIS EXE and Linux AMD64 DEB (AppImage may be released independently when built). Preserve previous installers separately.
4. Verify payload versions, compiled files, embedded public keys, executable architectures, permissions and checksums. Never rename an old installer to make it look new.
5. Refresh installation notes and record real native testing results. Report a missing toolchain, insufficient space or unavailable target machine explicitly.

```sh
npm run release:key
npm run build
npm run installers -- macos
npm run installers -- windows
npm run installers -- linux
```

For custom Windows compiler setup and packaging prerequisites, see packaging/README.md. Use `MAILGRID_GO` when Go is not on PATH.

## Prepare one operating system

Write accurate release notes in `notes.md`, then run only the relevant command:

```sh
npm run release:prepare -- --os macos --notes notes.md
npm run release:prepare -- --os windows --notes notes.md
npm run release:prepare -- --os linux --notes notes.md
```

Optional: `--title "A short release title"`. The output ZIP under `out/releases/` contains `release.json`, `verification.json` and `artifacts/`. The schema-2 signed payload lists exact artifact names, sizes, hashes, compatible OS/package targets and minimum system versions. A file can serve both installer and update roles. Mac uses one universal DMG; no additional updater ZIP is required.

The assembly verification records file/hash checks, not invented native test results. Do not upload an arbitrary ZIP of installers. Do not include `.env`, account/mail data, private signing keys or owner credentials.

## Publish through the separately maintained release service

1. Open the authorized release dashboard. Its web application is maintained separately from this desktop repository.
2. Select one generated OS release ZIP. Uploading is resumable; use the same file to resume. Do not refresh into a second conflicting validation run.
3. Review target, version, notes and file hashes. Publish that draft when ready.
4. Publish another OS later, including at the same version. Each target/version is immutable. Changed files need a newer version for that target.
5. A platform can have a lower latest version than another platform. Releases only have to advance the targets they contain.
6. Delete release permanently removes the selected bundle’s installer files after confirmation. Previously published versions remain reserved; other operating systems are unaffected. Failed cleanup is retryable in the dashboard. Deleted unpublished drafts may be uploaded again.
7. Withdrawal hides that uploaded OS release and its downloads. Compatible clients then discover the next available published version for their target; unrelated platforms stay published. Previously withdrawn versions cannot be re-uploaded or used to lower the version history.

## Release interfaces and storage

- `/api/v2/releases/latest?platform=darwin&arch=arm64&packageType=mac&systemVersion=13.0.0` returns a compatible published signed envelope or `release: null`. Universal Mac targets match both native Mac architectures.
- `/api/v2/releases` groups published catalogue entries by version with their available targets. Target notes may differ within a version.
- Schema-1 endpoints and download URLs remain available for legacy releases. New schema-2 envelopes are not sent to clients that only understand schema 1.
- Normalized target/file records prevent duplicate target versions and filename collisions. Database migration backfills existing releases without changing their signed payloads.
- Installers remain in private storage and are served only while their owning release is published. Preserve database and private storage together when backing up or migrating hosting.

## User update experience

On first launch, new profiles must select language, theme, download mode and automatic-check preference before mail capture or system registrations begin. Existing profiles retain their preferences. English and Manual downloads are defaults; app appearance initially follows the system.

Update availability appears in the app with notes and download/install actions. Users control download preferences. Updating briefly disconnects local mail clients; acknowledged mail and accounts persist. Later, Close and ordinary quit do not install updates. The Mac helper keeps a previous-app backup until startup succeeds; do not remove a pending recovery backup manually without checking its journal.

Before public claims, rehearse initial installation, older-version migration, self-update/restart, cancellation, insufficient space, denied authorization and failed-update recovery on real target systems. Keep signing warnings and actual test limitations visible.

Linux formats are independent. `npm run release:prepare -- --os linux --package-type deb --notes notes.md` selects DEB (the default); use `--package-type appimage` for an AppImage ZIP. Each gets a separate output filename and can be published without the other.

## Resumable downloads (0.3.2 and later)

The desktop stores a signed-metadata identity, durable progress journal and partial file in its private profile. An interrupted requested download resumes automatically, even in Manual mode or with automatic checks disabled. Pause persists; Cancel removes its cached bytes and suppresses automatic downloading of that artifact until the user requests it. Servers must retain checksum ETags and HTTP Range/If-Range behavior on the existing download routes. Changed or withdrawn releases stop the transfer. Every completed artifact is verified before native installation; Update now remains explicit. Older clients do not gain resume support until 0.3.2 is installed.

`npm run locales:build` is a mandatory packaging gate. Only complete offline catalogs enter the generated supported-language manifest. See LANGUAGES.md; never substitute English placeholders to pass coverage.
