#!/usr/bin/env python3
"""Draw the picture at the top of every email (EMAIL-01 round 1).

It reads "Who Made This?" (R-69, R-76): the app's submark beside the app's name
in Alan Sans ExtraBold, on the dark purple of the mail layout. 1200 x 300 px,
which is 600 px wide at 2x. The web's old header ("WAWUAfrica") is not touched.

Inputs, from the mobile repo (MOXN-AFRICA/wawu-wmt-mobile, read only):
  assets/brand/submark-sticker.png   the submark with its white keyline (dark surfaces)
  assets/fonts/AlanSans-ExtraBold.ttf
Colours are the mail layout's own (src/mail/mail.service.ts MAIL_COLORS) and the
app's accent (#9411C9, its lighter text tone #C368EA for the question mark).

Usage:
    python3 scripts/mail/render-email-header.py <mobile-repo-root> [out.png]
Writes src/mail/assets/email-header.png by default. Needs Pillow.
"""
from __future__ import annotations

import pathlib
import sys

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1200, 300
SS = 2  # draw at twice the size and shrink: smooth edges
PAGE = (0x0B, 0x0A, 0x0D)
DEEP = (0x29, 0x0D, 0x43)  # the brand's deep purple
ACCENT = (0x94, 0x11, 0xC9)
ACCENT_TEXT = (0xC3, 0x68, 0xEA)
WHITE = (0xFE, 0xFE, 0xFE)


def lerp(a: tuple[int, ...], b: tuple[int, ...], t: float) -> tuple[int, ...]:
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    mobile = pathlib.Path(sys.argv[1])
    out = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else (
        pathlib.Path(__file__).resolve().parents[2] / "src/mail/assets/email-header.png"
    )
    w, h = W * SS, H * SS

    # Ground: the page colour at the edges, the deep purple behind the name.
    ground = Image.new("RGB", (w, h), PAGE)
    px = ground.load()
    for y in range(h):
        for x in range(w):
            dx = (x - w * 0.5) / (w * 0.5)
            dy = (y - h * 0.5) / (h * 0.9)
            d = min(1.0, (dx * dx + dy * dy) ** 0.5)
            px[x, y] = lerp(DEEP, PAGE, d ** 1.4)

    # A soft purple glow behind the mark, as the app's welcome screen has.
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((w * 0.14, h * 0.05, w * 0.34, h * 0.95), fill=ACCENT)
    glow = glow.filter(ImageFilter.GaussianBlur(70 * SS))
    ground = Image.blend(ground, Image.composite(glow, ground, glow.convert("L")), 0.55)

    # The lockup: submark, a gap, the name.
    mark = Image.open(mobile / "assets/brand/submark-sticker.png").convert("RGBA")
    mark_h = 200 * SS
    mark = mark.resize((round(mark.width * mark_h / mark.height), mark_h), Image.LANCZOS)
    font = ImageFont.truetype(str(mobile / "assets/fonts/AlanSans-ExtraBold.ttf"), 92 * SS)
    words, dot = "Who Made This", "?"
    wb = font.getbbox(words)
    qb = font.getbbox(dot)
    tw = (wb[2] - wb[0]) + (qb[2] - qb[0]) + 4 * SS
    gap = 40 * SS
    total = mark.width + gap + tw
    x0 = (w - total) // 2
    ground.paste(mark, (x0, (h - mark.height) // 2), mark)

    d = ImageDraw.Draw(ground)
    tx = x0 + mark.width + gap - wb[0]
    # Centre the cap height on the mark's middle line.
    asc, desc = font.getmetrics()
    ty = (h - (asc + desc)) // 2 + 2 * SS
    d.text((tx, ty), words, font=font, fill=WHITE)
    d.text((tx + wb[2] + 4 * SS, ty), dot, font=font, fill=ACCENT_TEXT)

    img = ground.resize((W, H), Image.LANCZOS)
    # A palette keeps the file small; the dither hides banding in the gradient.
    img = img.quantize(colors=160, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out, optimize=True)
    print(f"wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
