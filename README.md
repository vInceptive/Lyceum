# Deploy

Self-contained files. No build step, no `support.js`. Copy the contents to the web root,
replacing what's there.

| File | URL | What it is |
| --- | --- | --- |
| `index.html` | `/` | Me.exe desktop — the landing page |
| `site.html` | `/site.html` | The portfolio site; also what the desktop's Internet Voyager window loads |
| `assets/` | `/assets/…` | Wallpaper and icons the desktop loads at runtime |
| `.nojekyll` | — | Stops GitHub Pages from running Jekyll over the files |
| `oura-proxy-worker.js` | — | Cloudflare Worker, deployed separately (not served) |

## Notes

- The previous `index.html` (the site) is now `site.html`. Delete the old `me.html`
  from the repo — the desktop is the root page now.
- `.nojekyll` is a dotfile and zip extraction often hides or skips it. If it's missing
  after upload: GitHub → Add file → Create new file → name it `.nojekyll` → commit empty.
- `index.html` needs `site.html` and `assets/` beside it. Everything else is inlined.
- Filenames are case-sensitive on GitHub Pages: `assets/wallpaper.jpg`,
  `assets/logo-icon.png`, `assets/icons/start.png`, `assets/icons/space-cadets.png`,
  `assets/icons/internet-voyager.png`, `assets/icons/my-computer.ico`.
- Space Cadets loads from `lrusso.github.io`; if that host goes away the window is blank.
