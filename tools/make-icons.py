#!/usr/bin/env python3
"""Generate the PWA icons for Geofence Beep.

Produces:
  icons/icon-192.png          square, full bleed
  icons/icon-512.png          square, full bleed
  icons/icon-maskable-512.png artwork shrunk into the 80% safe zone
  icons/favicon.png           64x64

Run with:  python3 tools/make-icons.py
"""

import math
import os
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "icons")

BG_TOP = (28, 45, 78)
BG_BOTTOM = (9, 15, 28)
ACCENT = (79, 140, 255)
ACCENT_SOFT = (79, 140, 255, 90)
ORANGE = (255, 138, 61)
WHITE = (255, 255, 255)


def gradient(size, top=BG_TOP, bottom=BG_BOTTOM):
    """Vertical gradient background."""
    img = Image.new("RGB", (1, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        px[0, y] = tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3))
    return img.resize((size, size), Image.BILINEAR)


def pin_points(cx, cy, r, tip_y):
    """Polygon points for a map-pin: circular head with tangent lines to a tip."""
    pc = math.hypot(cx - cx, tip_y - cy)
    alpha = math.asin(r / pc)
    beta = math.atan2(tip_y - cy, 0)
    # angles (measured from the centre, y down) of the two tangent points
    a_right = beta + alpha
    a_left = math.pi - alpha

    pts = []
    # arc over the top of the circle, from left tangent round to right tangent
    steps = 64
    for i in range(steps + 1):
        t = i / steps
        ang = a_left + (a_right - a_left + 2 * math.pi) * t
        # keep the arc on the upper side of the circle
        ang = a_left + ((a_right + 2 * math.pi) - a_left) * t
        if ang > a_right + 2 * math.pi:
            ang = a_right + 2 * math.pi
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    pts.append((cx, tip_y))
    return pts


def draw_artwork(size):
    """The icon artwork on a transparent canvas."""
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    s = size / 512.0

    # --- geofence rings ------------------------------------------------
    cx = cy = 256 * s
    for radius, alpha, width in ((196, 46, 5), (150, 70, 6), (104, 110, 7)):
        r = radius * s
        d.ellipse(
            [cx - r, cy - r, cx + r, cy + r],
            outline=ACCENT + (alpha,),
            width=max(1, int(width * s)),
        )

    # --- sound waves (top right) --------------------------------------
    wave_c = (398 * s, 128 * s)
    for radius, alpha in ((36, 200), (60, 140), (84, 90)):
        r = radius * s
        d.arc(
            [wave_c[0] - r, wave_c[1] - r, wave_c[0] + r, wave_c[1] + r],
            start=-72,
            end=72,
            fill=ACCENT + (alpha,),
            width=max(1, int(6 * s)),
        )

    # --- the pin --------------------------------------------------------
    pts = pin_points(cx, 236 * s, 74 * s, 404 * s)
    d.polygon(pts, fill=ORANGE)

    # highlight on the pin head
    d.ellipse(
        [cx - 74 * s, 236 * s - 74 * s, cx + 74 * s, 236 * s + 74 * s],
        fill=ORANGE,
    )
    # punch the hole
    hole = 30 * s
    d.ellipse([cx - hole, 236 * s - hole, cx + hole, 236 * s + hole], fill=BG_BOTTOM + (255,))

    # inner dot
    dot = 11 * s
    d.ellipse([cx - dot, 236 * s - dot, cx + dot, 236 * s + dot], fill=WHITE + (235,))

    # soft glow behind the pin
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([cx - 150 * s, cy - 150 * s, cx + 150 * s, cy + 150 * s], fill=ORANGE + (55,))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=int(28 * s)))
    layer = Image.alpha_composite(glow, layer)

    return layer


def build(size, maskable=False, filename="icon.png"):
    bg = gradient(size).convert("RGBA")

    art = draw_artwork(size)
    if maskable:
        # Shrink the artwork into the inner 80% safe zone of the icon.
        safe = int(size * 0.62)
        art = art.resize((safe, safe), Image.LANCZOS)
        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        canvas.paste(art, ((size - safe) // 2, (size - safe) // 2), art)
        art = canvas

    img = Image.alpha_composite(bg, art)
    path = os.path.join(OUT, filename)
    img.save(path, "PNG", optimize=True)
    print(f"  {filename}  {size}x{size}  ({os.path.getsize(path) // 1024} KB)")


def build_favicon(size=64):
    img = Image.open(os.path.join(OUT, "icon-192.png")).convert("RGBA")
    img = img.resize((size, size), Image.LANCZOS)
    path = os.path.join(OUT, "favicon.png")
    img.save(path, "PNG", optimize=True)
    print(f"  favicon.png  {size}x{size}")


def main():
    os.makedirs(OUT, exist_ok=True)
    print("Generating icons...")
    build(192, False, "icon-192.png")
    build(512, False, "icon-512.png")
    build(512, True, "icon-maskable-512.png")
    build_favicon(64)
    print("Done.")


if __name__ == "__main__":
    main()
