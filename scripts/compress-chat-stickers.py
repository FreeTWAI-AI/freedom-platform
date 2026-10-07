"""Package explicitly supplied sticker images; originals are never changed.

Requires Pillow with WebP. --sources is a private JSON list of id/label/keywords/source.
Only hashes, labels, dimensions and output paths enter the public manifest.
"""
import argparse
import hashlib
import io
import json
import re
from pathlib import Path

from PIL import Image, ImageOps, __version__, features


def encode(image, size, quality):
    resized = ImageOps.contain(image, (size, size), Image.Resampling.LANCZOS)
    data = io.BytesIO()
    resized.save(data, format='WEBP', quality=quality, method=6)
    return data.getvalue(), resized.size


def package(sources, destination, manifest):
    if not features.check('webp'):
        raise RuntimeError('Pillow WebP support is required')
    entries = json.loads(sources.read_text(encoding='utf-8'))
    ids = [entry['id'] for entry in entries]
    if len(set(ids)) != len(ids) or any(not re.fullmatch(r'freetwai-v2-[a-z0-9-]+', key) for key in ids):
        raise ValueError('Unique stable freetwai-v2 IDs are required')
    destination.mkdir(parents=True, exist_ok=True)
    outputs = []
    for entry in entries:
        raw = Path(entry['source']).read_bytes()
        original_hash = hashlib.sha256(raw).hexdigest()
        with Image.open(io.BytesIO(raw)) as opened:
            image = ImageOps.exif_transpose(opened).convert('RGB')
        if image.width != image.height or image.width < 512:
            raise ValueError('Expected square sources at least 512px: ' + entry['id'])
        item = {key: entry[key] for key in ['id', 'label', 'keywords']}
        item.update(source_sha256=original_hash, source_bytes=len(raw), source_dimensions=list(image.size))
        for variant, size, quality, maximum in [('image', 512, 88, 96 * 1024), ('thumbnail', 144, 82, 12 * 1024)]:
            data, dimensions = encode(image, size, quality)
            if len(data) > maximum:
                raise RuntimeError('Frozen size budget exceeded: ' + entry['id'] + ' ' + variant)
            digest = hashlib.sha256(data).hexdigest()
            filename = f"{entry['id']}-{variant}-{digest[:12]}.webp"
            target = destination / filename
            target.write_bytes(data)
            with Image.open(target) as decoded:
                decoded.load()
                if decoded.size != dimensions or decoded.format != 'WEBP':
                    raise RuntimeError('Output decode failed: ' + filename)
            item[variant] = {'file': filename, 'bytes': len(data), 'dimensions': list(dimensions), 'quality': quality, 'sha256': digest}
        outputs.append(item)
    original = sum(item['source_bytes'] for item in outputs)
    images = sum(item['image']['bytes'] for item in outputs)
    thumbnails = sum(item['thumbnail']['bytes'] for item in outputs)
    if (images + thumbnails) / original > .25:
        raise RuntimeError('Combined output exceeds 25% of supplied JPEG bytes')
    report = {'schema': 'freedom.supplied-sticker-pack/v1', 'pack': 'freetwai-v2',
              'provenance': '48 images supplied by Hao in this task for submission to freedom-platform. Existing artwork, text and white background preserved; no generation or authorship claim.',
              'encoder': {'pillow': __version__, 'webp': features.version('webp'), 'method': 6, 'resample': 'LANCZOS', 'metadata': 'omitted'},
              'budgets': {'combined_ratio_max': .25, 'image_bytes_max': 96 * 1024, 'thumbnail_bytes_max': 12 * 1024},
              'totals': {'count': len(outputs), 'source_bytes': original, 'image_bytes': images, 'thumbnail_bytes': thumbnails, 'combined_ratio': (images + thumbnails) / original}, 'items': outputs}
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')
    print(json.dumps(report['totals']))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', type=Path, required=True)
    parser.add_argument('--destination', type=Path, default=Path('apps/portal-web/public/art/chat/freetwai-v2'))
    parser.add_argument('--manifest', type=Path, default=Path('docs/design/freetwai-stickers-v2.json'))
    args = parser.parse_args()
    package(args.sources, args.destination, args.manifest)
