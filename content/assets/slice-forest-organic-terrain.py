"""以固定座標與接點生成 VF.2.1b 圖集，不寫入原圖。"""

import hashlib
import json
from pathlib import Path

from PIL import Image


ASSETS = Path(__file__).resolve().parent
SOURCE = ASSETS.parents[1] / "art/source/environments/forest-entrance/organic-terrain"
LAYOUT = ASSETS.parents[1] / "apps/client/src/rendering/forest-organic-terrain-slices.json"
METADATA = json.loads(LAYOUT.read_text(encoding="utf-8"))
POSITIONS = ("left", "middle", "right")
EXTRUSION = 2


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def weighted_pixel(pixels, weights):
    # 使用預乘 alpha 混合，透明側的 RGB 不會污染根系與土層邊緣。
    alpha = sum(pixel[3] * weight for pixel, weight in zip(pixels, weights))
    if round(alpha) == 0:
        return (0, 0, 0, 0)
    channels = tuple(
        round(sum(pixel[c] * pixel[3] * weight for pixel, weight in zip(pixels, weights)) / alpha)
        for c in range(3)
    )
    return (*channels, round(alpha))


def prepare_family(family, originals):
    images = {}
    anchors = {}
    for side in POSITIONS:
        part = family[side]
        region = part["region"]
        x0, y0, x1, y1 = region["x0"], region["y0"], region["x1"], region["y1"]
        source = originals[part["source"]]
        if not (0 <= x0 < x1 <= source.width and 0 <= y0 < part["surfaceY"] < y1 <= source.height):
            raise ValueError(f"Invalid source region or surface anchor: {part}")
        if (x1 - x0) % 2 or (y1 - y0) % 2 or (part["surfaceY"] - y0) % 2:
            raise ValueError(f"Region and anchor must align to half-resolution pixels: {part}")
        image = source.crop((x0, y0, x1, y1))
        image.putalpha(image.getchannel("A").point(lambda alpha: alpha if alpha >= 12 else 0))
        images[side] = image.resize((image.width // 2, image.height // 2), Image.Resampling.LANCZOS)
        anchors[side] = (part["surfaceY"] - y0) // 2

    ends = [(images[side], anchors[side], sign) for side, sign in (
        ("left", -1), ("middle", 1), ("middle", -1), ("right", 1)
    )]
    band = family["seamPixels"]
    transparent = (0, 0, 0, 0)
    for offset in range(-max(anchors.values()), max(image.height - anchor for image, anchor, _ in ends)):
        original = [
            image.getpixel((0 if sign > 0 else image.width - 1, anchor + offset))
            if 0 <= anchor + offset < image.height else transparent
            for image, anchor, sign in ends
        ]
        # 同一組接點也讓短平台直接合併兩端，並讓中段首尾循環。
        seam = weighted_pixel(original, (0.25,) * 4)
        if any(seam) and not all(0 <= anchor + offset < image.height for image, anchor, _ in ends):
            raise ValueError("Seam must be transparent outside all mating frames")
        if 0 <= offset <= band and seam[3] < 240:
            raise ValueError("The seam must keep the walkable surface opaque")
        for image, anchor, sign in ends:
            y = anchor + offset
            if not 0 <= y < image.height:
                continue
            edge_x = 0 if sign > 0 else image.width - 1
            for distance in range(band):
                x = edge_x + distance * sign
                weight = (1 - distance / band) ** 2
                image.putpixel((x, y), weighted_pixel((image.getpixel((x, y)), seam), (1 - weight, weight)))
    return images


def extrude(image):
    border = EXTRUSION
    w, h = image.size
    padded = Image.new("RGBA", (w + border * 2, h + border * 2))
    padded.paste(image, (border, border))
    padded.paste(image.crop((0, 0, 1, h)).resize((border, h)), (0, border))
    padded.paste(image.crop((w - 1, 0, w, h)).resize((border, h)), (w + border, border))
    padded.paste(padded.crop((0, border, padded.width, border + 1)).resize((padded.width, border)), (0, 0))
    padded.paste(padded.crop((0, h + border - 1, padded.width, h + border)).resize((padded.width, border)), (0, h + border))
    return padded


def build_atlas():
    originals = {}
    for name, expected in METADATA["sources"].items():
        path = SOURCE / f"{name}.png"
        if sha256(path) != expected:
            raise ValueError(f"Source digest disagrees with the reviewed metadata: {path}")
        with Image.open(path) as source:
            if source.mode != "RGBA":
                raise ValueError(f"Expected an RGBA source: {path}")
            originals[name] = source.copy()

    patches = {}
    for name in ("ground", "thick", "thin"):
        for side, image in prepare_family(METADATA[name], originals).items():
            patches[(name, side)] = extrude(image)

    rows = (
        (("ground", "left"), ("ground", "right"), ("thick", "left"), ("thick", "right")),
        (("ground", "middle"), ("thick", "middle")),
        (("thin", "left"), ("thin", "middle"), ("thin", "right")),
    )
    widths = [sum(patches[key].width for key in row) for row in rows]
    heights = [max(patches[key].height for key in row) for row in rows]
    atlas = Image.new("RGBA", (max(widths), sum(heights)))
    sprites = []
    y = 0
    for row, height in zip(rows, heights):
        x = 0
        for name, side in row:
            patch = patches[(name, side)]
            atlas.paste(patch, (x, y))
            w, h = patch.width - EXTRUSION * 2, patch.height - EXTRUSION * 2
            frame = dict(x=x + EXTRUSION, y=y + EXTRUSION, width=w, height=h)
            scale = METADATA[name]["worldUnitsPerSourcePixel"] * 2
            sprites.append(dict(
                id=f"forest-organic-{name}-{side}", type="tile",
                renderWidth=round(w * scale), renderHeight=round(h * scale),
                clips={"idle": dict(frames=[frame], ticksPerFrame=1, loop=True)},
            ))
            x += patch.width
        y += height

    path = ASSETS / "images/forest-organic-terrain-atlas.png"
    atlas.save(path, optimize=True)
    manifest = dict(schemaVersion=1, atlases=[dict(
        id="forest-organic-terrain-atlas", type="atlas", source=f"images/{path.name}",
        output=f"game-assets/{path.name}", sha256=sha256(path),
        width=atlas.width, height=atlas.height, optionalInDevelopment=True,
        rights=dict(kind="original", license="project-owned", creator="Viesma 專案擁有者",
                    attribution="Viesma · Forest Entrance", evidence="provenance/forest-entrance.md",
                    generator="slice-forest-organic-terrain.py"),
        sprites=sprites,
    )])
    (ASSETS / "experimental-organic-terrain.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )


if __name__ == "__main__":
    build_atlas()
