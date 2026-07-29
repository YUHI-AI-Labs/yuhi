# Yuhi website

The public landing page for Yuhi — a single, self-contained static page. No build
step, no framework, no external requests (CSP-friendly): all CSS/JS is inline and the
only assets are `favicon.svg` and `og.png`.

```
site/
├── index.html            # THE editable source (inline CSS + JS + locale dictionary)
├── ja/index.html         # generated route (do not edit — byte copy of index.html)
├── zh-cn/index.html      # generated route (do not edit — byte copy of index.html)
├── scripts/
│   └── generate-locale-routes.mjs   # regenerates ja/ and zh-cn/ from index.html
├── favicon.svg           # tab icon (dusk-sun glyph)
├── og.svg                # social-preview source (1280×640)
├── og.png                # rendered social preview (regenerate from og.svg)
└── vercel.json           # clean URLs + security headers
```

## Internationalization (EN / JA / ZH-CN)

`index.html` is the **only editable file**. It is trilingual at runtime: a small
inline bootstrap reads `location.pathname` (`/`, `/ja`, `/zh-cn`), sets
`<html lang>`, applies localized `<title>`/description/OG/canonical, and swaps every
`[data-i18n]` node from a single shared locale dictionary. Routes:

- `/` → English (default) · `/ja` → Japanese · `/zh-cn` → Simplified Chinese

`/ja/index.html` and `/zh-cn/index.html` are **deployment artifacts** — byte-identical
copies of `index.html` that make those paths resolve on static hosting. **Never edit
them directly.** Regenerate them from the single source:

```bash
node scripts/generate-locale-routes.mjs
# verify all three files are identical (prints one hash = identical):
shasum index.html ja/index.html zh-cn/index.html | awk '{print $1}' | sort -u
```

Not translated by design: CLI commands, package names, model IDs, file paths, config
keys, and the four route names (`Sent to Claude` / `Prepared locally` / `Runtime only` /
`Keep local`).

## Deploy to Vercel

This site lives in a subdirectory, so point Vercel at it:

1. Import the `YUHI-AI-Labs/yuhi` repo into Vercel.
2. **Settings → Build & Deployment → Root Directory → `site`.**
3. Framework preset: **Other** (no build command, output = the directory itself).
4. Deploy.

**Always regenerate the locale routes before a production deploy:**

```bash
node scripts/generate-locale-routes.mjs   # refresh ja/ and zh-cn/ from index.html
vercel deploy --prod --yes
```

After the domain is assigned, update the absolute URLs in `index.html`
(`<link rel="canonical">`, `og:url`, `og:image`, `twitter:image`) from the
`https://yuhi.vercel.app/` placeholder to the real domain.

## Regenerate the social preview

Edit `og.svg`, then:

```bash
rsvg-convert -w 1280 -h 640 site/og.svg -o site/og.png
```

Also upload `og.png` under **GitHub → repo Settings → Social preview** so links to the
repository render the same card.

## Local preview

```bash
python3 -m http.server 8080 --directory site
# open http://localhost:8080
```
