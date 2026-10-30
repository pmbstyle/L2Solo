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
// Items: the gear table's per-slot ladders (dominated pieces out), weapons
// from the datapack. The first grade may leave slots empty; each later grade
// mixes its own pieces with those that succeeded at the end of the grade
// below (survive a bad fight against a mob of their grade), slots full.
//
// Usage: node scripts/fight-table/build.js [--keys=7>9,...] [--levels=1-78] [--out=tmp/fight-table]
// Run through ~/Games/tools/check.sh (background priority).

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const C = require('../hunt-tables/common');

const ADENA = 57;
const SIGMA = 3;
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

// The pieces a class line may wear in a slot at a level: in the first grade
// (no grade) its ladder's rows or nothing; later the pieces the kits that
// succeeded at the end of the grade below wore (carry) and its own grade's.
function slotChoices(ctx, gearClass, classRow, slot, grade, carry) {
    const own = (gearClass.slots[slot] || []).map(([id]) => ctx.items.get(id)).filter(item => item && item.rank === grade
        && (![10, 11, 15].includes(slot) || item.kind === classRow.armorKind) && (slot !== 8 || classRow.shield));
    if (!carry) return [null, ...own];
    const carried = [...(carry.get(slot) || [])].map(id => ctx.items.get(id)).filter(Boolean);
    const both = [...new Map([...carried, ...own].map(item => [item.selfId, item])).values()];
    // A slot the line never fills (a shield for an archer) stays empty.
    return both.length ? both : [null];
}

// The class line's weapons of a grade from the datapack (every bow, not the
// ladder's undominated few), one per distinct stats.
function weaponChoices(ctx, classRow, grade, carry) {
    const own = new Map();
    for (const item of ctx.allWeapons) {
        if (item.rank !== grade || !classRow.weaponKinds.includes(item.kind)) continue;
        own.set(JSON.stringify(item.stats), item);
    }
    const carried = [...(carry?.get('weapon') || [])].map(id => ctx.weaponById.get(id)).filter(Boolean);
    return [...new Map([...carried, ...own.values()].map(item => [item.selfId, item])).values()];
}

function product(lists) {
    return lists.reduce((all, list) => all.flatMap(prefix => list.map(item => [...prefix, item])), [[]]);
}

function wearRow(item) {
    return { selfId: item.selfId, objectId: item.selfId, enchant: 0, slot: item.slot };
}

function buildLevel(ctx, key, level, carry) {
    const { M, K, Profile, Mob, Gear, tables, items, mobs } = ctx;
    const { classId } = C.parseKitKey(key);
    const classRow = C.rowOfKey(tables.classes.classes, key);
    const gearClass = C.rowOfKey(tables.gear.classes, key);
    const top = Gear.GRADES.indexOf(Gear.gradeForLevel(level));
    const grade = Gear.GRADES[top];
    const rot = M.rotationOf(tables.rotation, key, level);
    if (!rot) return null;
    const state = M.kitState(key, level, []);
    const { before, after } = Profile.candidateProfiles(state, 0);
    const naked = before;

    // Offence: one point per weapon, the rest naked.
    const weapons = weaponChoices(ctx, classRow, grade, carry);
    const offence = weapons.map(item => ({ ids: [item.selfId], numbers: { ...naked, ...after({ free: () => false, wear: [wearRow(item)] }) } }));
    if (!carry) offence.unshift({ ids: [], numbers: naked });

    // Defence: every mix of the armour slots (body: chest x legs or a full
    // body), jewels apart; points merged on equal numbers.
    const choice = slot => slotChoices(ctx, gearClass, classRow, slot, grade, carry);
    const fulls = choice(15).filter(Boolean);
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
        if (!armour.has(point)) armour.set(point, { ids: worn.map(item => item.selfId), kits: 0, numbers: { ...naked, ...n }, worn: new Set() });
        armour.get(point).kits += 1;
        for (const item of worn) armour.get(point).worn.add(item.selfId);
    }
    const jewels = new Map();
    for (const set of product(JEWEL_SLOTS.map(slot => slotChoices(ctx, gearClass, classRow, slot, grade, carry)))) {
        const worn = set.filter(Boolean).flatMap(item => item.slot === 4 ? [item] : [item, { ...item, slot: item.slot + 1 }]);
        const n = worn.length ? swap(worn) : naked;
        const point = String(n.mDef);
        if (!jewels.has(point)) jewels.set(point, { ids: set.filter(Boolean).map(item => item.selfId), kits: 0, numbers: { ...naked, ...n }, worn: new Set() });
        jewels.get(point).kits += 1;
        for (const item of set.filter(Boolean)) jewels.get(point).worn.add(item.selfId);
    }

    // Mobs from the level's grade low end (its first level) up, level by
    // level, while the strongest parts (each mob's fastest weapon, least
    // hurt armour and jewels: a bound on every kit) still kill before the
    // mean damage kills the bot; the first mob level none survives ends it.
    // A bot new to a grade still farms the grade below: from its first level.
    let low = level;
    while (low > 1 && Gear.GRADES.indexOf(Gear.gradeForLevel(low - 1)) >= top - 1) low -= 1;
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
    // The grade's last level: the pieces of every part that succeeded (with the
    // strongest other parts it survives a bad fight, mean + 3 sigma, against
    // a mob of its own grade) carry into the next grade (main).
    let survivors = null;
    if (Gear.gradeForLevel(level + 1) !== Gear.gradeForLevel(level)) {
        let gradeLow = level;
        while (gradeLow > 1 && Gear.gradeForLevel(gradeLow - 1) === grade) gradeLow -= 1;
        const own = window.map((mob, m) => mob.combat.level >= gradeLow ? m : -1).filter(m => m >= 0);
        const bad = (fight, pm, psq, aps, sm, ssq, life) => {
            const n = aps * fight, mean = (pm + sm) * n, variance = Math.max(0, n * (psq + ssq - Math.pow(pm + sm, 2)));
            return mean + SIGMA * Math.sqrt(variance) < life;
        };
        const fastest = m => off.reduce((best, row, w) => (row[m][0] ?? Infinity) < (off[best][m][0] ?? Infinity) ? w : best, 0);
        const lightest = (rows, m) => rows.reduce((best, row, i) => row[m][0] < rows[best][m][0] ? i : best, 0);
        const ok = (w, a, j, m) => off[w][m][0] !== null && bad(off[w][m][0], ...phys[a][m], ...magic[j][m], armourPoints[a].numbers.maxHp);
        const keep = { weapon: new Set(), armour: new Set(), jewel: new Set() };
        for (const m of own) {
            const w0 = fastest(m), a0 = lightest(phys, m), j0 = lightest(magic, m);
            off.forEach((_, w) => ok(w, a0, j0, m) && keep.weapon.add(w));
            phys.forEach((_, a) => ok(w0, a, j0, m) && keep.armour.add(a));
            magic.forEach((_, j) => ok(w0, a0, j, m) && keep.jewel.add(j));
        }
        survivors = new Map([['weapon', new Set([...keep.weapon].flatMap(w => offence[w].ids))]]);
        for (const a of keep.armour) for (const id of armourPoints[a].worn) {
            const slot = ctx.items.get(id).slot;
            (survivors.get(slot) || survivors.set(slot, new Set()).get(slot)).add(id);
        }
        for (const j of keep.jewel) for (const id of jewelPoints[j].worn) {
            const slot = ctx.items.get(id).slot;
            (survivors.get(slot) || survivors.set(slot, new Set()).get(slot)).add(id);
        }
    }
    const pick = (list, fields) => list.map(({ ids, kits, numbers }) => [ids, kits ?? 1, ...fields.map(f => numbers[f])]);
    return {
        survivorSets: survivors,
        rot: { mpPerSec: rot.mpPerSec, shotMul: rot.shotMul },
        naked: { maxHp: naked.maxHp, maxMp: naked.maxMp, con: naked.con, men: naked.men },
        // Per mob: id, level, HP, exp and SP after the level gap, adena per kill (drop yield at this level).
        mobs: window.map(mob => {
            const gap = ctx.Experience.gapFactor(level - mob.combat.level);
            const adena = mob.reward ? ctx.Planner.itemDropYield(mob.reward, ADENA, 'drop', { npcLevel: mob.combat.level, killerLevel: level }).expectedYield : 0;
            return [mob.npcId, mob.combat.level, mob.combat.maxHp, Math.round(mob.exp * gap), Math.round(mob.sp * gap), Math.round(adena)];
        }),
        // Seated regeneration per 3 s tick (ColdRest), of the naked bot.
        regen: (({ hp, mp }) => ({ hp, mp }))(M.regenOf(classId, level, naked)),
        weapons: pick(offence, ['pAtk', 'mAtk', 'atkSpd', 'critical', 'accur']),
        armour: pick([...armour.values()], ['pDef', 'evasion', 'maxHp', 'maxMp', 'shieldPDef']),
        jewels: pick([...jewels.values()], ['mDef']),
        off, phys, magic,
        carried: carry ? Object.fromEntries([...carry].map(([slot, ids]) => [slot, [...ids]])) : null,
        survivors: survivors ? Object.fromEntries([...survivors].map(([slot, ids]) => [slot, [...ids]])) : null,
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
        Experience: invoke('GameServer/Progression/MobExperience'), Planner: invoke('GameServer/Bot/AI/GearAcquisitionPlanner'),
        tables: { classes: C.readTable('classes'), gear: C.readTable('gear'), mobs: C.readTable('mobs'), rotation: C.readTable('rotation'), spots: C.readTable('spots') } };
    ctx.items = K.itemRows(ctx.tables.gear);
    ctx.allWeapons = invoke('GameServer/DataCache').items.filter(item => String(item.template?.kind).startsWith('Weapon.'))
        .map(item => ({ selfId: item.selfId, kind: item.template.kind, slot: item.etc?.slot, rank: item.etc?.rank || 'none', stats: item.stats }));
    ctx.weaponById = new Map(ctx.allWeapons.map(item => [item.selfId, item]));
    const npcIds = [...new Set(ctx.tables.spots.spots.flatMap(spot => spot[5].map(([npcId]) => npcId)))];
    ctx.mobs = npcIds.map(npcId => ({ npcId, ...K.mobInput(ctx.tables, npcId, 1) })).filter(mob => mob.combat)
        .map(mob => ({ ...mob, fight: ctx.Mob.coldMobFight(mob.combat) }))
        .sort((a, b) => a.combat.level - b.combat.level || a.npcId - b.npcId);
    const keys = opts.keys || Object.keys(ctx.tables.rotation.rows);
    fs.mkdirSync(opts.out, { recursive: true });
    for (const key of keys) {
        const started = Date.now();
        const levels = {};
        // The grades run in order from level 1: each starts from the pieces
        // that succeeded at the end of the one below (buildLevel survivors).
        let carry = null;
        for (let level = 1; level <= opts.levels[1]; level++) {
            const row = buildLevel(ctx, key, level, carry);
            if (row?.survivorSets) carry = row.survivorSets;
            if (row) delete row.survivorSets;
            if (level >= opts.levels[0]) levels[level] = row;
        }
        const file = path.join(opts.out, `${key.replace('>', '-')}.json.gz`);
        fs.writeFileSync(file, zlib.gzipSync(JSON.stringify({ key, sha: require('child_process').execSync('git rev-parse HEAD').toString().trim(), layout: 'see scripts/fight-table/build.js header', levels })));
        console.log(`${key}: ${Object.keys(levels).length} levels, ${(fs.statSync(file).size / 1e6).toFixed(1)} MB, ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
}

if (require.main === module) main();
