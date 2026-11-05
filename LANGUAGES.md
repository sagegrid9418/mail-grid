# Offline interface languages

Mail Grid 0.3.2 ships English and complete local catalogs for Arabic, Chinese (Simplified and Traditional), Dutch, French, German, Hausa, Hebrew, Hindi, Igbo, Indonesian, Italian, Japanese, Korean, Persian, Polish, Portuguese, Russian, Spanish, Swahili, Ukrainian and Yoruba.

Catalogs live in `assets/locales`. `supported.json` is generated from completed catalogs and the pinned CLDR 48 inventory. Both Electron and React use it. Compatible regional selections retain their date/number formatting; unsupported languages migrate to English with a notice. Email bodies, addresses, MIME, developer examples, release notes and technical diagnostic details remain unchanged.

Run `npm run locales:build` before building. It extracts interface/error messages, checks every required catalog, rejects missing/unchanged English entries except the explicit technical/loanword allowlist, validates interpolation, and checks every locale's CLDR plural categories. Do not bypass this gate by filling missing entries with English. Quantity labels in compact announcements are locally authored to avoid ambiguous number agreement.

## Maintaining translations locally

`scripts/localization/translate-local.py` is a development utility, never bundled or executed by the desktop app. It performs local CPU inference; it contains no HTTP client. Existing translations are retained. `apply-overrides.cjs` supplies locally authored controls, including the download meaning of Resume. Review generated text and interpolation failures before accepting a catalog; structural completeness is not a claim of professional native-speaker review.

The temporary development environment uses Python 3.9, CTranslate2 4.3.1, SentencePiece 0.2.0 and NumPy 1.26.4. Local model: `gn64/M2M100_418M_CTranslate2`, revision `18e406c615ef2991fa74d53734bf66b0a6b10cb4`, derived from Meta's MIT-licensed `facebook/m2m100_418M`. Model SHA-256: `a1826980fc5c037e69c7ac94fcb56c03001a66f380eb71863cc0a3879e71421b`. Tokenizer: original revision `55c2e61bbf05dfb8d7abccdc3fae6fc8512fd636`. ICU Simplified–Traditional conversion supplies the script variant, followed by terminology overrides. Model weights and this toolchain are not required to build, install, use or switch the shipped languages.

No interface catalog, email, password or owner data needs to leave the computer. All shipped translation files load from the installed application; no language downloads, remote translation APIs or model inference run in Mail Grid.
