#!/usr/bin/env node
'use strict';

// The big fight table (T128, docs/game-decisions.md "Kit and party tables"):
// one bot against one mob, every level, kept offline as raw quantities (no
// prices, no rest policy). The hunt formula (HuntModel.mobHour) splits
// exactly in two: the fight's length reads the bot's offence only, the
// mob's damage on the bot its defence only (ColdMobAction.actionMix: weapon
// hits and physical skills by P.Def, evasion and shield, spells by M.Def).
// So per class line and level the table keeps three small sets of points:
//   weapons  offence points (one per weapon, naked otherwise) x mob:
//            fight seconds with shots, without, and dry (out of MP)
//   armour   defence points (armour pieces, sets) x mob: the mob's physical
//            damage per action (mean, second moment) and actions per second
//   jewels   M.Def points x mob: its spell damage per action (mean, second)
// and the kits (a weapon, an armour and a jewel point) the line reaches.
//
// Kits follow a player's path (user 10-30): from a naked level 1 a kit goes
// on while it holds (survives a bad fight, mean + 3 sigma, against a mob of
// full experience: gap <= 5, MobExperience.gapFactor); one that no longer
// holds branches into every single-piece swap (pieces of grades up to the
// level's) that makes it hold again; kits of equal numbers merge. At the
// last level the pieces no path wore are put on the final kits too, so every
// piece is in the table.
// Mob window per level: from the first level of the grade below up while
// any part survives (each mob's fastest weapon, least hurt armour, jewels).
//
// Usage: node scripts/fight-table/path.js [--keys=7>9,...] [--levels=1-78] [--out=tmp/fight-table]
// Run through ~/Games/tools/check.sh (background priority). Out: one gzipped JSON per line.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../hunt-tables/common');

const ADENA = 57;
const SIGMA = 3;
const ARMOUR_SLOTS = [10, 11, 15, 6, 9, 12, 8];
const JEWEL_SLOTS = [4, 1, 3];

function args() {
    const out = { keys: null, levels: [1, C.MAX_LEVEL], out: 'tmp/fight-table' };
    for (const arg of process.argv.slice(2)) {
        const [name, value] = arg.replace(/^--/, '').split('=');
        if (name === 'keys') out.keys = value.split(',');
        if (name === 'levels') out.levels = value.split('-').map(Number);
        if (name === 'out') out.out = value;
    }
    return out;
}

function wearRow(item) {
    return { selfId: item.selfId, objectId: item.selfId, enchant: 0, slot: item.slot };
}

// Earrings and rings go on as pairs (slot 1 and 2, 3 and 4 in the worn list;
// the neck is slot 4 in the item data, alone).
function jewelRows(item) {
    return item.slot === 4 ? [wearRow(item)] : [wearRow(item), { ...wearRow(item), slot: item.slot + 1 }];
}

// A class line's pieces per slot (all grades): armour and jewels from its
// gear ladder, weapons from the datapack, one per distinct stats.
function lineItems(ctx, key) {
    const classRow = C.rowOfKey(ctx.tables.classes.classes, key);
    const gearClass = C.rowOfKey(ctx.tables.gear.classes, key);
    const bySlot = new Map();
    for (const slot of [...ARMOUR_SLOTS, ...JEWEL_SLOTS]) {
        bySlot.set(slot, (gearClass.slots[slot] || []).map(([id]) => ctx.items.get(id)).filter(item => item
            && (![10, 11, 15].includes(slot) || item.kind === classRow.armorKind) && (slot !== 8 || classRow.shield)));
    }
    const weapons = new Map();
    for (const item of ctx.allWeapons) if (classRow.weaponKinds.includes(item.kind)) weapons.set(JSON.stringify([item.rank, item.stats]), item);
    bySlot.set('weapon', [...weapons.values()]);
    return bySlot;
}

const kitIds = kit => [kit.weapon, ...ARMOUR_SLOTS.map(slot => kit[slot]), ...JEWEL_SLOTS.map(slot => kit[slot])];

// One level of a line: its numbers per part (cached), the mobs' rows per
// part (cached), the hold test.
function levelModel(ctx, key, level) {
    const { M, Profile, Mob, Gear, tables } = ctx;
    const rot = M.rotationOf(tables.rotation, key, level);
    if (!rot) return null;
    const naked = Profile.candidateProfiles(M.kitState(key, level, []), 0).before;
    const top = Gear.GRADES.indexOf(Gear.gradeForLevel(level));
    // A what-if keeps the formula's fast path only while the gear conditions
    // (armour kinds, set kind and effects, shield) stay its base kit's
    // (ColdCombatProfile.gearCandidate): one base kit per such group.
    const bases = new Map();
    const numbersOf = rows => {
        if (!rows.length) return naked;
        const ids = new Set(rows.map(row => row.selfId));
        const group = [rows.map(row => `${row.slot}:${ctx.kindOf(row.selfId)}`).sort().join(','),
            ctx.Sets.effectsForEquippedIds(ids).map(effect => effect.key).sort().join(',')].join('|');
        if (!bases.has(group)) bases.set(group, Profile.candidateProfiles(M.kitState(key, level, rows), 0).after);
        return { ...naked, ...bases.get(group)({ free: () => true, wear: rows }) };
    };
    const part = new Map();
    const cached = (name, ids, build) => {
        const id = `${name}|${ids.join(',')}`;
        if (!part.has(id)) part.set(id, build());
        return part.get(id);
    };
    const model = {
        level, rot, naked, top, rows: new Map(),
        weapon: id => cached('w', [id], () => ({ ids: id ? [id] : [], numbers: numbersOf(id ? [wearRow(ctx.itemOf(id))] : []) })),
        armour: kit => {
            const ids = ARMOUR_SLOTS.map(slot => kit[slot]).filter(Boolean);
            return cached('a', ids, () => ({ ids, numbers: numbersOf(ids.map(id => wearRow(ctx.itemOf(id)))) }));
        },
        jewels: kit => {
            const ids = JEWEL_SLOTS.map(slot => kit[slot]).filter(Boolean);
            return cached('j', ids, () => ({ ids, numbers: numbersOf(ids.flatMap(id => jewelRows(ctx.itemOf(id)))) }));
        },
        off: (weapon, mob) => cached(`o${mob.npcId}`, weapon.ids, () => {
            const terms = M.damageTerms(rot, weapon.numbers, mob.combat.evasion);
            const hit = terms.phys / Math.max(1, mob.combat.pDef) + terms.magic / Math.max(1, mob.combat.mDef);
            const dry = terms.dry / Math.max(1, mob.combat.pDef);
            const seconds = dps => dps > 0 ? +(mob.combat.maxHp / dps).toFixed(1) : null;
            return [seconds(hit * rot.shotMul), seconds(hit), seconds(dry)];
        }),
        phys: (armour, mob) => cached(`p${mob.npcId}`, armour.ids, () => {
            const mix = Mob.actionMix(mob.combat, { profile: armour.numbers }, 0, mob.fight);
            return [+(mix.perAction - mix.spellPerAction).toFixed(1), Math.round(mix.squarePerAction - mix.spellSquarePerAction),
                +mix.actionsPerSecond.toFixed(3)];
        }),
        magic: (jewels, mob) => cached(`m${mob.npcId}`, jewels.ids, () => {
            const mix = Mob.actionMix(mob.combat, { profile: jewels.numbers }, 0, mob.fight);
            return [+mix.spellPerAction.toFixed(1), Math.round(mix.spellSquarePerAction)];
        })
    };
    // Survives a bad fight: the damage's mean + 3 sigma under the bot's HP.
    model.survives = (weapon, armour, jewels, mob) => {
        const fight = model.off(weapon, mob)[0];
        if (fight === null) return false;
        const [pm, psq, aps] = model.phys(armour, mob), [sm, ssq] = model.magic(jewels, mob);
        const n = aps * fight, mean = (pm + sm) * n, variance = Math.max(0, n * (psq + ssq - Math.pow(pm + sm, 2)));
        return mean + SIGMA * Math.sqrt(variance) < armour.numbers.maxHp;
    };
    // Holds: survives some mob of full experience (gap <= 5) up to its level.
    const full = ctx.mobs.filter(mob => ctx.Experience.gapFactor(level - mob.combat.level) === 1 && mob.combat.level <= level);
    model.holds = kit => {
        if (!full.length) return true;
        const weapon = model.weapon(kit.weapon), armour = model.armour(kit), jewels = model.jewels(kit);
        return full.some(mob => model.survives(weapon, armour, jewels, mob));
    };
    model.statKey = kit => {
        const a = model.armour(kit).numbers, j = model.jewels(kit).numbers, w = model.weapon(kit.weapon).numbers;
        return [w.pAtk, w.mAtk, w.atkSpd, w.critical, w.accur, a.pDef, a.evasion, Math.round(a.maxHp), Math.round(a.maxMp), a.shieldPDef || 0, j.mDef].join('|');
    };
    return model;
}

// Every single-piece swap of a kit with pieces of grades up to the level's;
// a full body takes the chest and legs off, a chest or legs the full body.
function swaps(ctx, model, kit, pieces, only = null) {
    const out = [];
    for (const [slot, list] of pieces) for (const item of list) {
        if (ctx.Gear.GRADES.indexOf(item.rank) > model.top || kit[slot] === item.selfId) continue;
        if (only && !only.has(item.selfId)) continue;
        const next = { ...kit, [slot]: item.selfId };
        if (slot === 15) { next[10] = null; next[11] = null; }
        if (slot === 10 || slot === 11) next[15] = null;
        out.push(next);
    }
    return out;
}

function walk(ctx, key, last) {
    const pieces = lineItems(ctx, key);
    let kits = new Map([['naked', { weapon: null }]]);
    const used = new Set();
    const perLevel = {};
    let model = null;
    for (let level = 1; level <= last; level++) {
        model = levelModel(ctx, key, level);
        if (!model) continue;
        const next = new Map();
        let branched = 0, stuck = 0;
        for (const kit of kits.values()) {
            if (model.holds(kit)) { next.set(model.statKey(kit), kit); continue; }
            const saved = swaps(ctx, model, kit, pieces).filter(model.holds);
            if (!saved.length) { next.set(model.statKey(kit), { ...kit, stuck: level }); stuck += 1; continue; }
            branched += 1;
            for (const swap of saved) next.set(model.statKey(swap), { ...swap, stuck: undefined });
        }
        kits = next;
        for (const kit of kits.values()) for (const id of kitIds(kit)) if (id) used.add(id);
        perLevel[level] = { model, kits: [...kits.values()], branched, stuck };
    }
    // Pieces no path wore go on the final kits too.
    const unused = new Set([...pieces.values()].flat().map(item => item.selfId).filter(id => !used.has(id)));
    if (model && unused.size) {
        const end = perLevel[last];
        const extra = new Map(end.kits.map(kit => [model.statKey(kit), kit]));
        for (const kit of end.kits) for (const swap of swaps(ctx, model, kit, pieces, unused)) extra.set(model.statKey(swap), { ...swap, extra: true });
        end.kits = [...extra.values()];
    }
    return perLevel;
}

// The table rows of a level: its kits' parts against the mob window.
function levelRows(ctx, level, { model, kits, branched, stuck }) {
    const { Gear } = ctx;
    const weapons = new Map(), armours = new Map(), jewels = new Map();
    const kitRows = kits.map(kit => {
        const w = model.weapon(kit.weapon), a = model.armour(kit), j = model.jewels(kit);
        for (const [map, partOf] of [[weapons, w], [armours, a], [jewels, j]]) if (!map.has(partOf.ids.join(','))) map.set(partOf.ids.join(','), partOf);
        return [[...weapons.keys()].indexOf(w.ids.join(',')), [...armours.keys()].indexOf(a.ids.join(',')),
            [...jewels.keys()].indexOf(j.ids.join(',')), kit.stuck || 0, kit.extra ? 1 : 0];
    });
    const W = [...weapons.values()], A = [...armours.values()], J = [...jewels.values()];
    let low = level;
    while (low > 1 && Gear.GRADES.indexOf(Gear.gradeForLevel(low - 1)) >= model.top - 1) low -= 1;
    const window = [], off = W.map(() => []), phys = A.map(() => []), magic = J.map(() => []);
    const byLevel = new Map();
    for (const mob of ctx.mobs) if (mob.combat.level >= low) (byLevel.get(mob.combat.level) || byLevel.set(mob.combat.level, []).get(mob.combat.level)).push(mob);
    for (const mobLevel of [...byLevel.keys()].sort((x, y) => x - y)) {
        let survived = mobLevel <= level;
        for (const mob of byLevel.get(mobLevel)) {
            const o = W.map(w => model.off(w, mob)), p = A.map(a => model.phys(a, mob)), g = J.map(j => model.magic(j, mob));
            const w0 = o.reduce((b, row, i) => (row[0] ?? Infinity) < (o[b][0] ?? Infinity) ? i : b, 0);
            const a0 = p.reduce((b, row, i) => row[0] < p[b][0] ? i : b, 0), j0 = g.reduce((b, row, i) => row[0] < g[b][0] ? i : b, 0);
            if (model.survives(W[w0], A[a0], J[j0], mob)) survived = true;
            window.push(mob);
            o.forEach((row, i) => off[i].push(row));
            p.forEach((row, i) => phys[i].push(row));
            g.forEach((row, i) => magic[i].push(row));
        }
        if (!survived) break;
    }
    const pick = (list, fields) => list.map(({ ids, numbers }) => [ids, 1, ...fields.map(f => numbers[f])]);
    return {
        rot: { mpPerSec: model.rot.mpPerSec, shotMul: model.rot.shotMul },
        naked: { maxHp: model.naked.maxHp, maxMp: model.naked.maxMp, con: model.naked.con, men: model.naked.men },
        // Seated regeneration per 3 s tick (ColdRest), of the naked bot.
        regen: (({ hp, mp }) => ({ hp, mp }))(ctx.M.regenOf(C.parseKitKey(model.key || '0').classId, level, model.naked)),
        // Per mob: id, level, HP, exp and SP after the level gap, adena per kill (drop yield at this level).
        mobs: window.map(mob => {
            const gap = ctx.Experience.gapFactor(level - mob.combat.level);
            const adena = mob.reward ? ctx.Planner.itemDropYield(mob.reward, ADENA, 'drop', { npcLevel: mob.combat.level, killerLevel: level }).expectedYield : 0;
            return [mob.npcId, mob.combat.level, mob.combat.maxHp, Math.round(mob.exp * gap), Math.round(mob.sp * gap), Math.round(adena)];
        }),
        weapons: pick(W, ['pAtk', 'mAtk', 'atkSpd', 'critical', 'accur']),
        armour: pick(A, ['pDef', 'evasion', 'maxHp', 'maxMp', 'shieldPDef']),
        jewels: pick(J, ['mDef']),
        // [weapon, armour, jewels, stuck since level (0: holds), extra (a piece no path wore)]
        kits: kitRows,
        off, phys, magic,
        counts: { kits: kits.length, branched, stuck }
    };
}

function main() {
    const opts = args();
    C.boot();
    const M = require('../hunt-tables/HuntModel');
    const K = require('../hunt-tables/corrections');
    const ctx = { M, K, Profile: invoke('GameServer/Bot/Population/ColdCombatProfile'), Mob: invoke('GameServer/Bot/Population/ColdMobAction'),
        Gear: invoke('GameServer/Bot/AI/GearGradeRule'), Sets: invoke('GameServer/Items/C4ArmorSets'),
        Experience: invoke('GameServer/Progression/MobExperience'), Planner: invoke('GameServer/Bot/AI/GearAcquisitionPlanner'),
        tables: { classes: C.readTable('classes'), gear: C.readTable('gear'), mobs: C.readTable('mobs'), rotation: C.readTable('rotation'), spots: C.readTable('spots') } };
    ctx.items = K.itemRows(ctx.tables.gear);
    ctx.allWeapons = invoke('GameServer/DataCache').items.filter(item => String(item.template?.kind).startsWith('Weapon.'))
        .map(item => ({ selfId: item.selfId, kind: item.template.kind, slot: item.etc?.slot, rank: item.etc?.rank || 'none', stats: item.stats }));
    const weaponById = new Map(ctx.allWeapons.map(item => [item.selfId, item]));
    ctx.itemOf = id => ctx.items.get(id) || weaponById.get(id);
    ctx.kindOf = id => ctx.itemOf(id)?.kind;
    const npcIds = [...new Set(ctx.tables.spots.spots.flatMap(spot => spot[5].map(([npcId]) => npcId)))];
    ctx.mobs = npcIds.map(npcId => ({ npcId, ...K.mobInput(ctx.tables, npcId, 1) })).filter(mob => mob.combat)
        .map(mob => ({ ...mob, fight: ctx.Mob.coldMobFight(mob.combat) }))
        .sort((a, b) => a.combat.level - b.combat.level || a.npcId - b.npcId);
    const keys = opts.keys || Object.keys(ctx.tables.rotation.rows);
    fs.mkdirSync(opts.out, { recursive: true });
    for (const key of keys) {
        const started = Date.now();
        const perLevel = walk(ctx, key, opts.levels[1]);
        const levels = {};
        for (const [level, row] of Object.entries(perLevel)) {
            if (Number(level) < opts.levels[0]) continue;
            row.model.key = key;
            levels[level] = levelRows(ctx, Number(level), row);
            const c = levels[level].counts;
            console.log(`${key} ${level}: kits ${c.kits} (branched ${c.branched}, stuck ${c.stuck}), points ${levels[level].weapons.length}/${levels[level].armour.length}/${levels[level].jewels.length}, mobs ${levels[level].mobs.length}`);
        }
        const file = path.join(opts.out, `${key.replace('>', '-')}.json.gz`);
        fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ key, sha: require('child_process').execSync('git rev-parse HEAD').toString().trim(),
            layout: 'see scripts/fight-table/build.js header', levels })));
        console.log(`${key}: ${Object.keys(levels).length} levels, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
}

if (require.main === module) main();
