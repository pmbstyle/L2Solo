#!/usr/bin/env python3
"""Import C4 crystal chains and absorb targets from the Lisvus datapack."""
import csv
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tmp/vendor/l2j-lisvus'
crystals = {}
for item in ET.parse(SOURCE / 'datapack/data/soulCrystals.xml').getroot():
    color = item.attrib['color'].lower()
    crystals[item.attrib['itemId']] = dict(color=color, stage=int(item.attrib['level']),
        nextId=int(item.attrib['leveledItemId']), brokenId={'red': 4662, 'green': 4663, 'blue': 4664}[color])
for color, item_id in [('red', 5908), ('green', 5911), ('blue', 5914)]:
    crystals[str(item_id)] = dict(color=color, stage=13, nextId=None, brokenId={'red': 4662, 'green': 4663, 'blue': 4664}[color])
npcs = {}
for line in (SOURCE / 'datapack/sql/npc.sql').read_text().splitlines():
    if not line.startswith("('"):
        continue
    row = next(csv.reader([line.strip().rstrip(',;')[1:-1]], quotechar="'", escapechar='\\', skipinitialspace=True))
    if int(row[40]):
        npcs[row[0]] = dict(name=row[2], maxStage=int(row[40]), absorbType=row[41])
assert len(crystals) == 42 and len(npcs) > 50
templates = []
for item_id, crystal in crystals.items():
    if crystal['stage'] >= 11:
        templates.append(dict(selfId=int(item_id), template=dict(kind='Other.Scroll',
            name=f"{crystal['color'].title()} Soul Crystal - Stage {crystal['stage']}",
            class1=4, class2=5, mass=20, price=0), etc=dict(stackable=False, consumable=False)))
for name, data in [('soul_crystals.json', dict(source='https://gitlab.com/TheDnR/l2j-lisvus',
        revision='fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975', crystals=crystals, npcs=npcs)),
        ('Others/c4_soul_crystals.json', templates)]:
    (ROOT / 'data/Items' / name).write_text(json.dumps(data, indent=2) + '\n')
print(f'Imported {len(crystals)} crystals, {len(npcs)} targets and {len(templates)} item templates')
