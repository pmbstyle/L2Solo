#!/usr/bin/env python3
"""Import weapon SA metadata and missing templates from pinned Lisvus C4 XML.
Usage: python3 scripts/generate-c4-weapon-sa.py [path/to/l2j-lisvus]
See data/Items/WEAPON_SA.md for source gaps and runtime policy.
"""
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'tmp/vendor/l2j-lisvus'
REVISION = 'fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975'
if not (SOURCE / 'datapack/data/stats/items').is_dir() or not (SOURCE / 'datapack/data/stats/skills').is_dir():
    raise SystemExit(f'Lisvus C4 source datapack not found: {SOURCE}')
STATS = {'pAtk': 'pAtkAdd', 'mAtk': 'mAtkAdd', 'accCombat': 'pAccuracyCombatAdd',
         'rCrit': 'pCritRateAdd', 'cAtkAdd': 'pCritDamageAdd', 'rEvas': 'pEvasionRateAdd',
         'regHp': 'regHpAdd', 'regMp': 'regMpAdd', 'absorbDam': 'absorbDam',
         'pAtkSpd': 'pAtkSpdMul', 'maxHp': 'maxHpMul', 'maxMp': 'maxMpMul',
         'maxCp': 'maxCpMul', 'atkReuse': 'atkReuseMul', 'pvpPhysDmg': 'pvpPhysDmg',
         'pvpPhysSkillsDmg': 'pvpPhysSkillsDmg', 'pvpMagicalDmg': 'pvpMagicalDmg',
         'MpConsume': 'magicalMpConsumeRateMul'}
KINDS = {'SWORD': 'Sword', 'BIGSWORD': 'GreatSword', 'BLUNT': 'Blunt', 'BIGBLUNT': 'Blunt',
         'DAGGER': 'Knife', 'POLE': 'Pole', 'BOW': 'Bow', 'DUAL': 'Dual', 'DUALFIST': 'DualFist'}
def sets(node):
    return {x.get('name'): x.get('val') for x in node.findall('set')}
def number(value):
    n = float(value)
    return int(n) if n.is_integer() else n
def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

items = [i for f in sorted((SOURCE / 'datapack/data/stats/items').glob('*.xml'))
         for i in ET.parse(f).getroot() if i.tag == 'item' and i.get('type') == 'Weapon']
skills = {int(s.get('id')): s for f in sorted((SOURCE / 'datapack/data/stats/skills').glob('*.xml'))
          for s in ET.parse(f).getroot() if s.tag == 'skill'}
if not items or not skills:
    raise SystemExit('Empty source datapack; refusing to replace the weapon catalogs')
existing = set()
for file in (ROOT / 'data/Items/Weapons').glob('*.json'):
    if file.name.startswith('.') or file.name == 'c4_sa_catalog.json':
        continue
    rows = json.loads(file.read_text())
    if isinstance(rows, list):
        existing.update(row['selfId'] for row in rows)
weapons, templates, procs = {}, [], {}
for item in items:
    props = sets(item)
    if props.get('crystal_type') not in ['C', 'B', 'A', 'S']: continue
    if ' - ' not in item.get('name') and not (props.get('weapon_type') == 'DUAL' and '*' in item.get('name')): continue
    item_id = int(item.get('id'))
    # C4 client descriptions fill missing proc links (see source links in WEAPON_SA.md).
    overrides = {
        5600: {'oncrit_skill': '3021-5', 'oncrit_chance': '42'},
        5609: {'oncrit_skill': '3021-5', 'oncrit_chance': '35'},
        5613: {'oncrit_skill': '3024-6', 'oncrit_chance': '18'},
        7706: {'oncast_skill': '1045-3', 'oncast_chance': '20'},
    }
    props.update(overrides.get(item_id, {}))
    entry = {'name': item.get('name'), 'stats': {}, 'conditionalStats': []}
    for field in ['item_skill', 'oncrit_skill', 'oncast_skill']:
        if field not in props: continue
        sid, level = map(int, props[field].split('-'))
        if field == 'item_skill': entry['passive'] = {'skillId': sid, 'level': level}
        else:
            entry[field[:6]] = {'skillId': sid, 'level': level, 'chance': number(props[field.replace('_skill', '_chance')])}
            s = skills[sid]
            tables = {t.get('name'): t.text.split() for t in s.findall('table')}
            def val(v): return number(tables[v][level-1] if v.startswith('#') else v)
            sp = sets(s)
            proc = {'selfId': sid, 'level': level, 'name': s.get('name'), 'spell': sp.get('isMagic') == 'true'}
            if 'power' in sp: proc['power'] = val(sp['power'])
            semantic = {'isMagic': proc['spell'], 'baseLandRate': proc.get('power', 100), 'levelDepend': val(sp.get('lvlDepend', '1'))}
            if 'magicLvl' in sp: semantic['magicLevel'] = val(sp['magicLvl'])
            effects = s.findall('for/effect')
            if effects:
                effect = effects[0]
                duration = val(effect.get('time', '0')) * val(effect.get('count', '1')) * 1000
                proc['buffTime'] = duration
                semantic['durationMs'] = duration
                if sid >= 3000:
                    typ = sp['skillType']
                    name = {'STUN': 'stun', 'POISON': 'poison', 'BLEED': 'bleed', 'MUTE': 'silence', 'ROOT': 'root', 'DEBUFF': 'slow'}[typ]
                    semantic.update(skillType='effect', effect=name, effectType='debuff', target='enemy', trait={'stun':'shock'}.get(name,name))
                    if effect.get('stackType'): semantic['stackFamily'] = effect.get('stackType')
                    if effect.get('stackOrder'): semantic['stackOrder'] = val(effect.get('stackOrder'))
                    if typ in ['POISON', 'BLEED']:
                        semantic['dot'] = {'count': val(effect.get('count')), 'intervalMs': val(effect.get('time'))*1000, 'damage': val(effect.get('val'))}
                    if typ == 'DEBUFF': semantic['stats'] = {'runSpdMul': val(effect.find('mul').get('val'))}
            proc['semantic'] = semantic
            procs[f'{sid}-{level}'] = proc
    for node in item.findall('for/*'):
        stat = node.get('stat')
        if node.tag == 'enchant': continue
        if node.tag == 'set' and stat == 'pAtkAngle': entry['attackAngle'] = number(node.get('val')); continue
        if node.tag == 'set' and stat == 'soulShotCount': entry['miser'] = {'count': number(node.get('val')), 'chance': number(node.find('.//game').get('chance'))}; continue
        if node.tag == 'set' and stat == 'MpConsume':
            entry['cheapShot'] = {'mp': number(node.get('val')), 'chance': number(node.find('.//game').get('chance'))}; continue
        if not len(node) and node.get('order') in ['0x08', '0x10']: continue
        key = STATS[stat]
        condition = {}
        for child in node.iter():
            if child.tag == 'using': condition['minEnchantLevel'] = int(child.get('minEnchantLevel'))
            if child.tag == 'player': condition['actorHpPercentAtMost'] = number(child.get('hp'))
        if condition: entry['conditionalStats'].append({'condition': condition, 'stats': {key: number(node.get('val'))}})
        else: entry['stats'][key] = number(node.get('val'))
    weapons[item_id] = entry
    if item_id in existing: continue
    base = {x.get('stat'): number(x.get('val')) for x in item.findall('for/*')
            if not len(x) and x.tag != 'enchant' and x.get('order') in ['0x08', '0x10']}
    stats = {'pAtk': base['pAtk'], 'mAtk': base['mAtk'], 'pAtkRnd': number(props['random_damage']),
             'atkSpd': base['pAtkSpd'], 'crit': base['rCrit'] * 10, 'accur': base.get('accCombat', 0)}
    # Keep existing bow range policy (700 + passives); XML bow 500 is not this runtime's base.
    if props['weapon_type'] != 'BOW': stats['attackRange'] = base.get('pAtkRange', number(props['attack_range']))
    if 'reuse_delay' in props: stats['reuseDelay'] = number(props['reuse_delay'])
    templates.append({'selfId': item_id, 'template': {'name': item.get('name'), 'kind': 'Weapon.' + KINDS[props['weapon_type']],
        'class1': 0, 'class2': 0, 'mass': number(props['weight']), 'price': number(props['price'])}, 'stats': stats,
        'etc': {'slot': 7 if props['bodypart'] == 'rhand' else 14, 'mp': number(props.get('mp_consume', '0')),
                'soulshot': number(props['soulshots']), 'spiritshot': number(props['spiritshots']),
                'rank': props['crystal_type'].lower(), 'cristals': number(props['crystal_count'])}})

dump(ROOT / 'data/Items/weapon_sa.json', {'source': 'Lisvus/L2J C4', 'revision': REVISION, 'weapons': weapons, 'procs': procs})
dump(ROOT / 'data/Items/Weapons/c4_sa_catalog.json', sorted(templates, key=lambda x:x['selfId']))
print(f'{len(weapons)} weapon definitions, {len(templates)} missing templates, {len(procs)} proc skills')
