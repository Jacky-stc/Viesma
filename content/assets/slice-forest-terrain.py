"""從指定的原圖座標產出 VF.2 圖集、登錄和稽核接觸表。"""

import hashlib
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


assets = Path(__file__).resolve().parent
root = assets.parents[1]
slices = json.loads((assets / "forest-terrain-slices.json").read_text(encoding="utf-8"))
source = root / slices["source"]
if hashlib.sha256(source.read_bytes()).hexdigest() != slices["sourceSha256"]:
    raise ValueError("Forest terrain source digest disagrees with the slicing manifest")
original = Image.open(source)


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def extrude(tile, border):
    extended = Image.new("RGBA", (tile.width + 2 * border, tile.height + 2 * border))
    for y in range(extended.height):
        for x in range(extended.width):
            source_x = min(tile.width - 1, max(0, x - border))
            source_y = min(tile.height - 1, max(0, y - border))
            extended.putpixel((x, y), tile.getpixel((source_x, source_y)))
    return extended


def mix(first, second, weight):
    return tuple(round(a * (1 - weight) + b * weight) for a, b in zip(first, second))


def close_repeat(tile, width=3):
    for y in range(tile.height):
        left = tile.getpixel((0, y))
        right = tile.getpixel((tile.width - 1, y))
        edge = mix(left, right, 0.5)
        for distance in range(width):
            for x in (distance, tile.width - 1 - distance):
                original_pixel = tile.getpixel((x, y))
                tile.putpixel((x, y), mix(original_pixel, edge, 1 - distance / width))
    return tile


def join_cap(tile, middle, on_left, width=3):
    join = middle.width - 1 if on_left else 0
    for y in range(tile.height):
        edge = middle.getpixel((join, y))
        for distance in range(width):
            x = tile.width - 1 - distance if on_left else distance
            original_pixel = tile.getpixel((x, y))
            tile.putpixel((x, y), mix(original_pixel, edge, 1 - distance / width))


tile_size = slices["tilePixels"]
world_size = slices["tileWorldUnits"]
columns = slices["columns"]
border = slices["extrusion"]
step = tile_size + border * 2
tiles = slices["tiles"]
if len(tiles) % columns:
    raise ValueError("Complete the last atlas row")
atlas = Image.new("RGBA", (columns * step, len(tiles) // columns * step))
runtime_tiles = {}
for piece in tiles:
    patch = original.crop(piece["crop"])
    if patch.width != patch.height:
        raise ValueError(f"Expected a square terrain crop: {piece['id']}")
    runtime_tiles[piece["id"]] = patch.resize((tile_size, tile_size), Image.Resampling.LANCZOS)
for family in ("ground", "platform"):
    middle = close_repeat(runtime_tiles[f"forest-{family}-middle"])
    join_cap(runtime_tiles[f"forest-{family}-left"], middle, True)
    join_cap(runtime_tiles[f"forest-{family}-right"], middle, False)
soil = close_repeat(runtime_tiles["forest-soil"])
soil = close_repeat(soil.transpose(Image.Transpose.TRANSPOSE)).transpose(Image.Transpose.TRANSPOSE)
runtime_tiles["forest-soil"] = soil
join_cap(runtime_tiles["forest-bottom-left"], soil, True)
join_cap(runtime_tiles["forest-bottom-right"], soil, False)

sprites = []
for index, piece in enumerate(tiles):
    x, y = (index % columns) * step, (index // columns) * step
    atlas.paste(extrude(runtime_tiles[piece["id"]], border), (x, y))
    frame = dict(x=x + border, y=y + border, width=tile_size, height=tile_size)
    sprites.append(dict(id=piece["id"], type="tile", renderWidth=world_size, renderHeight=world_size,
                        clips={"idle": dict(frames=[frame], ticksPerFrame=1, loop=True)}))

atlas_path = assets / "images/forest-terrain-atlas.png"
atlas.save(atlas_path, optimize=True)
write_json(assets / "experimental-terrain.json", dict(schemaVersion=1, atlases=[dict(
    id="forest-terrain-atlas", type="atlas", source="images/forest-terrain-atlas.png",
    output="game-assets/forest-terrain-atlas.png", sha256=hashlib.sha256(atlas_path.read_bytes()).hexdigest(),
    width=atlas.width, height=atlas.height, optionalInDevelopment=True,
    rights=dict(kind="original", license="project-owned", creator="Viesma 專案擁有者",
                attribution="Viesma · Forest Entrance", evidence="provenance/forest-entrance.md",
                generator="slice-forest-terrain.py"),
    sprites=sprites,
)]))
write_json(assets / "images/forest-terrain.tsj", {
    "type": "tileset", "version": "1.10", "tiledversion": "1.10.2", "name": "forest-terrain",
    "image": atlas_path.name, "imagewidth": atlas.width, "imageheight": atlas.height,
    "tilewidth": tile_size, "tileheight": tile_size, "columns": columns, "tilecount": len(tiles),
    "margin": border, "spacing": border * 2,
})

# 稽核表同時比對每片原圖、32px 與 64px 等比縮圖。裝飾候選只顯示原圖。
pieces = tiles + slices["auditOnly"]
sheet = Image.new("RGB", (1240, 900), "#20222a")
draw = ImageDraw.Draw(sheet)
title = ImageFont.load_default(size=28)
label = ImageFont.load_default(size=15)
draw.text((22, 15), "VF.2 Forest Entrance | terrain slicing", font=title, fill="#fcdfac")
draw.text((22, 55), "Runtime slots show source crop / 32 px runtime / 64 px comparison. Other slots are audit candidates.",
          font=label, fill="white")
for index, piece in enumerate(pieces):
    column, row = index % 4, index // 4
    x, y = 20 + column * 305, 94 + row * 197
    patch = original.crop(piece["crop"])
    alpha = patch.getchannel("A")
    bounds = alpha.point(lambda value: 255 if value >= 16 else 0).getbbox()
    draw.text((x, y), piece["id"], font=label, fill="#fcdfac")
    draw.text((x, y + 24), "crop " + ", ".join(map(str, piece["crop"])), font=label, fill="white")
    draw.text((x, y + 45), "alpha >=16 " + ", ".join(map(str, bounds)), font=label, fill="white")
    samples = [patch.copy()]
    if index < len(tiles):
        samples.append(runtime_tiles[piece["id"]].resize((88, 88), Image.Resampling.NEAREST))
        samples.append(patch.resize((64, 64), Image.Resampling.LANCZOS).resize((88, 88), Image.Resampling.NEAREST))
    for sample_index, sample in enumerate(samples):
        sample.thumbnail((265, 106) if len(samples) == 1 else (88, 88), Image.Resampling.LANCZOS)
        left = x + 93 * sample_index
        draw.rectangle((left, y + 68, left + sample.width - 1, y + 67 + sample.height), fill="#4e5660")
        sheet.paste(sample, (left, y + 68), sample)

output = root / "docs/evidence/vf2"
output.mkdir(parents=True, exist_ok=True)
sheet.save(output / "terrain-contact-sheet.png", optimize=True)
