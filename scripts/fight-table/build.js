#!/usr/bin/env node
'use strict';

// The big fight table (T128, docs/game-decisions.md "Kit and party tables"):
// one bot against one mob, every level, kept offline as raw quantities (no
// prices, no rest policy). The hunt formula (HuntModel.mobHour) splits
// exactly in two: the fight's length reads the bot's offence only, the
// mob's damage on the bot its defence only (ColdMobAction.actionMix: weapon
// hits and physical skills by P.Def, evasion and shield, spells by M.Def).
// So per class line and level the table keeps three small sets of points
// instead of every kit:
//   weapons  offence points (one per weapon, naked otherwise) x mob:
//            fight seconds with shots, without, and dry (out of MP)
//   armour   defence points (armour pieces, sets) x mob: the mob's physical
//            damage per action (mean, second moment) and actions per second
//   jewels   M.Def points x mob: its spell damage per action (mean, second)
// A kit is a weapon point, an armour point and a jewel point; its fight is
// assembled from the three (analysis), its death from the damage spread.
// Mob window: from the grade's first level up while any kit survives
// (buildLevel). Out: one gzipped JSON per line.
// Items: the gear table's per-slot ladders (dominated pieces out), grades
// up to the level's and one below, plus an empty slot.
//
// Usage: node scripts/fight-table/build.js [--keys=7>9,...] [--levels=1-78] [--out=tmp/fight-table]
// Run through ~/Games/tools/check.sh (background priority).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../hunt-tables/common');

const ARMOUR_SLOTS = [6, 9, 10, 11, 12, 15, 8];
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

// The pieces a class line may wear in a slot at a level: its ladder's rows
// of the level's grade and the one below, its armour kind for body slots.
function slotChoices(gearClass, classRow, items, slot, grades) {
    const ids = (gearClass.slots[slot] || []).map(([id]) => id);
    return ids.map(id => items.get(id)).filter(item => item && grades.has(item.rank)
        && (![10, 11, 15].includes(slot) || item.kind === classRow.armorKind)
        && (slot !== 8 || classRow.shield));
}

function product(lists) {
    return lists.reduce((all, list) => all.flatMap(prefix => list.map(item => [...prefix, item])), [[]]);
}

function wearRow(item) {
    return { selfId: item.selfId, objectId: item.selfId, enchant: 0, slot: item.slot };
}

function buildLevel(ctx, key, level) {
    const { M, K, Profile, Mob, Gear, tables, items, mobs } = ctx;
    const { classId } = C.parseKitKey(key);
    const classRow = C.rowOfKey(tables.classes.classes, key);
    const gearClass = C.rowOfKey(tables.gear.classes, key);
    const top = Gear.GRADES.indexOf(Gear.gradeForLevel(level));
    const grades = new Set(['none', Gear.GRADES[top], Gear.GRADES[Math.max(0, top - 1)]]);
    const rot = M.rotationOf(tables.rotation, key, level);
    if (!rot) return null;
    const state = M.kitState(key, level, []);
    const { before, after } = Profile.candidateProfiles(state, 0);
    const naked = before;

    // Offence: one point per weapon, the rest naked.
    const weapons = (gearClass.slots.weapon || []).map(([id]) => items.get(id))
        .filter(item => item && grades.has(item.rank) && classRow.weaponKinds.includes(item.kind));
    const offence = weapons.map(item => ({ ids: [item.selfId], numbers: { ...naked, ...after({ free: () => false, wear: [wearRow(item)] }) } }));
    offence.unshift({ ids: [], numbers: naked });

    // Defence: every mix of the armour slots (body: chest x legs or a full
    // body), jewels apart; points merged on equal numbers.
    const choice = slot => [null, ...slotChoices(gearClass, classRow, items, slot, grades)];
    const fulls = slotChoices(gearClass, classRow, items, 15, grades);
    const bodies = [...product([choice(10), choice(11)]), ...fulls.map(full => [full, null])];
    const rest = product([choice(6), choice(9), choice(12), choice(8)]);
    // A what-if keeps the formula's fast path only while the gear conditions
    // (armour kinds, set kind and effects, shield) stay its base kit's
    // (ColdCombatProfile.gearCandidate): one base kit per such group.
    const bases = new Map();
    const swap = worn => {
        const ids = new Set(worn.map(item => item.selfId));
        const group = [worn.map(item => `${item.slot}:${item.kind}`).sort().join(','),
            ctx.Sets.effectsForEquippedIds(ids).map(effect => effect.key).sort().join(',')].join('|');
        if (!bases.has(group)) bases.set(group, Profile.candidateProfiles(M.kitState(key, level, worn.map(wearRow)), 0).after);
        return bases.get(group)({ free: () => true, wear: worn.map(wearRow) });
    };
    const armour = new Map();
    for (const body of bodies) for (const other of rest) {
        const worn = [...body, ...other].filter(Boolean);
        const n = worn.length ? swap(worn) : naked;
        const point = [n.pDef, n.evasion, Math.round(n.maxHp), Math.round(n.maxMp ?? naked.maxMp), Math.round(n.shieldPDef || 0)].join('|');
        if (!armour.has(point)) armour.set(point, { ids: worn.map(item => item.selfId), kits: 0, numbers: { ...naked, ...n } });
        armour.get(point).kits += 1;
    }
    const jewels = new Map();
    for (const set of product(JEWEL_SLOTS.map(slot => [null, ...slotChoices(gearClass, classRow, items, slot, grades)]))) {
        const worn = set.filter(Boolean).flatMap(item => item.slot === 4 ? [item] : [item, { ...item, slot: item.slot + 1 }]);
        const n = worn.length ? swap(worn) : naked;
        const point = String(n.mDef);
        if (!jewels.has(point)) jewels.set(point, { ids: set.filter(Boolean).map(item => item.selfId), kits: 0, numbers: { ...naked, ...n } });
        jewels.get(point).kits += 1;
    }

    // Mobs from the level's grade low end (its first level) up, level by
    // level, while the strongest parts (each mob's fastest weapon, least
    // hurt armour and jewels: a bound on every kit) still kill before the
    // mean damage kills the bot; the first mob level none survives ends it.
    let low = level;
    while (low > 1 && Gear.gradeForLevel(low - 1) === Gear.gradeForLevel(level)) low -= 1;
    const armourPoints = [...armour.values()], jewelPoints = [...jewels.values()];
    const maxHp = Math.max(...armourPoints.map(point => point.numbers.maxHp));
    const window = [], off = offence.map(() => []), phys = armourPoints.map(() => []), magic = jewelPoints.map(() => []);
    const byLevel = new Map();
    for (const mob of mobs) if (mob.combat.level >= low) (byLevel.get(mob.combat.level) || byLevel.set(mob.combat.level, []).get(mob.combat.level)).push(mob);
    for (const mobLevel of [...byLevel.keys()].sort((x, y) => x - y)) {
        let survived = mobLevel <= level;
        for (const mob of byLevel.get(mobLevel)) {
            const o = offence.map(({ numbers }) => {
                const terms = M.damageTerms(rot, numbers, mob.combat.evasion);
                const hit = terms.phys / Math.max(1, mob.combat.pDef) + terms.magic / Math.max(1, mob.combat.mDef);
                const dry = terms.dry / Math.max(1, mob.combat.pDef);
                const seconds = dps => dps > 0 ? +(mob.combat.maxHp / dps).toFixed(1) : null;
                return [seconds(hit * rot.shotMul), seconds(hit), seconds(dry)];
            });
            const p = armourPoints.map(({ numbers }) => {
                const mix = Mob.actionMix(mob.combat, { profile: numbers }, 0, mob.fight);
                return [+(mix.perAction - mix.spellPerAction).toFixed(1), Math.round(mix.squarePerAction - mix.spellSquarePerAction),
                    +mix.actionsPerSecond.toFixed(3)];
            });
            const g = jewelPoints.map(({ numbers }) => {
                const mix = Mob.actionMix(mob.combat, { profile: numbers }, 0, mob.fight);
                return [+mix.spellPerAction.toFixed(1), Math.round(mix.spellSquarePerAction)];
            });
            const fight = Math.min(...o.map(row => row[0] ?? Infinity));
            const taken = (Math.min(...p.map(row => row[0])) + Math.min(...g.map(row => row[0]))) * Math.max(...p.map(row => row[2])) * fight;
            if (taken < maxHp) survived = true;
            window.push(mob);
            o.forEach((row, i) => off[i].push(row));
            p.forEach((row, i) => phys[i].push(row));
            g.forEach((row, i) => magic[i].push(row));
        }
        if (!survived) break;
    }
    const pick = (list, fields) => list.map(({ ids, kits, numbers }) => [ids, kits ?? 1, ...fields.map(f => numbers[f])]);
    return {
        rot: { mpPerSec: rot.mpPerSec, shotMul: rot.shotMul },
        naked: { maxHp: naked.maxHp, maxMp: naked.maxMp, con: naked.con, men: naked.men },
        mobs: window.map(mob => [mob.npcId, mob.combat.level, mob.combat.maxHp, mob.exp, mob.sp]),
        weapons: pick(offence, ['pAtk', 'mAtk', 'atkSpd', 'critical', 'accur']),
        armour: pick([...armour.values()], ['pDef', 'evasion', 'maxHp', 'maxMp', 'shieldPDef']),
        jewels: pick([...jewels.values()], ['mDef']),
        off, phys, magic,
        counts: { armourKits: bodies.length * rest.length, jewelKits: [...jewels.values()].reduce((sum, jewel) => sum + jewel.kits, 0) }
    };
}

function main() {
    const opts = args();
    C.boot();
    const M = require('../hunt-tables/HuntModel');
    const K = require('../hunt-tables/corrections');
    const ctx = { M, K, Profile: invoke('GameServer/Bot/Population/ColdCombatProfile'), Mob: invoke('GameServer/Bot/Population/ColdMobAction'),
        Gear: invoke('GameServer/Bot/AI/GearGradeRule'), Sets: invoke('GameServer/Items/C4ArmorSets'),
        tables: { classes: C.readTable('classes'), gear: C.readTable('gear'), mobs: C.readTable('mobs'), rotation: C.readTable('rotation'), spots: C.readTable('spots') } };
    ctx.items = K.itemRows(ctx.tables.gear);
    const npcIds = [...new Set(ctx.tables.spots.spots.flatMap(spot => spot[5].map(([npcId]) => npcId)))];
    ctx.mobs = npcIds.map(npcId => ({ npcId, ...K.mobInput(ctx.tables, npcId, 1) })).filter(mob => mob.combat)
        .map(mob => ({ ...mob, fight: ctx.Mob.coldMobFight(mob.combat) }))
        .sort((a, b) => a.combat.level - b.combat.level || a.npcId - b.npcId);
    const keys = opts.keys || Object.keys(ctx.tables.rotation.rows);
    fs.mkdirSync(opts.out, { recursive: true });
    for (const key of keys) {
        const started = Date.now();
        const levels = {};
        for (let level = opts.levels[0]; level <= opts.levels[1]; level++) levels[level] = buildLevel(ctx, key, level);
        const file = path.join(opts.out, `${key.replace('>', '-')}.json.gz`);
        fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ key, sha: require('child_process').execSync('git rev-parse HEAD').toString().trim(), layout: 'see scripts/fight-table/build.js header', levels })));
        console.log(`${key}: ${Object.keys(levels).length} levels, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
}

if (require.main === module) main();
