'use strict';

// Table 7, ceilings: per class, 2-level band, weapon tier and armour tier
// (table 5, grades up to the band's own) and danger (solo: one mob per pull;
// crowd: a spawn group that comes together), the highest mob level the bot
// takes on: its solo gate admits the level's typical mob (BotTargetMatchup
// soloCanHunt, the cold fight's own) and the formula's fight is more likely
// won than lost (death chance below one half, after table 8's correction).
//
// Walked as a staircase, never gear x mobs: per armour tier the weapon tiers
// go weakest to strongest and a stronger weapon's ceiling starts at the
// weaker's (a mob the weaker kit takes the stronger takes too); per kit the
// level is found by binary search (a mob the kit cannot take is not taken
// one level higher).

const C = require('./common');
const M = require('./HuntModel');
const K = require('./corrections');

const { GRADES, gradeForLevel } = invoke('GameServer/Bot/AI/GearGradeRule');

const MAX_MOB_LEVEL = 85;
const DANGERS = ['solo', 'crowd'];

function tierGrade(name) {
    return GRADES.indexOf(name.split('-')[0]);
}

// The typical mob of each level and danger: the median species by HP x
// P.Atk among the spot catalogue's (crowd: with its group's median pull).
function typicalMobs(tables) {
    const byLevel = {};
    const mobs = new Map(tables.mobs.mobs.map(mob => [mob[0], mob]));
    for (const spot of tables.spots.spots) for (const [npcId, , pull] of spot[5]) {
        const mob = mobs.get(npcId);
        if (!mob) continue;
        const level = tables.mobs.combats[mob[2]][0];
        const danger = pull > 1.05 ? 'crowd' : 'solo';
        const key = `${level}|${danger}`;
        (byLevel[key] ||= new Map()).set(npcId, [...(byLevel[key].get(npcId) || []), pull]);
    }
    const out = {};
    for (const [key, species] of Object.entries(byLevel)) {
        const rows = [...species.entries()].map(([npcId, pulls]) => {
            const combat = tables.mobs.combats[mobs.get(npcId)[2]];
            return { npcId, power: combat[1] * combat[2], pull: pulls.sort((a, b) => a - b)[Math.floor(pulls.length / 2)] };
        }).sort((a, b) => a.power - b.power || a.npcId - b.npcId);
        const typical = rows[Math.floor(rows.length / 2)];
        out[key] = K.mobInput(tables, typical.npcId, typical.pull);
    }
    return out;
}

function takes(bot, mob, correction = null) {
    if (!mob) return null;
    const hour = M.mobHour(bot, mob, correction);
    return hour !== null && hour.deathChance < 0.5;
}

// The highest level in [from, MAX_MOB_LEVEL] the kit takes, from a level it
// is known to take (from - 1; 0 = none known).
function ceiling(bot, typical, danger, from, correction) {
    let low = from, high = MAX_MOB_LEVEL;
    const at = level => {
        // A level with no mob of the danger reads its nearest lower level's.
        for (let l = level; l >= 1; l--) if (typical[`${l}|${danger}`]) return takes(bot, typical[`${l}|${danger}`], correction);
        return false;
    };
    if (low > 0 && !at(low)) low = 0;
    while (low < high) {
        const mid = Math.ceil((low + high + 1) / 2) > high ? high : Math.ceil((low + high) / 2);
        if (at(mid)) low = mid;
        else high = mid - 1;
    }
    return low;
}

function build(classTable, gearTable, mobTable, rotationTable, correctionTable) {
    const tables = { classes: classTable, gear: gearTable, mobs: mobTable, rotation: rotationTable, spots: C.readTable('spots') };
    const typical = typicalMobs(tables);
    const items = K.itemRows(gearTable);
    const rows = {};
    let cells = 0, evaluations = 0;
    for (const [classKey, bands] of Object.entries(rotationTable.rows)) {
        const { classId } = C.parseKitKey(classKey);
        const gearClass = C.rowOfKey(gearTable.classes, classKey);
        rows[classKey] = {};
        for (const bandKey of Object.keys(bands)) {
            const level = Math.max(1, Math.min(C.MAX_LEVEL, 2 * Number(bandKey) + 1));
            const top = GRADES.indexOf(gradeForLevel(level));
            const weapons = gearClass.weaponTiers.filter(([name]) => name === 'none' || tierGrade(name) <= top);
            const armours = gearClass.armourTiers.filter(([name]) => name === 'none' || tierGrade(name) <= top);
            const rot = M.rotationOf(rotationTable, classKey, level);
            const out = [];
            for (const [, armourIds] of armours) {
                // Weakest weapon first: the staircase climbs with the kit.
                const kits = weapons.map(([name, weaponIds]) => {
                    const profile = M.profileOf(M.kitState(classKey, level, K.wearList([...weaponIds, ...armourIds], items)));
                    return { name, profile };
                }).map((kit, index) => ({ ...kit, index }))
                    .sort((a, b) => a.profile.pAtk * a.profile.atkSpd + a.profile.mAtk - (b.profile.pAtk * b.profile.atkSpd + b.profile.mAtk));
                const row = new Array(weapons.length);
                const from = { solo: 0, crowd: 0 };
                for (const kit of kits) {
                    const bot = { key: classKey, classId, level, profile: kit.profile, rot, shots: true };
                    const cell = DANGERS.map(danger => {
                        const row = correctionTable.corrections[`${K.rotKind(rot)}|${danger}`];
                        const value = ceiling(bot, typical, danger, from[danger], row ? { kph: row[0], deaths: row[1] } : null);
                        evaluations += 1;
                        from[danger] = value;
                        return value;
                    });
                    row[kit.index] = cell;
                    cells += 1;
                }
                out.push(row);
            }
            rows[classKey][bandKey] = out;
        }
    }
    return { body: { bandLevels: 2, dangers: DANGERS, layout: 'rows[class][band][armourTier][weaponTier] = [solo, crowd] (tiers: gear.json'
        + ' classes[].armourTiers / weaponTiers, filtered to grades <= the band level grade, in table order)', maxMobLevel: MAX_MOB_LEVEL,
    typical: Object.fromEntries(Object.entries(typical).map(([key, mob]) => [key, [mob.combat.level, mob.pull]])), rows },
    counts: { classes: Object.keys(rows).length, kits: cells, ceilings: cells * DANGERS.length, searches: evaluations },
    inputs: { deathChanceBelow: 0.5, maxMobLevel: MAX_MOB_LEVEL } };
}

module.exports = { build, typicalMobs, takes };
