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
    """1200x630 social-sharing card: the cinematic key visual (a contract in
    navy space with a cyan light sweep, og-bg.jpg) with the white wordmark and
    a tagline set into the lower-left over a soft scrim so it stays legible."""
    W, H = 1200, 630
    ACCENT = (0, 203, 246)
    NAVY = (1, 20, 52)

    bg_path = BRAND_DIR / 'og-bg.jpg'
    if bg_path.exists():
        card = Image.open(bg_path).convert('RGBA').resize((W, H), Image.LANCZOS)
    else:
        # Fallback to a solid navy field if the key visual is missing.
        card = Image.new('RGBA', (W, H), NAVY + (255,))

    # Vertical navy scrim, darkest toward the bottom, to seat the wordmark.
    scrim = Image.new('L', (W, H), 0)
    sd = ImageDraw.Draw(scrim)
    for i in range(H):
        sd.line([(0, i), (W, i)], fill=int(150 * (i / H) ** 1.6))
    card = Image.composite(Image.new('RGBA', (W, H), NAVY + (255,)), card, scrim)

    draw = ImageDraw.Draw(card)

    # White wordmark, lower-left.
    lockup = Image.open(BRAND_DIR / 'lockup-white.png').convert('RGBA')
    target_w = 430
    lw, lh = lockup.size
    new_h = int(round(lh * target_w / lw))
    lockup = lockup.resize((target_w, new_h), Image.LANCZOS)
    lx = 70
    ly = H - new_h - 132
    card.paste(lockup, (lx, ly), lockup)

    # Cyan accent rule + tagline beneath the wordmark.
    ry = ly + new_h + 34
    draw.rectangle([lx, ry, lx + 190, ry + 4], fill=ACCENT + (255,))
    tagline = 'AI finds every field. You just hit send.'
    font = None
    for path in ['/System/Library/Fonts/Supplemental/Arial.ttf',
                 '/System/Library/Fonts/Helvetica.ttc',
                 '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']:
        try:
            font = ImageFont.truetype(path, 30)
            break
        except Exception:
            pass
    if font is None:
        font = ImageFont.load_default()
    draw.text((lx, ry + 22), tagline, fill=(235, 245, 255, 240), font=font)

    card.convert('RGB').save(out_path, 'PNG', optimize=True)


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
