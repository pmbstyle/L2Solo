#!/usr/bin/env python3
"""Import Soul Crystal exchanges from the pinned Lisvus C4 multisells."""
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tmp/vendor/l2j-lisvus'
sa = json.loads((ROOT / 'data/Items/weapon_sa.json').read_text())['weapons']
items = {}
for file in (ROOT / 'data/Items/Weapons').glob('*.json'):
    data = json.loads(file.read_text())
    if not isinstance(data, list):
        continue
    for item in data:
        items[item['selfId']] = item
base_templates = []
for self_id, kind in [(4233, 'DualFist'), (6368, 'Bow')]:
    file = SOURCE / f'datapack/data/stats/items/{self_id // 100 * 100}-{self_id // 100 * 100 + 99}.xml'
    node = next(i for i in ET.parse(file).getroot().findall('item') if int(i.get('id')) == self_id)
    props = {x.get('name'): x.get('val') for x in node.findall('set')}
    base = {x.get('stat'): float(x.get('val')) for x in node.findall('for/*') if x.tag != 'enchant'}
    stats = dict(pAtk=base['pAtk'], mAtk=base['mAtk'], pAtkRnd=int(props['random_damage']),
        atkSpd=base['pAtkSpd'], crit=base['rCrit'] * 10, accur=base['accCombat'])
    if kind != 'Bow':
        stats['attackRange'] = int(props['attack_range'])
    if 'reuse_delay' in props:
        stats['reuseDelay'] = int(props['reuse_delay'])
    template = dict(selfId=self_id, template=dict(name=node.get('name'), kind='Weapon.' + kind,
        class1=0, class2=0, mass=int(props['weight']), price=int(props['price'])), stats=stats,
        etc=dict(slot=14, mp=int(props.get('mp_consume', '0')), soulshot=int(props['soulshots']),
            spiritshot=int(props['spiritshots']), rank=props['crystal_type'].lower(), cristals=int(props['crystal_count'])))
    items[self_id] = template
    base_templates.append(template)
recipes = []
excluded = []
for list_id, station, operation in [('1005', 'blacksmith', 'install'),
        ('81262510', 'mammon', 'install'), ('81262501', 'mammon', 'install'),
        ('81262509', 'mammon', 'remove'), ('80922001', 'blackMarket', 'remove')]:
    tree = ET.parse(SOURCE / f'datapack/data/multisell/{list_id}.xml').getroot()
    assert tree.get('maintainEnchantment') == 'true'
    for entry in tree.findall('item'):
        product = entry.find('production')
        ingredients = entry.findall('ingredient')
        weapon = ingredients[0]
        source_id, product_id = int(weapon.get('id')), int(product.get('id'))
        sa_id = product_id if operation == 'install' else source_id
        if str(sa_id) not in sa:
            excluded.append(f'{list_id}:{entry.get("id")}')
            continue  # These variants are outside the project's C4 weapon catalog.
        assert source_id in items and product_id in items, (source_id, product_id)
        assert weapon.get('count') == product.get('count') == '1'
        costs, tax_base = [], 0
        for ingredient in ingredients[1:]:
            self_id, amount = int(ingredient.get('id')), int(ingredient.get('count'))
            if ingredient.get('isTaxIngredient') == 'true':
                assert self_id == 57
                tax_base += amount
            else:
                costs.append(dict(selfId=self_id, amount=amount))
        recipes.append(dict(id=f'{list_id}:{entry.get("id")}', station=station, operation=operation,
            sourceId=source_id, productId=product_id, costs=costs, taxBase=tax_base))

# The source removal list omits four installable variants. Invert their exact
# installation recipes so every installed SA can be removed at Mammon.
removable = {r['sourceId'] for r in recipes if r['station'] == 'mammon' and r['operation'] == 'remove'}
for recipe in list(recipes):
    if recipe['operation'] == 'install' and recipe['productId'] not in removable:
        recipes.append(dict(id=f"inverse:{recipe['productId']}", station='mammon', operation='remove',
            sourceId=recipe['productId'], productId=recipe['sourceId'], costs=[], taxBase=0))
        removable.add(recipe['productId'])

# Old client SA aliases remain removable, but are never produced by installation.
for self_id, metadata in sa.items():
    self_id = int(self_id)
    if self_id in removable or ' - ' not in metadata['name']:
        continue
    base_name = metadata['name'].split(' - ')[0]
    bases = [i for i in items.values() if i['template']['name'] == base_name and str(i['selfId']) not in sa]
    assert len(bases) == 1, (self_id, base_name)
    recipes.append(dict(id=f'legacy:{self_id}', station='mammon', operation='remove',
        sourceId=self_id, productId=bases[0]['selfId'], costs=[], taxBase=0))

blacksmiths = sorted(int(file.stem) for file in (SOURCE / 'datapack/data/html/trainer').glob('*.htm')
    if file.stem.isdigit() and 'common/weapon_sa_01.htm' in file.read_text())
output = dict(source='https://gitlab.com/TheDnR/l2j-lisvus',
    revision='fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975', blacksmiths=blacksmiths,
    excludedEntries=excluded, recipes=recipes)
(ROOT / 'data/Items/weapon_sa_exchanges.json').write_text(json.dumps(output, indent=2) + '\n')
(ROOT / 'data/Items/Weapons/c4_sa_base_weapons.json').write_text(json.dumps(base_templates, indent=2) + '\n')
currency = [dict(selfId=5575, template=dict(kind='Other.None', name='Ancient Adena', class1=4, class2=4, mass=0, price=0),
    etc=dict(stackable=True, consumable=False))]
(ROOT / 'data/Items/Others/c4_sa_exchange_materials.json').write_text(json.dumps(currency, indent=2) + '\n')
print(f'Imported {len(recipes)} exchanges, {len(blacksmiths)} blacksmiths; excluded {len(excluded)} entries outside the C4 catalog')
