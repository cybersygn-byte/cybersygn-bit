#!/usr/bin/env python3
"""Generate CyberSygn PWA install icons.

Composites the white brand mark onto an opaque navy background at the sizes a
progressive web app + iOS home screen expect. Re-run any time the mark changes.

Outputs (web/brand/):
  icon-192.png            any-purpose, 192x192
  icon-512.png            any-purpose, 512x512
  icon-maskable-512.png   maskable (extra safe-zone padding), 512x512
  icon-apple-180.png      opaque apple-touch-icon, 180x180
"""
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
BRAND = os.path.join(HERE, "..", "web", "brand")
NAVY = (1, 20, 52, 255)  # #011434
MARK = os.path.join(BRAND, "mark-white@2x.png")


def build(size, mark_ratio, out):
    canvas = Image.new("RGBA", (size, size), NAVY)
    mark = Image.open(MARK).convert("RGBA")
    target = int(size * mark_ratio)
    mark = mark.resize((target, target), Image.LANCZOS)
    off = (size - target) // 2
    canvas.alpha_composite(mark, (off, off))
    canvas = canvas.convert("RGB")  # opaque, no alpha corners
    canvas.save(os.path.join(BRAND, out), "PNG")
    print("  wrote web/brand/%s (%dx%d)" % (out, size, size))


if __name__ == "__main__":
    build(192, 0.66, "icon-192.png")
    build(512, 0.66, "icon-512.png")
    # Maskable: keep the mark inside the ~80% safe circle, so pad more.
    build(512, 0.52, "icon-maskable-512.png")
    build(180, 0.66, "icon-apple-180.png")
    print("done.")
