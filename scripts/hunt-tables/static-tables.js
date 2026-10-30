'use strict';

// The game-data tables of the hunt model (no combat runs):
// 1 mobs, 2 spots, 3 classes, 5 gear, 6 sources, 9 henna.

const C = require('./common');
const M = require('./HuntModel');

const { DataCache, Index, Profile } = M;
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Sources = require('../../src/GameServer/Items/ItemAcquisitionCatalog');
const Compat = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const { GRADES, levelForGrade } = invoke('GameServer/Bot/AI/GearGradeRule');
const NpcSkills = invoke('GameServer/Npc/NpcSkills');
const Hennas = invoke('GameServer/Henna/HennaRules');
const Shops = require('../../src/GameServer/World/Generics/NpcShopBuyLists');
const Luxury = invoke('GameServer/Bot/Economy/BotLuxuryExchange');
const Recipes = require('../../src/GameServer/Items/C4RecipeItems');
const ArmorSets = invoke('GameServer/Items/C4ArmorSets');
const ClassProgression = invoke('GameServer/ClassProgression');

// The level a gear piece is judged at for its class's ladder order (masteries
// of the second profession counted; the order does not move with the level
// otherwise: P.Atk and P.Def scale with it alike).
const LADDER_LEVEL = 40;
// A mob hits from range at or beyond this attack radius (melee mobs: 40-80).
const RANGED_RADIUS = 200;
const JEWEL_SLOTS = [1, 3, 4];
const WEAPON_SLOTS = [7, 14];

function spotRows() {
    return require('../../data/Bots/spot-reward-npcs.json').rows;
}

// ------------------------------------------------------------ 1 mobs

const COMBAT_FIELDS = ['level', 'maxHp', 'pAtk', 'pAtkRnd', 'pDef', 'mDef', 'mAtk', 'atkSpd', 'accur', 'evasion', 'critical',
    'atkRadius', 'hostile', 'undead', 'race', 'revHp', 'vulnerabilities'];

function compactRewards(groups = []) {
    return groups.map(group => [Number(group.overall) || 0,
        (group.items || []).map(item => [Number(item.selfId), Number(item.min) || 1, Number(item.max) || Number(item.min) || 1,
            Number(item.chance) || 0])]);
}

// The reward object of a card row in the DataCache shape (Planner.itemDropYield reads it).
function rewardsOf(rewardRow) {
    const groups = rows => rows.map(([overall, items]) => ({ overall,
        items: items.map(([selfId, min, max, chance]) => ({ selfId, min, max, chance })) }));
    return rewardRow ? { rewards: groups(rewardRow[0]), spoils: groups(rewardRow[1]) } : null;
}

function buildMobs() {
    NpcSkills.prepareThreats(DataCache.npcs);
    const ids = [...new Set(spotRows().flatMap(row => row[1].map(entry => Number(entry[0]))))].sort((a, b) => a - b);
    const combats = [], combatIndex = new Map(), rewards = [], rewardIndex = new Map(), mobs = [];
    for (const id of ids) {
        const npc = Index.find(DataCache.npcs, id);
        if (!npc) continue;
        const stats = Profile.npcCombatStats(npc);
        const vulnerabilities = Object.fromEntries(Object.entries(stats.vulnerabilities || {}).filter(([, value]) => value !== 1));
        const combat = [stats.level, stats.maxHp, stats.pAtk, stats.pAtkRnd, stats.pDef, stats.mDef, stats.mAtk, stats.atkSpd,
            C.round(stats.accur), C.round(stats.evasion), stats.critical, Number(npc.stats?.atkRadius) || 0,
            npc.template?.hostile === true ? 1 : 0, stats.undead ? 1 : 0, stats.race, C.round(Number(npc.vitals?.revHp) || 0),
            Object.keys(vulnerabilities).length ? vulnerabilities : 0];
        const key = JSON.stringify(combat);
        if (!combatIndex.has(key)) { combatIndex.set(key, combats.length); combats.push(combat); }
        const reward = Index.find(DataCache.npcRewards, id);
        const rewardRow = reward ? [compactRewards(reward.rewards), compactRewards(reward.spoils)] : null;
        let rewardAt = -1;
        if (rewardRow) {
            const rewardKey = JSON.stringify(rewardRow);
            if (!rewardIndex.has(rewardKey)) { rewardIndex.set(rewardKey, rewards.length); rewards.push(rewardRow); }
            rewardAt = rewardIndex.get(rewardKey);
        }
        // Danger: the cold fight's mobs only hit (BackgroundResolver.resolveFight);
        // the hot fight also casts. magic: an enemy spell (NpcSkills threat 3).
        const danger = NpcSkills.threatFor(id) === 3 ? 'magic' : combat[11] >= RANGED_RADIUS ? 'ranged' : 'physical';
        mobs.push([id, npc.template?.name || '', combatIndex.get(key), C.round(stats.rewardExp), stats.rewardSp, danger, rewardAt]);
    }
    return { combatFields: COMBAT_FIELDS, mobFields: ['id', 'name', 'combat', 'exp', 'sp', 'danger', 'rewards'],
        rewardFields: ['drops [[overall, [[item, min, max, chance]]]]', 'spoils (same)'], combats, rewards, mobs };
}

// ------------------------------------------------------------ 2 spots

// The world's spot catalogue as the spot table builds it (seeded spawn,
// pulls from the spawns, BotPullEstimate), with the nearest town of each.
function buildSpots() {
    const generator = require('../generate-spot-table');
    const catalogue = generator.buildCatalogue();
    const Towns = require('../../src/GameServer/World/TownRespawn');
    const spots = catalogue.profiles.filter(spot => spot.raidBoss !== true)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(spot => {
            const town = spot.center ? Towns.getClosestTown(spot.center.locX, spot.center.locY, spot.center.locZ) : null;
            return [spot.id, Number(spot.avgLevel), Number(spot.minLevel), Number(spot.maxLevel), Number(spot.density),
                (spot.npcEntries || []).map(entry => [Number(entry.selfId), Math.max(1, Number(entry.count) || 1),
                    C.round(Number(entry.pull) || 1, 3)]),
                town?.name || '', Number(spot.rewards?.adenaMin || 0), Number(spot.rewards?.adenaMax || 0),
                spot.center ? [Math.round(spot.center.locX), Math.round(spot.center.locY), Math.round(spot.center.locZ)] : null];
        });
    return { spotFields: ['id', 'avgLevel', 'minLevel', 'maxLevel', 'density', 'mobs [[npc, count, pull]]', 'town',
        'adenaMin', 'adenaMax', 'center'], spots, spawned: catalogue.spawned };
}

// ------------------------------------------------------------ 3 classes

const LEVEL_FIELDS = ['maxHp', 'maxMp', 'pAtk', 'mAtk', 'pDef', 'mDef', 'accur', 'evasion', 'critical', 'atkSpd', 'castSpd',
    'regenHp', 'regenMp'];

// key: C.kitKey (a split-kit first class per future: its line's role).
function classRow(key) {
    const { classId } = C.parseKitKey(key);
    const template = ClassProgression.firstClassRow(DataCache.classTemplates, classId) || {};
    const role = Roles.combatRoleFor({ classId, characterId: C.kitCharacterId(key), stats: { classId } });
    const naked = M.profileOf(M.kitState(key, 1));
    // The class's naked torso is the spellcaster's (equipmentFromTemplates);
    // read from its naked profile, not from a second class list.
    const spellcaster = naked.equipment.pDef === Profile.equipmentFromTemplates([], true, template.stats || {}).pDef
        && naked.equipment.pDef !== Profile.equipmentFromTemplates([], false, template.stats || {}).pDef;
    const levels = [];
    const passives = new Map();
    for (let level = 1; level <= C.MAX_LEVEL; level++) {
        const state = M.kitState(key, level);
        const profile = M.profileOf(state);
        const regen = M.regenOf(classId, level, profile);
        levels.push([...LEVEL_FIELDS.slice(0, 11).map(field => C.round(profile[field])), C.round(regen.hp), C.round(regen.mp)]);
        for (const skill of state.stats.coldCombat.skills) {
            if (!skill.passive) continue;
            const key = `${skill.selfId}:${skill.level}`;
            if (!passives.has(key)) passives.set(key, [Number(skill.selfId), Number(skill.level), level]);
        }
    }
    const nakedGear = Profile.equipmentFromTemplates([], spellcaster, template.stats || {});
    return { key: String(key), classId, name: template.template?.class || '', role, spellcaster, race: Number(template.template?.race) || 0,
        base: { ...(template.base || {}) }, classStats: { ...(template.stats || {}) },
        naked: { pDef: nakedGear.pDef, mDef: nakedGear.mDef },
        weaponKinds: Compat.weaponKindsFor(role, classId), armorKind: Compat.armorKindFor(role, classId),
        shield: Compat.usesShield(role, classId), hennaSlots: Hennas.slotsForClass(classId),
        levels, passives: [...passives.values()] };
}

function buildClasses() {
    const classes = C.kitKeys().map(classRow);
    return { levelFields: LEVEL_FIELDS, passiveFields: ['skill', 'level', 'fromLevel'], classes };
}

// ------------------------------------------------------------ 5 gear

function itemRow(item) {
    const stats = {};
    for (const stat of M.ITEM_STATS) {
        const value = Number(item.stats?.[stat]);
        if (Number.isFinite(value) && value !== 0) stats[stat] = value;
    }
    return { selfId: Number(item.selfId), name: item.template?.name || '', kind: item.template?.kind || '',
        slot: Number(item.etc?.slot) || 0, rank: String(item.etc?.rank || 'none').toLowerCase(),
        price: Number(item.template?.price) || 0, stats };
}

// The worn slots of one item (a jewel pair fills both of its slots).
function wornSlots(slot) {
    return slot === 1 || slot === 2 ? [1, 2] : slot === 4 || slot === 5 ? [4, 5] : [slot];
}
function wear(row) {
    return wornSlots(row.slot).map(slot => ({ selfId: row.selfId, slot }));
}

// A piece's worth to the class (its ladder order): a weapon by the class's
// damage stat (casters M.Atk; others P.Atk x attack speed x critical), an
// armour piece by P.Def, a shield by its block (P.Def x rate), a jewel by
// M.Def; each read from the class's profile
// wearing only the piece (masteries counted).
function pieceValue(key, row, caster) {
    const profile = M.profileOf(M.kitState(key, LADDER_LEVEL, wear(row)));
    if (WEAPON_SLOTS.includes(row.slot)) return caster ? profile.mAtk : profile.pAtk * profile.atkSpd * (1 + profile.critical / 1000);
    // A shield's P.Def blocks (shieldPDef), it is not in the profile's P.Def.
    if (row.slot === 8) return profile.equipment.shieldPDef * (profile.equipment.shieldRate || 0) / 100;
    return JEWEL_SLOTS.includes(row.slot) || row.slot === 2 || row.slot === 5 ? profile.mDef : profile.pDef;
}

// Drops the strictly dominated pieces: another piece at least as strong,
// wearable no later and no dearer (the cheaper weaker piece stays).
function undominated(list) {
    return list.filter(a => !list.some(b => b !== a && b.value >= a.value && b.wearLevel <= a.wearLevel && b.price <= a.price
        && (b.value > a.value || b.wearLevel < a.wearLevel || b.price < a.price || b.selfId < a.selfId)));
}

function gradeIndex(rank) {
    return GRADES.indexOf(rank);
}

function bestOf(list, rank, slots) {
    return list.filter(entry => entry.rank === rank && slots.includes(entry.slot)).sort((a, b) => b.value - a.value)[0] || null;
}

// The armour of a grade for a class: the best piece per slot (a full-body
// piece or chest + legs, whichever kit has the higher P.Def), or an armour
// set of the grade (its parts, the other slots best) when its P.Def is higher.
// suitable: every piece the class may wear (set parts are looked up there:
// the ladder drops a part an equal piece with a lower id dominates).
function armourOfGrade(key, ladder, rank, shield, suitable) {
    const pick = slots => bestOf(ladder, rank, slots);
    const defOf = list => list.length ? M.profileOf(M.kitState(key, LADDER_LEVEL, list.flatMap(wear))).pDef : 0;
    const chest = pick([10]), legs = pick([11]), full = pick([15]);
    const rest = [6, 9, 12, ...(shield ? [8] : [])].map(slot => pick([slot])).filter(Boolean);
    const split = [...[chest, legs].filter(Boolean), ...rest];
    const whole = full ? [full, ...rest] : null;
    const parts = whole && defOf(whole) >= defOf(split) ? whole : split;
    let best = parts, bestDef = defOf(parts);
    const byId = new Map(suitable.map(entry => [entry.selfId, entry]));
    for (const set of ArmorSets.ARMOR_SETS) {
        const chestPiece = byId.get(Number(set.chest));
        if (!chestPiece || chestPiece.rank !== rank) continue;
        const setParts = ['chest', 'legs', 'head', 'gloves', 'feet', ...(shield ? ['shield'] : [])]
            .map(part => Number(set[part])).filter(id => id > 0).map(id => byId.get(id) || null);
        if (setParts.some(part => !part)) continue;
        const taken = new Set(setParts.map(part => part.slot === 15 ? [10, 11, 15] : [part.slot]).flat());
        const rest = parts.filter(part => !(part.slot === 15 ? [10, 11, 15] : [part.slot]).some(slot => taken.has(slot)));
        const candidate = [...setParts, ...rest];
        const def = defOf(candidate);
        if (def > bestDef) { best = candidate; bestDef = def; }
    }
    return best;
}

function jewelsOfGrade(ladder, rank) {
    return [bestOf(ladder, rank, [3]), bestOf(ladder, rank, [1, 2]), bestOf(ladder, rank, [4, 5])].filter(Boolean);
}

function buildGear(classTable) {
    const items = new Map();
    const classes = [];
    const wearable = DataCache.items.filter(item => /^(Weapon|Armor)\./.test(item.template?.kind || '')
        && !/\.Pet$/.test(item.template?.kind || '') && Sources.hasSource(item.selfId));
    for (const cls of classTable.classes) {
        const classId = cls.classId, key = cls.key ?? String(classId);
        const caster = Compat.isCasterRole(cls.role);
        const state = { characterId: C.kitCharacterId(key), classId, level: LADDER_LEVEL, stats: { classId }, inventory: {} };
        const entries = [];
        for (const item of wearable) {
            const rank = String(item.etc?.rank || 'none').toLowerCase();
            if (!GRADES.includes(rank) || !Planner.suitable(item, state, cls.role, rank)) continue;
            const row = itemRow(item);
            items.set(row.selfId, row);
            entries.push({ selfId: row.selfId, slot: row.slot, rank, price: row.price, wearLevel: levelForGrade(rank) || 1,
                value: pieceValue(key, row, caster) });
        }
        const slots = {};
        const ladder = [];
        const groups = new Map();
        for (const entry of entries) {
            const group = WEAPON_SLOTS.includes(entry.slot) ? 'weapon' : entry.slot === 2 ? 1 : entry.slot === 5 ? 4 : entry.slot;
            if (!groups.has(group)) groups.set(group, []);
            groups.get(group).push(entry);
        }
        for (const [group, list] of groups) {
            const kept = undominated(list).sort((a, b) => b.value - a.value || a.price - b.price || a.selfId - b.selfId);
            slots[group] = kept.map(entry => [entry.selfId, C.round(entry.value)]);
            ladder.push(...kept);
        }
        // Weapon tiers: per grade the strongest and the weakest kept weapon.
        const weapons = [['none', []]];
        const armours = [['none', []]];
        for (const rank of GRADES) {
            const kept = ladder.filter(entry => entry.rank === rank && WEAPON_SLOTS.includes(entry.slot)).sort((a, b) => b.value - a.value);
            if (kept.length) weapons.push([`${rank}-top`, [kept[0].selfId]]);
            if (kept.length > 1) weapons.push([`${rank}-low`, [kept.at(-1).selfId]]);
            const armour = armourOfGrade(key, ladder, rank, cls.shield, entries);
            const jewels = jewelsOfGrade(ladder, rank);
            if (armour.length || jewels.length) armours.push([`${rank}-full`, [...armour, ...jewels].map(entry => entry.selfId)]);
            // The mix live bots wear: this grade's body, the grade below's rest.
            const below = GRADES[gradeIndex(rank) - 1];
            if (below && armour.length) {
                const body = armour.filter(entry => [10, 11, 15].includes(entry.slot));
                const rest = [...armourOfGrade(key, ladder, below, cls.shield, entries).filter(entry => ![10, 11, 15].includes(entry.slot)),
                    ...jewelsOfGrade(ladder, below)];
                armours.push([`${rank}-body`, [...body, ...rest].map(entry => entry.selfId)]);
            }
        }
        classes.push({ key, classId, slots, weaponTiers: weapons, armourTiers: armours });
    }
    const itemFields = ['selfId', 'name', 'kind', 'slot', 'rank', 'price', 'stats'];
    return { ladderLevel: LADDER_LEVEL, itemFields,
        items: [...items.values()].sort((a, b) => a.selfId - b.selfId).map(row => itemFields.map(field => row[field])),
        classes };
}

// ------------------------------------------------------------ 6 sources

function buildSources(mobTable, gearTable) {
    const wanted = new Set(gearTable.items.map(row => Number(row[0])));
    // The recipe tree under the gear: scrolls and materials, all the way down.
    const queue = [...wanted];
    while (queue.length) {
        const id = queue.pop();
        for (const recipe of Recipes.resolveVariantsByProductId(id)) {
            for (const next of [Number(recipe.recipeItemId), ...(recipe.materials || []).map(row => Number(row.selfId))]) {
                if (next > 0 && next !== 57 && !wanted.has(next)) { wanted.add(next); queue.push(next); }
            }
        }
    }
    const offers = Shops.townOffers();
    const luxury = Luxury.recipes();
    const drops = new Map(), spoils = new Map();
    for (const mob of mobTable.mobs) {
        const [mobId, , combatAt, , , , rewardAt] = mob;
        if (rewardAt < 0) continue;
        const reward = rewardsOf(mobTable.rewards[rewardAt]);
        const level = mobTable.combats[combatAt][0];
        const context = { npcLevel: level, killerLevel: level };
        for (const [kind, list, out] of [['drop', reward.rewards, drops], ['spoil', reward.spoils, spoils]]) {
            const ids = new Set(list.flatMap(group => group.items.map(item => item.selfId)));
            for (const id of ids) {
                if (!wanted.has(id)) continue;
                const chance = Planner.itemDropYield(reward, id, kind, context).chance;
                if (!(chance > 0)) continue;
                if (!out.has(id)) out.set(id, []);
                out.get(id).push([mobId, C.round(chance)]);
            }
        }
    }
    const items = [...wanted].sort((a, b) => a - b).map(id => {
        const npc = (offers?.offersFor(id) || []).map(offer => [Number(offer.sourceId), offer.town, Number(offer.price)]);
        const lux = luxury.get(id);
        const recipes = Recipes.resolveVariantsByProductId(id).map(recipe => [Number(recipe.recipeItemId) || 0, Number(recipe.level) || 0,
            Number(recipe.successRate) || 0, Number(recipe.productCount) || 1, Number(recipe.mpCost) || 0,
            (recipe.materials || []).map(row => [Number(row.selfId), Number(row.amount)])]);
        const sortChance = list => (list || []).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
        return [id, npc, lux ? [lux.npcId, lux.materials.map(row => [row.selfId, row.amount])] : null,
            sortChance(drops.get(id)), sortChance(spoils.get(id)), recipes];
    });
    return { itemFields: ['item', 'npc [[npc, town, price]]', 'luxury [npc, [[crystal, amount]]] (C4: crystals, no adena)',
        'drops [[mob, chance per kill, killer at mob level]]', 'spoils (same)',
        'recipes [[scroll, level, success %, count, mp, [[material, amount]]]]'], items };
}

// ------------------------------------------------------------ 9 henna

function buildHenna(classTable) {
    const data = require('../../data/Henna/c4-henna.json');
    const offers = Shops.townOffers();
    const dyePrice = id => Math.min(...(offers?.offersFor(id) || []).map(offer => Number(offer.price)).filter(price => price > 0), Infinity);
    const symbols = data.symbols.map(symbol => {
        const price = dyePrice(Number(symbol.dyeSelfId));
        return [symbol.id, symbol.name, Number(symbol.dyeSelfId), Number(symbol.dyeAmount), Number(symbol.price),
            Number.isFinite(price) ? price : null, ...M.BASE_STATS.map(stat => Number(symbol[stat.toUpperCase()]) || 0)];
    });
    // Hennas go by class, not by line: one row per class id.
    const classes = [...new Set(classTable.classes.map(cls => cls.classId))].map(classId => [classId, Hennas.slotsForClass(classId),
        Hennas.availableForClass(classId).map(symbol => symbol.id)]);
    return { source: data.source, symbolFields: ['id', 'name', 'dye', 'dyeAmount', 'fee', 'dyeNpcPrice',
        ...M.BASE_STATS.map(stat => stat.toUpperCase())], symbols, classFields: ['class', 'slots', 'symbols'], classes };
}

module.exports = { buildMobs, buildSpots, buildClasses, buildGear, buildSources, buildHenna, classRow, rewardsOf, wear, wornSlots,
    COMBAT_FIELDS, LEVEL_FIELDS };
