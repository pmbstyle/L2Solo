#!/usr/bin/env python3
# Spot index check (T128): per class line, level and spot, two thresholds on
# one number the bot computes from its own stats,
#   I = HP x offence / (kp / pDef + km / mDef)
# (offence = pAtk x atkSpd x (1 + crit/1000); kp, km: the spot's physical and
# magic threat, C4 damage ~ attack / defence). "Tolerable": every spot mob is
# survived in a bad fight (mean + 3 sigma, report.mob_hour's test); "easy":
# tolerable and the rest after the spot's fights is shorter than the fights.
# Thresholds are fitted on sampled kits; printed: how many kits the
# thresholds misclassify against the exact table.
# Usage: spot_index.py <line.json.gz> [levels]
import gzip, json, math, random, sys

SIGMA = 3
random.seed(1)

def exact(x, w, a, j, rows):
    hp = x['armour'][a][4]
    fight_sum = taken_sum = 0
    for m, count in rows:
        f = x['off'][w][m][0]
        if f is None: return False, False
        pm, psq, aps = x['phys'][a][m]; sm, ssq = x['magic'][j][m]
        n = aps * f; mean = (pm + sm) * n; var = max(0, n * ((psq + ssq) - (pm + sm) ** 2))
        if mean + SIGMA * math.sqrt(var) >= hp: return False, False
        fight_sum += count * f; taken_sum += count * mean
    rest = taken_sum / (x['regen']['hp'] / 3)
    return True, rest < fight_sum

def threat(x, rows):
    # kp: physical damage per second x pDef, km: spell damage per second x mDef (median over points)
    kp, km = [], []
    for a, arow in enumerate(x['armour']):
        kp.append(sum(c * x['phys'][a][m][0] * x['phys'][a][m][2] for m, c in rows) * arow[2])
    for jj, jrow in enumerate(x['jewels']):
        aps = sum(c * x['phys'][0][m][2] for m, c in rows) / max(1, sum(c for _, c in rows))
        km.append(sum(c * x['magic'][jj][m][0] for m, c in rows) * aps * jrow[2])
    med = lambda v: sorted(v)[len(v) // 2]
    return med(kp), med(km)

def index(x, w, a, j, kp, km):
    wr, ar, jr = x['weapons'][w], x['armour'][a], x['jewels'][j]
    off = wr[2] * wr[4] * (1 + wr[5] / 1000)
    return ar[4] * off / (kp / max(1, ar[2]) + km / max(1, jr[2]) + 1e-9)

def best_cut(samples):
    # samples: [(I, label)]; the cut with fewest errors (label True above it)
    s = sorted(samples); pos = sum(1 for _, l in s if l); best = (pos, 0.0)
    below_pos = below_neg = 0
    for i, (v, l) in enumerate(s):
        if l: below_pos += 1
        else: below_neg += 1
        err = below_pos + (len(s) - i - 1 - (pos - below_pos))
        if err < best[0]: best = (err, v)
    return best

def main():
    data = json.load(gzip.open(sys.argv[1]))['levels']
    spots = json.load(open('data/Bots/hunt/spots.json'))['spots']
    levels = [int(v) for v in sys.argv[2].split(',')] if len(sys.argv) > 2 else [15, 20, 25, 30, 35, 40, 45, 50, 55, 60]
    print('lvl spots kits | tolerable: share err | easy: share err   (err = kits the thresholds misclassify)')
    for level in levels:
        x = data.get(str(level))
        if not x: continue
        at = {mob[0]: m for m, mob in enumerate(x['mobs'])}
        kits = [(random.randrange(len(x['weapons'])), random.randrange(len(x['armour'])), random.randrange(len(x['jewels']))) for _ in range(400)]
        tot = {'n': 0, 'tol': 0, 'te': 0, 'easy': 0, 'ee': 0}; nspots = 0
        for spot in spots:
            if not (level - 5 <= spot[1] <= level + 3): continue
            rows = [(at[npc], count) for npc, count, pull in spot[5] if npc in at and pull <= 1.05]
            if not rows or len(rows) < len(spot[5]): continue
            nspots += 1
            kp, km = threat(x, rows)
            labelled = [(index(x, *k, kp, km), *exact(x, *k, rows)) for k in kits]
            et, _ = best_cut([(i, t) for i, t, _ in labelled]); ee, _ = best_cut([(i, e) for i, _, e in labelled])
            tot['n'] += len(labelled); tot['tol'] += sum(t for _, t, _ in labelled); tot['easy'] += sum(e for _, _, e in labelled)
            tot['te'] += et; tot['ee'] += ee
        if not tot['n']: continue
        n = tot['n']
        print(f"{level:3} {nspots:5} {n:6} | {100*tot['tol']/n:5.1f}% {100*tot['te']/n:5.2f}% | {100*tot['easy']/n:5.1f}% {100*tot['ee']/n:5.2f}%")

if __name__ == '__main__':
    main()
