#!/usr/bin/env python3
# Reads a fight table line (build.js) and per level and kit prints the best
# mob by exp per hour among those the bot survives (a bad fight, mean + 3
# sigma of the damage, leaves it alive): its streak on one HP/MP bar, what
# ends the streak, the rest share, exp and adena per hour. Rest = seated
# regeneration of the missing HP/MP. Usage: report.py <line.json.gz> [levels]
import gzip, json, math, sys

SIGMA = 3

def kit_rows(x):
    w = range(len(x['weapons'])); a = range(len(x['armour'])); j = range(len(x['jewels']))
    best = (max(w, key=lambda i: x['weapons'][i][2]), max(a, key=lambda i: x['armour'][i][2]), max(j, key=lambda i: x['jewels'][i][2]))
    cheap = (min(range(1, len(x['weapons'])), key=lambda i: x['weapons'][i][2]) if len(x['weapons']) > 1 else 0, 0, 0)
    return {'naked': (0, 0, 0), 'cheap weapon': cheap, 'best kit': best}

def mob_hour(x, kit, m):
    w, a, j = kit
    fight = x['off'][w][m][0]
    if fight is None: return None
    pm, psq, aps = x['phys'][a][m]; sm, ssq = x['magic'][j][m]
    hp, mp = x['armour'][a][4], x['armour'][a][5] or x['naked']['maxMp']
    n_act = aps * fight; mean = (pm + sm) * n_act
    var = max(0.0, n_act * ((psq + ssq) - (pm + sm) ** 2))
    if mean + SIGMA * math.sqrt(var) >= hp: return None
    # Kills on one HP bar: the last one's bad fight still leaves the bot alive.
    n = 1
    while n < 500 and (n + 1) * mean + SIGMA * math.sqrt((n + 1) * var) < hp: n += 1
    mp_fight = x['rot']['mpPerSec'] * fight
    by = 'hp'
    if mp_fight > 0 and mp / mp_fight < n: n, by = max(1, int(mp / mp_fight)), 'mp'
    streak = n * fight
    rest = max(n * mean / (x['regen']['hp'] / 3), n * mp_fight / (x['regen']['mp'] / 3) if mp_fight > 0 else 0)
    mob = x['mobs'][m]
    cycle = streak + rest
    return {'mob': mob[1], 'npc': mob[0], 'n': n, 'by': by, 'streak': streak, 'restShare': rest / cycle,
            'exp': n * mob[3] * 3600 / cycle, 'adena': n * mob[5] * 3600 / cycle}

def main():
    data = json.load(gzip.open(sys.argv[1]))['levels']
    levels = [int(v) for v in sys.argv[2].split(',')] if len(sys.argv) > 2 else range(1, 79, 3)
    print('lvl kit           | survives up to | best exp/h: mob streak(by) min rest% exp/h adena/h | best adena/h: mob adena/h')
    for level in levels:
        x = data.get(str(level))
        if not x: continue
        for name, kit in kit_rows(x).items():
            hours = [h for h in (mob_hour(x, kit, m) for m in range(len(x['mobs']))) if h]
            if not hours: print(f'{level:3} {name:13} | none'); continue
            e = max(hours, key=lambda h: h['exp']); g = max(hours, key=lambda h: h['adena'])
            print(f"{level:3} {name:13} | {max(h['mob'] for h in hours):3} | {e['mob']:3} {e['n']:3}({e['by']}) {e['streak']/60:5.1f} "
                  f"{100*e['restShare']:3.0f}% {e['exp']:8.0f} {e['adena']:7.0f} | {g['mob']:3} {g['adena']:7.0f}")

if __name__ == '__main__':
    main()
