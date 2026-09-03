# Deploy

Every file here is self-contained. No build step, no `support.js`, no filenames with
spaces. Copy the folder contents to the web root.

| File | URL | What it is |
| --- | --- | --- |
| `index.html` | `/` | The portfolio site |
| `me.html` | `/me.html` | Me.exe desktop shell |
| `site.html` | — | Site build the desktop's Internet Voyager window loads in its iframe |
| `assets/` | `/assets/…` | Wallpaper and icons the desktop loads at runtime |
| `.nojekyll` | — | Stops GitHub Pages from running Jekyll over the files |
| `oura-proxy-worker.js` | — | Cloudflare Worker, deployed separately (not served) |

## Notes

- `me.html` needs `site.html` and `assets/` next to it. Everything else is inlined.
- Filenames are case-sensitive on GitHub Pages. `assets/icons/space-cadets.png`,
  `assets/icons/internet-voyager.png`, `assets/icons/my-computer.ico`,
  `assets/icons/start.png`, `assets/logo-icon.png`, `assets/wallpaper.jpg`.
- Space Cadets loads from `lrusso.github.io`; if that host goes away the window is blank.
- Link to the desktop from the site as `/me.html`.
