# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (c) 2026 yasha92443
"""Build the cloud PDF's static, Simplified Chinese font asset (fontTools required)."""
import argparse
import hashlib
import json
from pathlib import Path
from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, type=Path)
parser.add_argument('--output', type=Path, default=Path('assets/fonts/afterme-song-sc.ttf'))
parser.add_argument('--manifest', type=Path, default=Path('third_party/pdf-chinese-font.json'))
args = parser.parse_args()
source = args.source.read_bytes()
font = TTFont(args.source)
if (font['name'].getDebugName(16) or font['name'].getDebugName(1)) != 'Noto Serif SC':
    raise ValueError('Expected the Simplified Chinese Noto Serif SC font')
font = instantiateVariableFont(font, {'wght': 400}, inplace=True)
options = subset.Options()
options.layout_features = []
options.hinting = False
options.recalc_timestamp = False
options.name_IDs = [0, 1, 2, 3, 4, 5, 6, 13, 14]
options.name_languages = [0x0409]
options.drop_tables += ['DSIG']
cutter = subset.Subsetter(options=options)
cutter.populate(unicodes={p for p in font.getBestCmap() if p <= 0xffff})
cutter.subset(font)
names = {1:'AfterMe PDF Song SC', 2:'Regular', 3:'AfterMe PDF Song SC Regular 1.0',
         4:'AfterMe PDF Song SC Regular', 6:'AfterMePDFSongSC'}
for record in font['name'].names:
    if record.nameID in names:
        record.string = names[record.nameID].encode(record.getEncoding(), errors='replace')
args.output.parent.mkdir(parents=True, exist_ok=True)
font.save(args.output, reorderTables=True)
data = args.output.read_bytes()
manifest = {'family':'AfterMe PDF Song SC', 'upstream':'Noto Serif SC', 'weight':400,
            'license':'OFL-1.1', 'source_url':'https://github.com/google/fonts/tree/main/ofl/notoserifsc',
            'source_sha256':hashlib.sha256(source).hexdigest(),
            'asset':args.output.as_posix(), 'sha256':hashlib.sha256(data).hexdigest(),
            'bytes':len(data), 'characters':len(font.getBestCmap())}
args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps(manifest))
