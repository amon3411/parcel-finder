"""Builds both versions of Parcel Finder from the same source.
   python3 src/build.py  ->  index.html (standalone, GitHub Pages)  +  claude/index.html (Claude artifact)"""
import os, re
here = os.path.dirname(os.path.abspath(__file__)); root = os.path.dirname(here)
read = lambda f: open(os.path.join(here, f), encoding='utf-8').read()
app = read('shell.html').replace('/*LOGIC*/', read('logic.js')).replace('/*GMAIL*/', read('gmail.js'))
version = re.search(r"APP_VERSION = '([\d.]+)'", app).group(1)

os.makedirs(os.path.join(root, 'claude'), exist_ok=True)
open(os.path.join(root, 'claude', 'index.html'), 'w', encoding='utf-8').write(app)

head = f'''<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/icon-192.png">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<script src="config.js?v={version}"></script>
<script src="mail-shim.js?v={version}"></script>
'''
tail = '''<script>
if (navigator.serviceWorker) {
  navigator.serviceWorker.register('sw.js').then(reg => { if (!reg) return;
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w && w.addEventListener('statechange', () => {
        if (w.state === 'activated' && navigator.serviceWorker.controller) location.reload();
      });
    });
    setInterval(() => reg.update(), 60 * 60 * 1000);
  });
}
</script>
</body>'''
standalone = app.replace('</title>', '</title>\n' + head, 1).replace('</body>', tail, 1)
open(os.path.join(root, 'index.html'), 'w', encoding='utf-8').write(standalone)
sw = read('sw.template.js').replace('__VERSION__', version)
open(os.path.join(root, 'sw.js'), 'w', encoding='utf-8').write(sw)
print('built', version)
