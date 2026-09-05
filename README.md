# Deploy

Copy the contents to the web root, replacing what's there.

| File | URL | What it is |
| --- | --- | --- |
| `index.html` | `/` | Me.exe desktop — the landing page |
| `site.html` | `/site.html` | The portfolio site; also what Internet Voyager loads |
| `Visible.dc.html` | — | The Visible epub reader, loaded when that app opens |
| `support.js` | — | Runtime `Visible.dc.html` needs |
| `assets/` | `/assets/…` | Wallpaper and icons |
| `.nojekyll` | — | Stops GitHub Pages from running Jekyll over the files |
| `oura-proxy-worker.js` | — | Cloudflare Worker, deployed separately (not served) |

## Notes

- `index.html` fetches `site.html`, `Visible.dc.html`, and `assets/wallpaper.jpg`
  at runtime. Everything else is inlined.
- `.nojekyll` is a dotfile and zip extraction often hides or skips it. If it's missing
  after upload: GitHub → Add file → Create new file → name it `.nojekyll` → commit empty.
- Filenames are case-sensitive on GitHub Pages.
- Space Cadets loads from `98.js.org`; if that host goes away the window is blank.
- Visible reads .epub files entirely in the browser. Nothing is uploaded anywhere.
