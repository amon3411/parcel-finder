"""Prints GitHub release notes for a version, taken from the CHANGELOG in src/shell.html.
   Obtainium shows these notes as the app's changelog.  Usage: python3 tools/release_notes.py 1.3.0"""
import re, sys, os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(root, 'src', 'shell.html'), encoding='utf-8').read()
block = re.search(r'const CHANGELOG = \[(.*?)\n\];', src, re.S).group(1)
entries = {v: (d, re.findall(r"'((?:[^'\\]|\\.)*)'", items)) for v, d, items in re.findall(r"\['([\d.]+)', '([^']*)', \[(.*?)\]\]", block, re.S)}
ver = sys.argv[1]
date, items = entries.get(ver, ('', []))
print(f"""**Parcel Finder {ver}**{f' · {date}' if date else ''}

Parcel Finder reads your Gmail (and Outlook) to track packages, collect receipts and clean up email subscriptions — all on your phone.

### What's new
""" + '\n'.join(f'- {i}' for i in items) + """

### Install or update
- **Obtainium:** Add app → paste `https://github.com/amon3411/parcel-finder` → Add. Updates show up automatically.
- **Manual:** download the APK below and open it on your phone.

Most changes to screens and features reach the app automatically the next time you open it; a new APK is only needed for the Android wrapper.""")
