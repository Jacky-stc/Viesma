import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageOps


ASSET_ROOT = Path(__file__).resolve().parent
SOURCE_ROOT = ASSET_ROOT.parents[1] / "art/source/characters/beginner"
BASE_BODY_SHA256 = "66d9c4ebeef10db49fd1495b23d5a091368f608d3e254a389ad0d3dc476f3bca"
IDLE_ATLAS_ID = "beginner-base-body-idle-atlas"
CANVAS = 384
ATLAS_MARGIN = 8
PIVOT = (192, 320)
IDLE_LIFTS = (0, 1, 3, 1)
IDLE_FRAME_TICKS = 6
IDLE_DRAW_ORDER = (
    "accessoryBack", "backHair", "weaponBack", "baseBody", "lowerClothing", "shoes",
    "upperClothing", "face", "frontHair", "upperClothingFront", "weaponFront", "bodyForeground", "accessoryFront",
)
FACE_ID = "beginner-face-01"
FACE_SHA256 = "771c19f33dd188690b46bf78b810fc22ea75a7f3a65324477df2761f3b752dbe"
FACE_SOURCE_PER_PIXEL = 1 / 0.108
# 鼻尖附近的原圖定位點。試貼以整片向右 5、向上 3 邏輯 px 做為初始構圖。
FACE_SOURCE_ORIGIN = (692, 680)
FACE_PLACEMENT = (5, -3)

# VF.3.2b 實圖量測點，已換算至邏輯畫布。rotationDeg 是原生朝左的軸向。
NEUTRAL_ATTACHMENTS = {
    "head": (196.2, 126.78, 0),
    "face": (151.99, 157.29, 0),
    "torso": (190.89, 233.78, 0),
    "mainHand": (226.71, 257.22, 61),
    "offHand": (159.5, 257.22, 129),
    "foot": (192, 320, 0),
    "nearSole": (213.44, 320, 0),
    "farSole": (168.79, 320, 0),
}


def smoothstep(value):
    value = max(0, min(1, value))
    return value * value * (3 - 2 * value)


def idle_lift(x, y, lift):
    # 肩線以上剛性平移。胸腹在 y=233–264 逐步收回，外側手掌及描邊留在剛性區。
    arm = max(smoothstep((173 - x) / 7), smoothstep((x - 219) / 7))
    torso = 1 - smoothstep((y - 233) / 31)
    palm = 1 if y <= 273 else 0
    return round(lift * ((1 - arm) * torso + arm * palm))


def lift_idle_frame(neutral, lift):
    frame = Image.new("RGBA", neutral.size)
    source, destination = neutral.load(), frame.load()
    left, top, right, bottom = neutral.getchannel("A").getbbox()
    for x in range(left, right):
        y = top
        dest = y - idle_lift(x, y, lift)
        while y < bottom:
            next_dest = y + 1 - idle_lift(x, y + 1, lift)
            if next_dest <= dest:
                raise ValueError("Idle transform would discard a source row")
            # 同一欄以最近原像素補齊新增列，避免混色、低 alpha 光暈及透明接縫。
            for row in range(dest, next_dest):
                destination[x, row] = source[x, y if row - dest <= next_dest - row else y + 1]
            y += 1
            dest = next_dest
    return frame


def verify_idle_frame(neutral, frame, lift):
    alpha = frame.getchannel("A")
    left, top, right, bottom = alpha.getbbox()
    if (top, bottom) != (64 - lift, 320) or min(left, top, CANVAS - right, CANVAS - bottom) < 8:
        raise ValueError("Idle frame violates the canvas, head lift, or foot baseline")
    if lift == 0 and neutral.tobytes() != frame.tobytes():
        raise ValueError("Idle frame 0 differs from the normalized source")
    if neutral.crop((0, 64, CANVAS, 212)).tobytes() != frame.crop((0, 64 - lift, CANVAS, 212 - lift)).tobytes():
        raise ValueError("Idle head pixels changed after translation")
    for box in ((0, 274, CANVAS, CANVAS), (173, 264, 220, 274)):
        if neutral.crop(box).tobytes() != frame.crop(box).tobytes():
            raise ValueError("Idle hips, legs or feet changed")
    for left, right in ((140, 167), (226, 255)):
        if neutral.crop((left, 240, right, 274)).tobytes() != frame.crop((left, 240 - lift, right, 274 - lift)).tobytes():
            raise ValueError("Idle palm pixels changed after translation")
    if not set(frame.getdata()).issubset(set(neutral.getdata())):
        raise ValueError("Idle frame introduces an RGBA value outside the normalized source")
    mask = alpha.point(lambda value: 255 if value >= 16 else 0)
    components = []
    for color in (0, 255):
        count = 0
        for y in range(CANVAS):
            for x in range(CANVAS):
                if mask.getpixel((x, y)) == color:
                    ImageDraw.floodfill(mask, (x, y), 128)
                    count += 1
        components.append(count)
    # 已驗收素體有一塊連通輪廓與一個閉合的臂下缺口。
    if components != [2, 1]:
        raise ValueError("Idle silhouette gained a cut or transparency hole")


def derive_idle(body_texture):
    neutral = Image.new("RGBA", (CANVAS, CANVAS))
    neutral.paste(body_texture, (PIVOT[0] - body_texture.width // 2, PIVOT[1] - body_texture.height))
    sheet = Image.new("RGBA", (CANVAS * len(IDLE_LIFTS), CANVAS))
    frames, poses = [], []
    for index, lift in enumerate(IDLE_LIFTS):
        frame = lift_idle_frame(neutral, lift)
        verify_idle_frame(neutral, frame, lift)
        frames.append(frame)
        sheet.paste(frame, (index * CANVAS, 0))
        poses.append({
            "index": index,
            "durationTicks": IDLE_FRAME_TICKS,
            "attachments": {
                name: {"x": x, "y": round(y - idle_lift(round(x), round(y), lift), 2), "rotationDeg": rotation}
                for name, (x, y, rotation) in NEUTRAL_ATTACHMENTS.items()
            },
            "drawOrder": list(IDLE_DRAW_ORDER),
            "layers": {"baseBody": {
                "atlasId": IDLE_ATLAS_ID,
                "rectPx": {
                    "x": index * CANVAS + ATLAS_MARGIN,
                    "y": ATLAS_MARGIN,
                    "width": CANVAS - 2 * ATLAS_MARGIN,
                    "height": CANVAS - 2 * ATLAS_MARGIN,
                },
                "offsetPx": {"x": ATLAS_MARGIN, "y": ATLAS_MARGIN},
            }},
        })
    return sheet, frames, {
        "schemaVersion": 1,
        "poseSetId": "beginner",
        "poseVersion": 1,
        "sourceFacing": "left",
        "originalSizePx": {"width": CANVAS, "height": CANVAS},
        "pivotPx": {"x": PIVOT[0], "y": PIVOT[1]},
        "worldUnitsPerPixel": 80 / 256,
        "clips": {"idle": {"loop": True, "frames": poses}},
    }


def derive_texture(master, height, foot_x=None):
    alpha = master.getchannel("A").point(lambda value: value if value >= 16 else 0)
    bounds = alpha.getbbox()
    if bounds is None:
        raise ValueError("Character master has no visible pixels")
    left, top, right, bottom = bounds
    if foot_x is None:
        sole_band = max(1, round((bottom - top) * 0.03))
        sole_left, _, sole_right, _ = alpha.crop((0, bottom - sole_band, master.width, bottom)).getbbox()
        foot_x = (sole_left + sole_right) / 2
    if not left <= foot_x <= right:
        raise ValueError("Foot anchor must be within the visible width")
    print(f"Visible bounds: {bounds}; foot anchor: ({foot_x:g}, {bottom})")
    master = master.copy()
    master.putalpha(alpha)

    # 讓圖框底邊中點對齊鞋底。用同一取樣比例計算圖框的寬和高。
    source_per_pixel = (bottom - top) / height
    half_width = max(foot_x - left, right - foot_x)
    width = math.ceil(2 * half_width / source_per_pixel)
    half_sample = width * source_per_pixel / 2
    pad_left = max(0, math.ceil(half_sample - foot_x))
    pad_right = max(0, math.ceil(foot_x + half_sample - master.width))
    if pad_left or pad_right:
        master = ImageOps.expand(master, (pad_left, 0, pad_right, 0), fill=(0, 0, 0, 0))
    center = foot_x + pad_left
    box = (center - half_sample, top, center + half_sample, bottom)
    return master.resize((width, height), Image.Resampling.LANCZOS, box=box)


def draw_idle_evidence(folder, frames, poses):
    folder.mkdir(parents=True, exist_ok=True)
    font = ImageFont.load_default(size=16)
    comparison = Image.new("RGBA", (CANVAS * 4, CANVAS + 38), "#263446")
    marked = comparison.copy()
    head_overlay = Image.new("RGB", (CANVAS, 190), "#263446")
    leg_diff = Image.new("RGB", (CANVAS * 4, 145), "#263446")
    head_neutral = frames[0].crop((0, 64, CANVAS, 212))
    legs_neutral = frames[0].crop((0, 274, CANVAS, CANVAS))
    colors = ("#ffffff", "#88d5f5", "#ff9782", "#acd694")
    for index, (frame, lift, pose, color) in enumerate(zip(frames, IDLE_LIFTS, poses, colors)):
        x = index * CANVAS
        comparison.alpha_composite(frame, (x, 32))
        marked.alpha_composite(frame, (x, 32))
        for panel in (comparison, marked):
            draw = ImageDraw.Draw(panel)
            draw.text((x + 12, 10), f"Frame {index}  |  y {-lift:+d} px", fill=color, font=font)
            draw.line((x + 16, 352, x + CANVAS - 16, 352), fill="#667b94")
        draw = ImageDraw.Draw(marked)
        for name, point in pose["attachments"].items():
            px, py = x + point["x"], 32 + point["y"]
            draw.ellipse((px - 2, py - 2, px + 2, py + 2), fill="#ffe070")
            side = -1 if name in ("face", "offHand", "farSole") else 1
            dy = 15 if name == "foot" else -4
            draw.line((px, py, px + side * 17, py + dy), fill="#ffe070")
            draw.text((px + side * 19, py + dy), name, fill="#ffeea6", font=font, anchor="lm" if side > 0 else "rm")
        head = frame.crop((0, 64 - lift, CANVAS, 212 - lift))
        difference = ImageChops.difference(head_neutral, head)
        mask = head.getchannel("A").point(lambda alpha: 255 if alpha >= 16 else 0)
        head_overlay.paste(color, (0, 32), mask)
        legs = frame.crop((0, 274, CANVAS, CANVAS))
        for channel in ImageChops.difference(legs_neutral, legs).split():
            if channel.getbbox():
                raise ValueError("Leg difference image was not empty")
        leg_diff.paste(legs, (x, 32), legs.getchannel("A"))
        ImageDraw.Draw(leg_diff).text((x + 10, 10), f"Frame {index} | 0 differing RGBA pixels below y=274", fill=color, font=font)
        if any(channel.getbbox() for channel in difference.split()):
            raise ValueError("Aligned head difference image was not empty")
    ImageDraw.Draw(head_overlay).text((12, 8), "Aligned head overlay | 0 differing RGBA pixels", fill="white", font=font)
    for name, image in (("frames", comparison), ("attachments", marked), ("head-overlay", head_overlay), ("leg-diff", leg_diff)):
        image.convert("RGB").save(folder / f"{name}.png", optimize=True)


def build_atlas(texture, sprite_id, render_height, pose=None):
    width, height = texture.size
    source = f"images/{sprite_id}.png"
    atlas_id = f"{sprite_id}-atlas"
    path = ASSET_ROOT / source
    texture.save(path, optimize=True)
    atlas = {
        "id": atlas_id,
        "type": "atlas",
        "source": source,
        "output": f"game-assets/{atlas_id}.png",
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "width": width,
        "height": height,
        "optionalInDevelopment": True,
        "rights": {
            "kind": "original",
            "creator": "Viesma",
            "license": "project-owned",
            "attribution": "Viesma · Beginner",
            "evidence": "provenance/beginner-character.md",
            "generator": "derive-beginner-character.py",
        },
        "sprites": [{
            "id": sprite_id,
            "type": "player",
            "renderWidth": round(render_height * width / height),
            "renderHeight": render_height,
            "clips": {
                "idle": {
                    "frames": [{"x": 0, "y": 0, "width": width, "height": height}],
                    "ticksPerFrame": 1,
                    "loop": False,
                },
            },
        }],
    }
    if pose:
        idle = pose["clips"]["idle"]
        sprite = atlas["sprites"][0]
        sprite["renderWidth"] = render_height
        sprite["idlePose"] = pose
        sprite["clips"]["idle"] = {
            "frames": [frame["layers"]["baseBody"]["rectPx"] for frame in idle["frames"]],
            "ticksPerFrame": IDLE_FRAME_TICKS,
            "loop": idle["loop"],
        }
    return atlas


def derive_face(evidence_dir):
    source = SOURCE_ROOT / "appearance/face/face-01/face-source.png"
    data = source.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != FACE_SHA256:
        raise ValueError("Face 01 source differs from the audited PNG")
    with Image.open(source) as image:
        original = image.copy()
    if original.mode != "RGBA" or original.size != (1536, 1024) or data[24:26] != bytes((8, 6)):
        raise ValueError("Expected the audited 1536 × 1024 RGBA face")
    alpha = original.getchannel("A")
    # 實色筆畫作為位置支撐。6 px 內保留原始 alpha，包含半透明描邊、光點與腮紅邊。
    coverage = alpha.point(lambda value: 255 if value >= 64 else 0).filter(ImageFilter.MaxFilter(13))
    clean_alpha = ImageChops.multiply(alpha, coverage)
    cleaned = Image.composite(original, Image.new("RGBA", original.size), clean_alpha.point(lambda value: 255 if value else 0))
    a_x, a_y, _ = NEUTRAL_ATTACHMENTS["face"]
    target = (a_x + FACE_PLACEMENT[0], a_y + FACE_PLACEMENT[1])
    logical = Image.new("RGBA", (CANVAS, CANVAS))
    support = clean_alpha.getbbox()
    if support is None:
        raise ValueError("Face 01 has no supported artwork")
    # 先換算成完整邏輯畫布的座標，再以相同來源倍率分別取樣 X/Y。
    sample = tuple(
        (math.floor if index < 2 else math.ceil)(
            target[index % 2] + (coordinate - FACE_SOURCE_ORIGIN[index % 2]) / FACE_SOURCE_PER_PIXEL
        ) + (-2 if index < 2 else 2)
        for index, coordinate in enumerate(support)
    )
    box = tuple(
        FACE_SOURCE_ORIGIN[index % 2] + (coordinate - target[index % 2]) * FACE_SOURCE_PER_PIXEL
        for index, coordinate in enumerate(sample)
    )
    normalized = cleaned.resize((sample[2] - sample[0], sample[3] - sample[1]), Image.Resampling.BOX, box=box)
    logical.paste(normalized, sample[:2])
    offset = logical.getchannel("A").getbbox()
    if offset is None or min(offset[0], offset[1], CANVAS - offset[2], CANVAS - offset[3]) < 8:
        raise ValueError("Face 01 violates the logical canvas margin")
    face = logical.crop(offset)
    with Image.open(ASSET_ROOT / "images/beginner-base-body-idle.png") as sheet:
        bodies = [sheet.crop((i * CANVAS, 0, (i + 1) * CANVAS, CANVAS)) for i in range(len(IDLE_LIFTS))]
    overhang = []
    for lift, body in zip(IDLE_LIFTS, bodies):
        placed_alpha = Image.new("L", logical.size)
        placed_alpha.paste(face.getchannel("A"), (offset[0], offset[1] - lift))
        outside = ImageChops.multiply(placed_alpha, body.getchannel("A").point(lambda value: 255 if value < 250 else 0))
        overhang.append(CANVAS ** 2 - outside.histogram()[0])
    if any(overhang):
        raise ValueError("The initial face overhangs the character silhouette")
    # 2 px 擠邊及 2 px 外側透明，圖框與邏輯 offset 各自記錄。
    padded = Image.new("RGBA", (face.width + 4, face.height + 4))
    padded.paste(face, (2, 2))
    for x, y, width, height, left, top in (
        (0, 0, 1, face.height, 0, 2), (face.width - 1, 0, 1, face.height, face.width + 2, 2),
        (0, 0, face.width, 1, 2, 0), (0, face.height - 1, face.width, 1, 2, face.height + 2),
    ):
        edge = face.crop((x, y, x + width, y + height))
        padded.paste(edge.resize((2 if width == 1 else width, 2 if height == 1 else height), Image.Resampling.NEAREST), (left, top))
    atlas = build_atlas(ImageOps.expand(padded, border=2), FACE_ID, round(face.height * 80 / 256))
    atlas["rights"]["attribution"] = "Viesma · Beginner Face 01"
    entry = atlas["sprites"][0]
    entry["renderWidth"] = round(face.width * 80 / 256)
    entry["clips"]["idle"]["frames"] = [{"x": 4, "y": 4, "width": face.width, "height": face.height}]
    entry["attachedFace"] = {
        "poseSetId": "beginner",
        "poseVersion": 1,
        "defaultCalibration": {"xPx": 0, "yPx": 0, "scale": 1},
        "offsetPx": {"x": offset[0], "y": offset[1]},
        "originPx": {"x": round(a_x - offset[0], 2), "y": round(a_y - offset[1], 2)},
    }
    if evidence_dir:
        draw_face_evidence(evidence_dir, original, cleaned, logical, bodies[0], digest, offset, overhang)
    return atlas


def draw_face_evidence(folder, original, cleaned, logical, body, digest, offset, overhang):
    folder.mkdir(parents=True, exist_ok=True)
    alpha = original.getchannel("A")
    clean_alpha = cleaned.getchannel("A")
    bins = ((0, 0), (1, 15), (16, 63), (64, 127), (128, 254), (255, 255))
    raw_counts = alpha.histogram()
    positive_gap = ImageChops.subtract(alpha, clean_alpha)
    report = {
        "sourceSha256": digest,
        "sourceSize": original.size,
        "mode": original.mode,
        "alphaHistogram": {f"{low}-{high}": sum(raw_counts[low:high + 1]) for low, high in bins},
        "maxAlpha": alpha.getextrema()[1],
        "allNonzeroBounds": alpha.getbbox(),
        "boundsAtAlpha16": alpha.point(lambda value: 255 if value >= 16 else 0).getbbox(),
        "supportedBounds": clean_alpha.getbbox(),
        "removedNonzeroPixels": clean_alpha.histogram()[0] - alpha.histogram()[0],
        "maxRemovedAlpha": positive_gap.getextrema()[1],
        "normalizedBounds": offset,
        "sourceScale": 1 / FACE_SOURCE_PER_PIXEL,
        "placementFromSourceOriginPx": FACE_PLACEMENT,
        "normalizedPixelsOutsideBodyAlpha250ByFrame": overhang,
    }
    font = ImageFont.load_default(size=16)
    compare = Image.new("RGB", (824, 574), "#253443")
    draw = ImageDraw.Draw(compare)
    for x, image, title in ((12, original, "Original"), (424, cleaned, "Supported alpha")):
        draw.text((x, 8), title + " / art on dark", font=font, fill="white")
        panel = Image.new("RGBA", (768, 464), "#263446")
        panel.alpha_composite(image.crop((384, 330, 1152, 794)))
        compare.paste(panel.resize((384, 232), Image.Resampling.BOX), (x, 32))
        draw.text((x, 278), "Full source / alpha x32 (clamped)", font=font, fill="white")
        amplified = image.getchannel("A").point(lambda value: min(255, value * 32))
        compare.paste(amplified.resize((384, 256), Image.Resampling.BOX), (x, 306))
    compare.save(folder / "source-alpha.png", optimize=True)

    composite = Image.new("RGB", (780, 338), "#263446")
    for x, overlay, title in ((8, None, "Base body / frame 0"), (396, logical, "Face 01 / initial placement")):
        panel = Image.new("RGBA", body.size, "#263446")
        panel.alpha_composite(body)
        if overlay is not None:
            panel.alpha_composite(overlay)
        view = panel.crop((103, 57, 290, 211))
        composite.paste(view.resize((374, 308), Image.Resampling.NEAREST), (x, 24))
        ImageDraw.Draw(composite).text((x, 3), title, font=font, fill="white")
    composite.save(folder / "base-composite.png", optimize=True)
    (folder / "source-audit.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


def update_character_manifest(atlases, enable_face_slot=False):
    path = ASSET_ROOT / "experimental-character.json"
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"schemaVersion": 1, "atlases": []}
    by_id = {entry["id"]: entry for entry in manifest["atlases"]}
    for entry in atlases:
        previous = by_id.get(entry["id"])
        if previous and entry["id"] == f"{FACE_ID}-atlas":
            saved = previous["sprites"][0]["attachedFace"].get("defaultCalibration")
            if saved is not None:
                entry["sprites"][0]["attachedFace"]["defaultCalibration"] = saved
        by_id[entry["id"]] = entry
    if enable_face_slot:
        idle = by_id[IDLE_ATLAS_ID]["sprites"][0]["idlePose"]["clips"]["idle"]
        for frame in idle["frames"]:
            frame["drawOrder"] = list(IDLE_DRAW_ORDER)
    manifest["atlases"] = list(by_id.values())
    encoded = json.dumps(manifest, indent=2, ensure_ascii=False)
    path.write_text(encoded + "\n", encoding="utf-8", newline="\n")


def main():
    parser = argparse.ArgumentParser(description="Derive the development atlases for Character Master and Base Body")
    parser.add_argument("--face-only", action="store_true", help="Derive Face 01 without regenerating body PNGs")
    parser.add_argument("--foot-x", type=float, help="Override the Character Master foot anchor X in source pixels")
    parser.add_argument("--evidence-dir", type=Path, help="Write audit comparison images to this directory")
    args = parser.parse_args()
    if args.face_only:
        update_character_manifest([derive_face(args.evidence_dir)], enable_face_slot=True)
        return

    base_body = SOURCE_ROOT / "base-body/base-body-idle.png"
    body_sha256 = hashlib.sha256(base_body.read_bytes()).hexdigest()
    print(f"Base Body SHA-256: {body_sha256}")
    if body_sha256 != BASE_BODY_SHA256:
        raise ValueError("Base Body source differs from the audited PNG")
    with Image.open(base_body) as body:
        body_texture = derive_texture(body, 256)
    sheet, idle_frames, pose = derive_idle(body_texture)
    if args.evidence_dir:
        draw_idle_evidence(args.evidence_dir, idle_frames, pose["clips"]["idle"]["frames"])

    character_master = SOURCE_ROOT / "character-master.png"
    print(f"Character Master SHA-256: {hashlib.sha256(character_master.read_bytes()).hexdigest()}")
    with Image.open(character_master) as master:
        master_texture = derive_texture(master.convert("RGBA"), 256, args.foot_x)

    update_character_manifest([
        build_atlas(master_texture, "beginner-static", 64),
        build_atlas(body_texture, "beginner-base-body", 80),
        build_atlas(sheet, "beginner-base-body-idle", round((CANVAS - 2 * ATLAS_MARGIN) * pose["worldUnitsPerPixel"]), pose),
    ])


if __name__ == "__main__":
    main()
