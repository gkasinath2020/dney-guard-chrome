# Store assets

Visual assets for the Chrome Web Store listing (not part of the extension package).

| File | Size | Use |
|------|------|-----|
| `dney-logo-512.png` | 512×512 | Master logo (store icon / promo) |
| `dney-logo-128.png` | 128×128 | Store icon (matches the bundled `icons/icon128.png`) |
| `dney-listing-1280x800.png` | 1280×800 | Required listing screenshot |

Brand: lucide `shield-check`, white on an indigo→violet gradient (`#6366f1`→`#7c3aed`),
matching the web app.

## Regenerate

Rendered from the HTML sources with headless Chrome, then downscaled with `sips`:

```bash
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
cd store-assets
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=512,512 --screenshot=logo-1024.png "file://$PWD/logo.html"
sips -z 512 512 logo-1024.png --out dney-logo-512.png
sips -z 128 128 logo-1024.png --out dney-logo-128.png
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
  --window-size=1280,800 --screenshot=hero-2x.png "file://$PWD/hero.html"
sips -z 800 1280 hero-2x.png --out dney-listing-1280x800.png
rm -f logo-1024.png hero-2x.png
```
