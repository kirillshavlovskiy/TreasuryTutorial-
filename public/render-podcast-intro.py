#!/usr/bin/env python3
"""Render Simple Sigma podcast intro: 3D spin around Z with X-tilt foreshortening."""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont

PUBLIC = Path(__file__).resolve().parent
LOGO = PUBLIC / "simple-sigma-logo.png"
OUT_DIR = PUBLIC / "intro-frames"
W, H = 1920, 1080
FPS = 30
DURATION = 10
N_FRAMES = FPS * DURATION
CARD = 300
TILT_X_DEG = 22.0


def make_background() -> Image.Image:
    img = Image.new("RGB", (W, H), (2, 6, 23))
    px = img.load()
    cx, cy = W / 2, H * 0.42
    for y in range(H):
        for x in range(0, W, 2):
            dx = (x - cx) / (W * 0.45)
            dy = (y - cy) / (H * 0.4)
            t = min(1.0, math.sqrt(dx * dx + dy * dy))
            r = int(2 + (30 - 2) * (1 - t) * 0.55)
            g = int(6 + (41 - 6) * (1 - t) * 0.55)
            b = int(23 + (59 - 23) * (1 - t) * 0.55)
            px[x, y] = (r, g, b)
            if x + 1 < W:
                px[x + 1, y] = (r, g, b)
    draw = ImageDraw.Draw(img, "RGBA")
    for x in range(0, W, 48):
        draw.line([(x, 0), (x, H)], fill=(56, 189, 248, 12))
    for y in range(0, H, 48):
        draw.line([(0, y), (W, y)], fill=(56, 189, 248, 12))
    return img


def load_font(size: int) -> ImageFont.ImageFont:
    for path in (
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ):
        try:
            return ImageFont.truetype(path, size=size)
        except OSError:
            continue
    return ImageFont.load_default()


def draw_formulas(base: Image.Image) -> None:
    draw = ImageDraw.Draw(base, "RGBA")
    font = load_font(22)
    color = (148, 163, 184, 120)
    items = [
        (80, 100, "H* = P x (1 + σ_P x Φ^-1(1 - Δr / r_OD))"),
        (1180, 160, "VaR95 = |pos| x σ x sqrt(21) x 1.645"),
        (100, 900, "Δr = r_USD - r_FCY"),
        (1400, 860, "I + J = 0"),
        (1200, 960, "CIP: r_f = r_USD + (F-S)/S"),
    ]
    for x, y, text in items:
        draw.text((x, y), text, font=font, fill=color)


def draw_brand(base: Image.Image) -> None:
    draw = ImageDraw.Draw(base)
    title = load_font(64)
    sub = load_font(20)
    t = "Simple Sigma"
    s = "TREASURY  ·  FX  ·  RISK EDUCATION"
    tb = draw.textbbox((0, 0), t, font=title)
    tw = tb[2] - tb[0]
    draw.text(((W - tw) / 2, 700), t, font=title, fill=(226, 232, 240))
    sb = draw.textbbox((0, 0), s, font=sub)
    sw = sb[2] - sb[0]
    draw.text(((W - sw) / 2, 780), s, font=sub, fill=(100, 116, 139))


def make_card(logo: Image.Image) -> Image.Image:
    size = CARD + 24
    card = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(card)
    draw.rounded_rectangle((4, 8, size - 2, size - 2), radius=32, fill=(226, 232, 240, 255))
    draw.rounded_rectangle((0, 0, size - 8, size - 8), radius=28, fill=(255, 255, 255, 255))
    lg = logo.copy()
    lg.thumbnail((int(CARD * 0.78), int(CARD * 0.78)), Image.Resampling.LANCZOS)
    lx = (size - 8 - lg.width) // 2
    ly = (size - 8 - lg.height) // 2
    card.paste(lg, (lx, ly), lg if lg.mode == "RGBA" else None)
    return card


def _solve_8(A: list[list[float]], B: list[float]) -> list[float]:
    """Gaussian elimination for 8×8 perspective system (no numpy)."""
    n = 8
    M = [A[i][:] + [B[i]] for i in range(n)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(M[r][col]))
        M[col], M[pivot] = M[pivot], M[col]
        div = M[col][col] or 1e-12
        for j in range(col, n + 1):
            M[col][j] /= div
        for row in range(n):
            if row == col:
                continue
            factor = M[row][col]
            for j in range(col, n + 1):
                M[row][j] -= factor * M[col][j]
    return [M[i][n] for i in range(n)]


def _perspective_coeffs(
    dest: tuple[tuple[float, float], ...],
    src: tuple[tuple[float, float], ...],
) -> list[float]:
    A: list[list[float]] = []
    B: list[float] = []
    for (xd, yd), (xs, ys) in zip(dest, src):
        A.append([xd, yd, 1, 0, 0, 0, -xs * xd, -xs * yd])
        B.append(xs)
        A.append([0, 0, 0, xd, yd, 1, -ys * xd, -ys * yd])
        B.append(ys)
    return _solve_8(A, B)


def rotate_z_tilt_x(card: Image.Image, z_deg: float, tilt_deg: float = TILT_X_DEG) -> Image.Image:
    """Rotate around Z, then X-tilt foreshortening + trapezoid (3D plate, not flat 2D)."""
    pad = int(max(card.size) * 0.45)
    canvas = Image.new("RGBA", (card.width + pad * 2, card.height + pad * 2), (0, 0, 0, 0))
    canvas.paste(card, (pad, pad), card)
    spun = canvas.rotate(-z_deg, resample=Image.Resampling.BICUBIC, expand=True)

    cos_t = abs(math.cos(math.radians(tilt_deg)))
    w, h = spun.size
    new_h = max(2, int(h * cos_t))
    squashed = spun.resize((w, new_h), Image.Resampling.LANCZOS)

    taper = 0.12
    top_w = int(w * (1 - taper))
    out_w, out_h = w, new_h
    dx0 = (out_w - top_w) / 2
    dx1 = (out_w + top_w) / 2
    src = ((0.0, 0.0), (float(w), 0.0), (float(w), float(new_h)), (0.0, float(new_h)))
    dst = ((dx0, 0.0), (dx1, 0.0), (float(out_w), float(out_h)), (0.0, float(out_h)))
    coeffs = _perspective_coeffs(dst, src)
    tilted = squashed.transform(
        (out_w, out_h),
        Image.Transform.PERSPECTIVE,
        coeffs,
        resample=Image.Resampling.BICUBIC,
    )

    composed = Image.new("RGBA", (out_w + 40, out_h + 40), (0, 0, 0, 0))
    blob = Image.new("RGBA", composed.size, (0, 0, 0, 0))
    bd = ImageDraw.Draw(blob)
    bd.ellipse((30, out_h // 2 + 10, out_w + 10, out_h + 30), fill=(0, 0, 0, 90))
    blob = blob.filter(ImageFilter.GaussianBlur(18))
    composed = Image.alpha_composite(composed, blob)
    composed.paste(tilted, (20, 0), tilted)
    return ImageEnhance.Brightness(composed).enhance(1.02)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("frame_*.png"):
        old.unlink()

    logo = Image.open(LOGO).convert("RGBA")
    card = make_card(logo)
    bg = make_background()
    draw_formulas(bg)
    draw_brand(bg)

    print(f"Rendering {N_FRAMES} frames @ {FPS}fps (3D rotateZ + tiltX)…")
    for i in range(N_FRAMES):
        z_deg = 360.0 * i / N_FRAMES
        plate = rotate_z_tilt_x(card, z_deg)
        frame = bg.copy().convert("RGBA")
        x = (W - plate.width) // 2
        y = int(H * 0.42 - plate.height / 2) - 40
        frame.paste(plate, (x, y), plate)
        frame.convert("RGB").save(OUT_DIR / f"frame_{i:04d}.png", optimize=False)
        if i % 30 == 0:
            print(f"  frame {i}/{N_FRAMES}  z={z_deg:.1f}°")

    print("Done →", OUT_DIR)


if __name__ == "__main__":
    main()
