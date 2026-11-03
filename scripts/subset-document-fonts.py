# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 yasha92443
"""Create transient font subsets solely for embedding in one local PDF."""
import argparse
import base64
import io
import json
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont


def chinese(point):
    return (0x3400 <= point <= 0x4DBF or 0x4E00 <= point <= 0x9FFF
            or 0xF900 <= point <= 0xFAFF or 0x3000 <= point <= 0x303F
            or 0xFF00 <= point <= 0xFFEF)


def document_font(source, family, points):
    font = TTFont(source, fontNumber=0)
    if font["name"].getDebugName(1) != family:
        raise ValueError(f"Expected {family} font")
    rights = font["OS/2"].fsType
    # The generated PDF supports editable document embedding, not restricted
    # or preview-only embedding. No embedding flag is altered.
    if rights & (0x0100 | 0x0200) or rights != 0 and not rights & 0x0008:
        raise ValueError(f"{family} does not permit supported document embedding")
    missing = sorted(points - set(font.getBestCmap()))
    if missing:
        raise ValueError(f"{family} lacks " + ", ".join(f"U+{p:04X}" for p in missing))
    options = subset.Options()
    options.layout_features = []
    options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
    options.recalc_timestamp = False
    options.drop_tables += ["DSIG"]
    cutter = subset.Subsetter(options=options)
    cutter.populate(unicodes=points)
    cutter.subset(font)
    data = io.BytesIO()
    font.save(data)
    cmap = font.getBestCmap()
    codepoints = sorted(cmap)
    meta = {
        "postscriptName": font["name"].getDebugName(6),
        "unitsPerEm": font["head"].unitsPerEm,
        "bbox": [getattr(font["head"], k) for k in ["xMin", "yMin", "xMax", "yMax"]],
        "ascent": font["hhea"].ascent,
        "descent": font["hhea"].descent,
        "capHeight": getattr(font["OS/2"], "sCapHeight", font["hhea"].ascent),
        "italicAngle": font["post"].italicAngle,
    }
    return {
        "base64": base64.b64encode(data.getvalue()).decode("ascii"),
        "meta": meta,
        "codepoints": codepoints,
        "glyphIds": [font.getGlyphID(cmap[p]) for p in codepoints],
        "advances": [font["hmtx"].metrics[cmap[p]][0] for p in codepoints],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for key in ["input", "output", "simsun", "times"]:
        parser.add_argument("--" + key, required=True, type=Path)
    args = parser.parse_args()
    text = json.loads(args.input.read_text(encoding="utf-8"))["text"]
    points = {ord(c) for c in text if c not in "\r\n\t"}
    if any(p > 65535 for p in points):
        raise ValueError("This PDF renderer does not support supplementary-plane characters")
    chinese_points = {p for p in points if chinese(p)} | {0x25A1}
    western_points = points - {p for p in points if chinese(p)} | {ord(c) for c in " 0123456789"}
    result = {
        "chinese": document_font(args.simsun, "SimSun", chinese_points),
        "western": document_font(args.times, "Times New Roman", western_points),
    }
    args.output.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")


if __name__ == "__main__":
    main()
