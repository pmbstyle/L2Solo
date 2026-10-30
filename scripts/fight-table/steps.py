#!/usr/bin/env python3
# Upgrade steps per part (T128 report): per level an entry kit (each part the
# best of the previous grade) and the gain of moving one part alone to its
# own grade's low / mid / top point. Each row: survives-up-to mob level, best
# mob's streak and exp/adena per hour (report.mob_hour).
# Usage: steps.py <line.json.gz> [levels]
import gzip, json, sys, os
sys.path.insert(0, os.path.dirname(__file__))
from report import mob_hour

GRADES = ['none', 'd', 'c', 'b', 'a', 's']
import glob
rank = {}
for f in glob.glob('data/Items/**/*.json', recursive=True):
    try: rows = json.load(open(f))
    except ValueError: continue
    for row in rows if isinstance(rows, list) else []:
        if isinstance(row, dict) and 'selfId' in row: rank.setdefault(row['selfId'], (row.get('etc') or {}).get('rank', 'none'))

def grade_of(ids):
    return max((GRADES.index(rank.get(i, 'none')) for i in ids), default=0)

def ladder(points, stat):
    # points: [ids, kits, stats...]; per grade, points sorted by their stat
    by = {}
    for i, p in enumerate(points): by.setdefault(grade_of(p[0]), []).append(i)
    return {g: sorted(lst, key=lambda i: points[i][stat]) for g, lst in by.items()}

def best(x, kit):
    hours = [h for h in (mob_hour(x, kit, m) for m in range(len(x['mobs']))) if h]
    if not hours: return None
    e = max(hours, key=lambda h: h['exp'])
    return max(h['mob'] for h in hours), e, max(h['adena'] for h in hours)

def main():
    data = json.load(gzip.open(sys.argv[1]))['levels']
    levels = [int(v) for v in sys.argv[2].split(',')] if len(sys.argv) > 2 else range(5, 79, 5)
    for level in levels:
        x = data.get(str(level))
        if not x: continue
        parts = [ladder(x['weapons'], 2), ladder(x['armour'], 2), ladder(x['jewels'], 2)]
        own = max(max(p) for p in parts)
        entry = [p[max(g for g in p if g < own)][-1] if any(g < own for g in p) else p[own][0] for p in parts]
        base = best(x, tuple(entry))
        print(f'\n== level {level} (grade {GRADES[own]})  row: up-to | best-exp mob streak rest% | exp/h adena/h (x entry)')
        def row(name, kit):
            r = best(x, tuple(kit))
            if not r: print(f'  {name:18} survives nothing'); return
            top, e, adena = r
            rel = lambda v, b: f'x{v / b:4.2f}' if b else '   - '
            print(f"  {name:18} {top:3} | {e['mob']:3} {e['n']:3}({e['by']}) {100*e['restShare']:3.0f}% | {e['exp']:9.0f} {rel(e['exp'], base[1]['exp'] if base else 0)}"
                  f" {adena:8.0f} {rel(adena, base[2] if base else 0)}")
        row('entry (prev top)', entry)
        for p, name in enumerate(['weapon', 'armour', 'jewels']):
            points = (x['weapons'], x['armour'], x['jewels'])[p]
            # A step wears as many pieces as the entry (one empty slot is no upgrade).
            lst = [i for i in parts[p].get(own, []) if len(points[i][0]) >= len(points[entry[p]][0])]
            for tag, i in (('low', 0), ('mid', len(lst) // 2), ('top', len(lst) - 1)) if lst else ():
                kit = list(entry); kit[p] = lst[i]
                row(f'+{name} {tag}', kit)

if __name__ == '__main__':
    main()
