# tolquane.com

The public website: one page, no build step, no framework, no web fonts, no third-party
requests. `public/` is exactly what the server serves.

```
website/
├── README.md          this file
├── deploy.sh          rsync public/ to the server (set TARGET at the top)
├── og-source.html     the source of public/img/og.png, rendered once with Playwright
└── public/            the site, byte for byte
    ├── index.html     the page: hero, the library, the runtimes, liveness,
    │                  Tolquane Web, ways to run it, get it, footer
    ├── style.css      the product's design tokens with a marketing type scale
    ├── favicon.svg    the wordmark's mark
    ├── robots.txt
    ├── sitemap.xml    / and /docs/
    └── img/           the screenshots and diagrams, copied from docs/img/
```

The page is dark by default; the toggle in the header switches to light and remembers the
choice in `localStorage`. With no stored choice the reader's `prefers-color-scheme` wins,
so a light system gets the light theme. The only JavaScript on the page is that toggle and
the copy buttons, inline in `index.html`.

Colours, radii and the accent come from the product's own tokens
(`web/src/theme/tokens.css`), so the site and the GUI read as one product. Every claim,
number and screenshot on the page comes from the repository's `README.md`.

## Preview it

```
cd website/public
python3 -m http.server 8000
```

Then open <http://127.0.0.1:8000/>. Links to `/docs/` will 404 locally: the documentation
site is a separate deployment (`mkdocs build`) that lives at `/docs/` on the same host.

## Deploy it

```
# edit TARGET at the top of deploy.sh first
./website/deploy.sh              # or: ./website/deploy.sh --dry-run
```

Anything after the script name is passed to `rsync`, so `--dry-run` shows what would
change. `--delete` removes files the site no longer has, but `docs` is excluded and is
therefore left alone on the server.

Nothing is generated at deploy time and there is no server-side code: any static host
works.

### What the server needs

- **MIME types.** `.html`, `.css`, `.png` and `.xml` are standard everywhere; make sure
  `.svg` is served as `image/svg+xml` (`favicon.svg`, `img/blocks.svg`). nginx's default
  `mime.types` already does.
- **Compression.** gzip or brotli for `text/html`, `text/css`, `image/svg+xml` and
  `application/xml`. The PNGs are already compressed; leave them alone.
- **Caching.** `index.html`: `Cache-Control: no-cache` (or `max-age=300`), so a redeploy
  is visible at once. `style.css`, `favicon.svg` and everything under `/img/`: they are
  not fingerprinted, so `Cache-Control: public, max-age=86400` is the safe ceiling — a
  year would strand readers on an old stylesheet.
- **HTTPS**, and a redirect from `http://` and from `www.`, because the canonical URL and
  the Open Graph tags say `https://tolquane.com/`.
- No headers are required beyond that; the page loads nothing from another origin.

## The social image

`public/img/og.png` (1200×630) is rendered from `og-source.html`. It only needs redoing if
that file changes:

```
PATH=/home/st4ck/.nvm/versions/node/v24.13.1/bin:$PATH \
PLAYWRIGHT_BROWSERS_PATH=/mnt/1T/home/st4ck/.cache/ms-playwright \
node -e '
const { chromium } = require("/mnt/1T/home/st4ck/Tolquane/web/node_modules/playwright");
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  await p.goto("file://" + process.cwd() + "/website/og-source.html");
  await p.screenshot({ path: "website/public/img/og.png" });
  await b.close();
})();'
```

## Keeping it true

The page repeats the repository `README.md`: the same promise, the same example, the same
runtime table, the same three measured speedups, the same liveness rules, the same
screenshots. When the README's numbers or screenshots change, change them here too — the
images in `public/img/` are copies of `docs/img/` and `docs/img/web/`.

## The documentation

`./website/deploy-docs.sh` builds the docs with `mkdocs.tolquane.yml` (the same site with `https://tolquane.com/docs/` as its base URL) and rsyncs them to `/docs/` on the server. The landing page's `deploy.sh` never touches that directory.
