# Parcel Finder

Deliveries, receipts and email subscriptions from your Gmail — as an installable phone app.

**Open it:** the GitHub Pages address for this repo, then use your browser's *Install app* / *Add to Home screen*.

## How it's built
- `src/` holds the source: `shell.html` (layout + UI), `logic.js` (tracking/receipt detection), `gmail.js` (scanning).
- `python3 src/build.py` builds two versions from the same source:
  - `index.html` — standalone app (Google sign-in + Gmail API via `gmail-shim.js`)
  - `claude/index.html` — the Claude version (uses Claude's Gmail connector)
- `config.js` holds the Google OAuth client ID (not a secret; it only works from this site's address).
- `sw.js` makes it installable and work offline; updates load automatically.

## Releasing an update
1. Edit files in `src/`, bump `APP_VERSION` and add a `CHANGELOG` entry in `src/shell.html`.
2. Run `python3 src/build.py`, commit and push. The app updates itself on next open.

Your data stays on your device (browser storage) and in your Gmail. Use **Settings → Backup** to copy a backup code.

## Android app (APK) and updates with Obtainium
- `android/` wraps the web app as a Trusted Web Activity (full-screen Chrome, same features).
- `.github/workflows/android.yml` builds a signed APK on every new version and publishes a GitHub Release `v<version>`.
- **Obtainium:** Add app → paste `https://github.com/amon3411/parcel-finder` → Add. It installs the APK and checks for new releases.
- The signing key is kept on a private *draft* release named `signing-key`, encrypted with the `KEYSTORE_PASSWORD` secret. Don't delete or publish it.
- The app's screens update from the website on their own; a new APK is only needed when the Android wrapper changes or the version number goes up.
