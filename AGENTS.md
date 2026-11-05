# Mail Grid coding-agent instructions

## Finish desktop updates with fresh installers

- After every completed change to the desktop software (renderer, Electron main process, mail engine, updater, desktop dependencies or packaging), increment the app version and regenerate the package installers before reporting the work complete.
- Bump the patch version by default, once per completed batch of changes. Use a minor or major bump when the user requests it or the change warrants it. Never reuse a released version for changed desktop code.
- Keep `package.json`, the root package-lock version and any other package manifests that share the release version consistent. Verify the generated app and installer metadata match that version.
- Build the current main/renderer/engine code, then regenerate the universal macOS DMG, Windows EXE and Linux DEB beta installers under `out/installers/`. Regenerate checksums and installation notes. Follow `packaging/README.md`; production release bundles additionally follow `RELEASING.md`.
- Verify that installers contain the current compiled files and version. Never rename an older installer to present it as a new build. Preserve user mail, accounts, credentials and preferences, and retain previous released installers separately.
- Paid Apple/Windows certificates and notarization are optional. Keep free Ed25519 release verification, checksums and honest native testing results. Never require paid signing to prepare or upload a release. Do not publish a release or install it on the user's computer merely because it has been built.
- If a build is blocked by a missing toolchain, platform, disk space or free release-key configuration, finish all available work and state exactly which installer remains blocked. Never claim a missing installer was generated.

## Update behavior belongs to the app user

- Only the desktop user's settings decide whether updates download manually or automatically. Manual is the default. Existing explicit Automatic choices remain Automatic; legacy “inherit publisher default” choices migrate to Manual.
- The website admin uploads, reviews, publishes and withdraws releases. It cannot choose or override users' download modes.
- Installation always requires the user's explicit approval. Later, Close and ordinary application quit must not install updates or interrupt mail capture.

## Project constraints

- Never commit or bundle local mail, account credentials, environment secrets or private signing keys. This repository contains desktop source only; keep the website, website tests, marketing and generated/private data excluded in `.gitignore`. Documentation-only repository preparation does not change the desktop release version.
- Run checks that cover the changed behavior and report actual results and platform limitations.

## Independent releases and localization

- Prepare and publish each OS/package target independently. Permit another target at the same version; never replace a published target/version. Resolve latest compatible updates per target.
- macOS ships one universal DMG, including universal engine and installer helper. Preserve app identity and user data.
- New profiles complete first-launch setup before services, startup registration, notifications or update polling begin. Existing profiles retain preferences.
- English is the default/fallback. All interface strings use the local translation catalog; email contents and raw diagnostics are not translated. Support RTL layouts and locale-aware formatting.

## Offline language and update-transfer gates

- Run `npm run locales:build` before packaging. Keep only complete catalogs in the generated supported-language manifest. Missing text and accidental English placeholders must fail the build; technical identifiers and legitimate unchanged terms require an explicit reviewed allowlist.
- Translation maintenance must respect the user's local-only preference: use checked-in text or local inference. Do not send interface catalogs to external translation services without explicit permission. Development models/toolchains never belong in installers or deployment packages.
- Test resumable downloads with the isolated transfer fixtures and real Electron restart workflow. Preserve paused/cancelled intent, signed metadata checks, dual file checksums and the user's explicit installation approval.
