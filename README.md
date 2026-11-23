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
