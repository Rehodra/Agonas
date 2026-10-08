"""
extension/generate_icons.py
Generates the 4 PNG icon sizes for the extension from the bundled SVG source.
Requires: pip install cairosvg
Usage: python extension/generate_icons.py
       (or just: python generate_icons.py  when run from inside the extension/ folder)
"""

import pathlib

SVG_SOURCE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="16" fill="#0d1117"/>
  <polygon points="72,8 36,72 60,72 56,120 92,56 68,56" fill="#58a6ff"/>
</svg>"""

SIZES = [16, 32, 48, 128]
# When this file lives inside extension/, the icons/ folder is right next to it
OUT_DIR = pathlib.Path(__file__).resolve().parent / "icons"
SVG_FILE = OUT_DIR / "icon.svg"


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    SVG_FILE.write_text(SVG_SOURCE, encoding="utf-8")
    print(f"Wrote SVG: {SVG_FILE}")

    try:
        import cairosvg
        for size in SIZES:
            out = OUT_DIR / f"icon{size}.png"
            cairosvg.svg2png(url=str(SVG_FILE), write_to=str(out), output_width=size, output_height=size)
            print(f"  Generated: {out}")
        print("Done! All icons generated.")
    except ImportError:
        print("\ncairosvg not found. Install with:  pip install cairosvg")
        print("Or convert icons/icon.svg manually to:")
        for size in SIZES:
            print(f"  icons/icon{size}.png  ({size}x{size}px)")


if __name__ == "__main__":
    main()
