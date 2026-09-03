# Deploy

Contents of this folder map 1:1 to the web root.

| File | URL | What it is |
| --- | --- | --- |
| `index.html` | `/` | The portfolio site, single self-contained file |
| `me.html` | `/me` | Redirect into the desktop shell |
| `Desktop.dc.html` | `/Desktop.dc.html` | Me.exe desktop |
| `Vincent Quach.dc.html` | — | Site build the desktop's Internet Voyager window loads in its iframe |
| `support.js` | — | Runtime the two `.dc.html` files load |
| `assets/` | `/assets/…` | Wallpaper, icons, images |
| `oura-proxy-worker.js` | — | Cloudflare Worker, deployed separately (not served) |

## Notes

- Keep the filename `Vincent Quach.dc.html` exactly, spaces included — the desktop
  requests it as `Vincent%20Quach.dc.html`.
- `support.js` pulls React and Babel from unpkg at runtime, so the desktop needs a
  network connection. `index.html` does not.
- Space Cadets loads from `lrusso.github.io`; if that host goes away the window is blank.
- Link to the desktop from the site as `/me`.
