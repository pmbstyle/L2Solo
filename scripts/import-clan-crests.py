#!/usr/bin/env python3
"""Download and normalize the L2TopZone crest gallery for the C4 client."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from io import BytesIO
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_ROOT = ROOT / "data" / "crests"
SOURCE_ROOT = ROOT / "tmp" / "crest-import" / "source"
SOURCE_URL = "https://l2topzone.com/crests"
CDN_ROOT = "https://cdn.l2topzone.com"


def download(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "L2Node crest importer"})
    with urllib.request.urlopen(request, timeout=30) as response:
        return response.read()


def save_source(kind: str, index: int, raw: bytes) -> Path:
    SOURCE_ROOT.mkdir(parents=True, exist_ok=True)
    path = SOURCE_ROOT / f"{kind}-{index}.jpg"
    path.write_bytes(raw)
    return path


def normalize_image(kind: str, source: Path) -> Image.Image:
    image = Image.open(source).convert("RGB")
    if kind == "clan":
        if image.size == (24, 12):
            image = image.crop((0, 0, 16, 12))
        else:
            image = image.resize((16, 12), Image.Resampling.NEAREST)
    else:
        if image.size == (24, 12):
            image = image.crop((16, 0, 24, 12))
        else:
            image = image.resize((8, 12), Image.Resampling.NEAREST)
    return image.quantize(colors=256, method=Image.Quantize.MEDIANCUT)


def bmp_info(path: Path) -> dict:
    data = path.read_bytes()
    if data[:2] != b"BM":
        raise ValueError(f"{path} is not a BMP")
    width = int.from_bytes(data[18:22], "little", signed=True)
    height = int.from_bytes(data[22:26], "little", signed=True)
    bits = int.from_bytes(data[28:30], "little")
    return {
        "width": abs(width),
        "height": abs(height),
        "bitsPerPixel": bits,
        "bytes": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
    }


def import_kind(kind: str, count: int) -> list[dict]:
    destination = OUTPUT_ROOT / kind
    destination.mkdir(parents=True, exist_ok=True)
    entries = []
    seen_hashes = set()
    for index in range(1, count + 1):
        if kind == "clan":
            url = f"{CDN_ROOT}/crestclan/crest-clan-{index}.jpg"
        else:
            url = f"{CDN_ROOT}/crestally/crest-ally-{index}.jpg"
        try:
            source = save_source(kind, index, download(url))
            image = normalize_image(kind, source)
            candidate = destination / f"crest-{len(entries) + 1:03d}.bmp"
            image.save(candidate, format="BMP")
            info = bmp_info(candidate)
            if info["sha256"] in seen_hashes:
                candidate.unlink()
                continue
            seen_hashes.add(info["sha256"])
            entries.append({
                "id": len(entries) + 1,
                "file": str(candidate.relative_to(ROOT)).replace("\\", "/"),
                "source": url,
                **info,
            })
        except Exception as error:  # Keep importing when the gallery has a hole.
            print(f"skip {kind} {index}: {error}", file=sys.stderr)
    return entries


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--count", type=int, default=250)
    args = parser.parse_args()
    if args.count < 1:
        parser.error("--count must be positive")

    clan = import_kind("clan", args.count)
    ally = import_kind("ally", args.count)
    manifest = {
        "source": SOURCE_URL,
        "generatedAt": "2026-08-22",
        "format": {
            "clan": {"width": 16, "height": 12, "bitsPerPixel": 8},
            "ally": {"width": 8, "height": 12, "bitsPerPixel": 8},
        },
        "clan": clan,
        "ally": ally,
    }
    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    (OUTPUT_ROOT / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(f"imported clan={len(clan)} ally={len(ally)}")
    return 0 if clan and ally else 1


if __name__ == "__main__":
    raise SystemExit(main())
