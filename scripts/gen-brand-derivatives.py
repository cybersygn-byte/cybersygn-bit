#!/usr/bin/env python3
"""
Generate the web-ready set of brand assets from the master logos.

Inputs (must already exist):
  web/brand/mark-navy.png
  web/brand/mark-white.png
  web/brand/lockup-navy.png
  web/brand/lockup-white.png

Outputs:
  web/brand/lockup-navy@2x.png      (480px wide, ~120px display)
  web/brand/lockup-white@2x.png
  web/brand/mark-navy@2x.png        (128px square, ~64px display)
  web/brand/mark-white@2x.png
  web/brand/favicon-16.png
  web/brand/favicon-32.png
  web/brand/favicon-180.png         (apple-touch-icon)
  web/brand/favicon.ico             (multi-resolution)
  web/brand/og-image.png            (1200x630 for social sharing)

Idempotent. Safe to rerun.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
BRAND_DIR = ROOT / 'web' / 'brand'

# Master source colors derived from the actual logo pixels.
NAVY = (1, 20, 52)
CYAN = (0, 203, 246)


def resize_keep_alpha(src_path, target_width):
    """Resize a PNG keeping alpha and aspect ratio."""
    img = Image.open(src_path).convert('RGBA')
    w, h = img.size
    ratio = target_width / w
    target_h = int(round(h * ratio))
    return img.resize((target_width, target_h), Image.LANCZOS)


def make_square(img, size, padding=0.12):
    """Take a logo image and center it on a transparent square canvas
    with the given proportional padding. Used to produce favicon
    sources from the tall mark."""
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    # Fit the logo into a smaller box inside the canvas.
    inner = int(size * (1 - 2 * padding))
    w, h = img.size
    scale = min(inner / w, inner / h)
    new_w = int(round(w * scale))
    new_h = int(round(h * scale))
    resized = img.resize((new_w, new_h), Image.LANCZOS)
    x = (size - new_w) // 2
    y = (size - new_h) // 2
    canvas.paste(resized, (x, y), resized)
    return canvas


def make_og_image(lockup_path, out_path):
    """1200x630 social-sharing card. Lockup centered with a thin
    accent rule below."""
    W, H = 1200, 630
    canvas = Image.new('RGBA', (W, H), (1, 20, 52, 255))   # solid navy background

    # Place the white lockup centered with a max width of 720px.
    lockup = Image.open(BRAND_DIR / 'lockup-white.png').convert('RGBA')
    max_w = 720
    lw, lh = lockup.size
    scale = max_w / lw
    new_w = max_w
    new_h = int(round(lh * scale))
    resized = lockup.resize((new_w, new_h), Image.LANCZOS)
    x = (W - new_w) // 2
    y = (H - new_h) // 2 - 30
    canvas.paste(resized, (x, y), resized)

    # Accent rule beneath
    rule_y = y + new_h + 40
    rule_w = 240
    rule_x = (W - rule_w) // 2
    draw = ImageDraw.Draw(canvas)
    draw.rectangle([rule_x, rule_y, rule_x + rule_w, rule_y + 3],
                   fill=(0, 203, 246, 255))

    # Tagline below the rule. Use the default PIL font (small but
    # readable); the OG card is for social previews so finesse is
    # secondary to "the wordmark is recognizable at thumbnail size."
    tagline = 'Sign documents.  Faster.'
    try:
        # Try to use a system font for a nicer rendering
        font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 28)
    except Exception:
        font = ImageFont.load_default()
    bbox = draw.textbbox((0, 0), tagline, font=font)
    text_w = bbox[2] - bbox[0]
    draw.text(((W - text_w) // 2, rule_y + 24), tagline,
              fill=(254, 254, 254, 220), font=font)

    canvas.save(out_path, 'PNG', optimize=True)


def main():
    # 1. Resized lockups for masthead.
    for color in ['navy', 'white']:
        src = BRAND_DIR / f'lockup-{color}.png'
        resized = resize_keep_alpha(src, 480)
        out = BRAND_DIR / f'lockup-{color}@2x.png'
        resized.save(out, 'PNG', optimize=True)
        print(f'  wrote {out.name}  ({resized.size[0]}x{resized.size[1]}, {out.stat().st_size}B)')

    # 2. Resized marks (square framing for app-icon and small UI).
    for color in ['navy', 'white']:
        src = BRAND_DIR / f'mark-{color}.png'
        master = Image.open(src).convert('RGBA')
        # 256 sq master for derivative work; 128 sq @2x display.
        sq256 = make_square(master, 256, padding=0.08)
        sq256.save(BRAND_DIR / f'mark-{color}@2x.png', 'PNG', optimize=True)
        print(f'  wrote mark-{color}@2x.png  (256x256)')

    # 3. Favicons. Always use navy mark on transparent.
    master_navy = Image.open(BRAND_DIR / 'mark-navy.png').convert('RGBA')
    for size in [16, 32, 180]:
        ico = make_square(master_navy, size, padding=0.08)
        ico.save(BRAND_DIR / f'favicon-{size}.png', 'PNG', optimize=True)
        print(f'  wrote favicon-{size}.png')

    # 4. Multi-resolution .ico
    ico_sizes = [(16, 16), (32, 32), (48, 48)]
    ico_imgs = [make_square(master_navy, s[0], padding=0.08) for s in ico_sizes]
    ico_imgs[0].save(BRAND_DIR / 'favicon.ico',
                     format='ICO', sizes=ico_sizes)
    print(f'  wrote favicon.ico  (16+32+48)')

    # 5. OG image
    og = BRAND_DIR / 'og-image.png'
    make_og_image(BRAND_DIR / 'lockup-white.png', og)
    print(f'  wrote og-image.png  (1200x630, {og.stat().st_size}B)')


if __name__ == '__main__':
    main()
