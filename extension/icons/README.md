# Icons

Place the following PNG files here (all generated from `icon.svg`):

| File | Size |
|---|---|
| `icon16.png` | 16×16 px |
| `icon32.png` | 32×32 px |
| `icon48.png` | 48×48 px |
| `icon128.png` | 128×128 px |

## Generate from SVG

**Option A — PowerShell (built-in on Windows, no extra installs):**
```powershell
powershell -ExecutionPolicy Bypass -File extension/generate_icons.ps1
```

**Option B — Python + cairosvg:**
```bash
pip install cairosvg
python extension/generate_icons.py
```

**Option C — Online converter:**
Open `icon.svg` in a browser, screenshot it, or use [SVG to PNG](https://svgtopng.com/) at 128×128 then resize.

**Option D — `npx`:**
```bash
npx svgexport icon.svg icon128.png 128:128
npx svgexport icon.svg icon48.png 48:48
npx svgexport icon.svg icon32.png 32:32
npx svgexport icon.svg icon16.png 16:16
```

> The extension will still load in Chrome without icons — it just shows a blank toolbar button until PNGs are present.
