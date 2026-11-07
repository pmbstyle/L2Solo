'use strict';
const Table = require('./SpotValueTable');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const ClassProgression = invoke('GameServer/ClassProgression');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const Formulas = invoke('GameServer/Formulas');
const Diagnostics = require('../Economy/EconomyDiagnostics');
const Hunt = invoke('GameServer/Bot/AI/BotHuntEfficiency');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const ColdRest = invoke('GameServer/Bot/Population/ColdRest');
const Rewards = require('../Economy/SpotRewardExpectation');
const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');

// The hunt cycle model (T60): what an hour of a kit earns at a spot, the one
// answer to "what does this gear, enchant, henna or potion add". The spot
// table measures one kill of the reference bot (the role's class in the
// author's kit, SpotValueTable.cycle): fight and rest seconds, the mob's
// damage and the HP and MP the rest refills. A kit scales them against the
// reference's numbers at the bot's level, with the cold fight's formulas
// (BackgroundResolver.resolveFight, hitSucceeds; ColdRest):
// - fight time by the damage rate (physical: P.Atk x attack speed x hit
//   chance against the kills' evasion x critical; magic: sqrt(M.Atk) x cast
//   speed);
// - damage taken by the fight time and the mob's damage per second: its hits
//   (hit chance against the bot's evasion, over P.Def) and its spells (over
//   M.Def) in the shares the table measured;
// - rest by the HP and MP lost over the kit's seated regeneration (CON, MEN),
//   beyond what the reference regenerates outside its rest;
// - deaths by the damage of a kill over the bot's HP.
// An hour = kills x (fight + rest + the reference's idle seconds per kill),
// capped by the spot; income = kills x (money - shots - potions - deaths x
// the death price).

const REFERENCE_ID = 990001;
// A guard of the search below: each id is a fair pick among two or three classes.
const REFERENCE_ID_SEARCH = 1000;
// The reference bot's character id. A split-kit first class fights with the
// kit of its future second class (BotRoles.kitClassId, a pick by its id:
// weapon, pet): the first id whose future is the line's second class, else
// one whose future keeps the class's own role and pet (a class-only reference).
function referenceId(classId, line = null) {
    const own = Roles.inferRole(classId), ownPet = Roles.isSummoner(classId);
    const target = ClassProgression.secondProfMap[classId]?.includes(Number(line)) ? Number(line) : null;
    for (let characterId = REFERENCE_ID; characterId < REFERENCE_ID + REFERENCE_ID_SEARCH; characterId++) {
        const future = Roles.kitClassId({ classId, characterId });
        if (future === null) return REFERENCE_ID;
        if (target ? future === target : Roles.inferRole(future) === own && Roles.isSummoner(future) === ownPet) return characterId;
    }
    return REFERENCE_ID;
}

// The reference bot of a class at a level: the author's kit for the level
// (BotGear), its whole learned skill tree. The spot table measures it
// (scripts/generate-spot-table.js); deps replace the gear and profile owners
// in the generator's tests; line: the table line's second class it fights for.
function referenceState(classId, level, { gear = BotGear, profile = Profile, line = null } = {}) {
    const characterId = referenceId(classId, line);
    const inventory = {};
    for (const entry of gear.planFor({ classId, level, characterId }).items) {
        const key = `kit-${entry.selfId}`;
        const prior = inventory[key];
        const amount = (prior?.amount || 0) + 1;
        inventory[key] = { selfId: Number(entry.selfId), amount, equipped: true, equippedCount: amount,
            equippedSlots: [...(prior?.equippedSlots || []), Number(entry.slot)], slot: Number(entry.slot) };
    }
    const state = { characterId, name: 'SpotTable', classId, level, activity: 'hunting', phase: 'cold',
        vitals: {}, stats: { classId }, inventory };
    // Cold combat reads only learned skills (113e17913): the bot has learned its whole tree
    // for the level, saved as a live bot's learned rows are.
    state.stats.coldCombat = { skillSource: 'database',
        skills: profile.skillSnapshotsFromRecords(profile.skillRecordsFromTree(classId, level)) };
    return state;
}

// The reference of a table role at a level: its numbers, seated regeneration
// per second. Game data: once per process per role and level, dropped with
// the table's rows.
const references = new Map();
const REFERENCE_NUMBERS = ['pAtk', 'atkSpd', 'accur', 'critical', 'mAtk', 'castSpd', 'pDef', 'mDef', 'evasion', 'maxHp', 'con', 'men'];
let referenceRevision = -1;
function reference(role, level) {
    if (Table.revision() !== referenceRevision) { references.clear(); referenceRevision = Table.revision(); }
    const key = `${role}:${level}`;
    let held = references.get(key);
    if (held === undefined) {
        const classId = Table.roleClass(role, level);
        held = null;
        if (classId !== null) {
            const state = referenceState(classId, level, { line: Table.lineClass(role) });
            const profile = Profile.profileFor(state, 0, { store: false });
            // Only the numbers the model reads (a whole profile is ~8 KB).
            const numbers = {};
            for (const key of REFERENCE_NUMBERS) numbers[key] = profile[key];
            held = { numbers, regen: regenOfKit(state, numbers, profile) };
        }
        references.set(key, held);
    }
    return held;
}

// The seated regeneration tick of a kit (ColdRest, its CON and MEN; profile:
// the kit's own, for its passives' armour conditions).
function regenOfKit(state, numbers, profile = undefined) {
    return ColdRest.coldRestRegenPerTick(state, { stats: { con: numbers.con, men: numbers.men }, profile });
}

// A kit's damage per second against the kills of a spot, up to the factors
// every kit of the bot shares (skill power, the mob's defence: a unit target):
// the cold fight's rates (BotTargetMatchup) with the hit chance against the
// kills' evasion and the critical rate the matchup leaves out.
const UNIT = { pDef: 1, mDef: 1 }, MOB = { pAtk: 1 };
function damageRate(numbers, magic, row) {
    if (magic) return Matchup.spellRate(numbers, UNIT, 1);
    return Matchup.attackRate(numbers, UNIT) * Formulas.hitChance(numbers.accur, row.mobEvasion)
        * (1 + Math.min(1, Math.max(0, numbers.critical) / 1000));
}
// The mob's hits per second on a kit (BotTargetMatchup.incomingRate), up to
// the mob's P.Atk, with its hit chance against the kit's evasion.
function hitsOn(numbers, row) {
    return Matchup.incomingRate(MOB, { pDef: Math.max(1, numbers.pDef) }) * Formulas.hitChance(row.mobAccur, numbers.evasion);
}
// The mob's damage per second to a kit over the reference's: its hits over
// P.Def and its spells over M.Def, in the row's measured shares (mobs cast in
// cold fights too: NpcCombatChoice). spells: all of it from spells (players
// and hot casters, reader gain). per: the row's reference numbers (build).
function damageScale(numbers, ref, row, spells, per) {
    const magic = Math.max(1, ref.mDef) / Math.max(1, numbers.mDef);
    if (spells) return magic;
    const spellShare = row.taken > 0 ? Math.min(1, Math.max(0, Number(row.spellTaken) || 0) / row.taken) : 0;
    return (1 - spellShare) * hitsOn(numbers, row) / per.refHits + spellShare * magic;
}

// A kit's numbers against the reference's on a row (the kit surface, user
// 10-29): the logs of its damage rate (offence), of the mob's hits it escapes
// (P.Def and evasion), of its M.Def and of its max HP, over the reference's.
// The spot table's kit surface fits the fight and the damage taken on them
// from real fights (scripts/generate-spot-table.js); kill reads it.
const KIT_FEATURES = ['offence', 'pDefence', 'mDefence', 'hp'];
// The closed-form slopes on those features (kill without a surface): the
// fight over the damage rate, the damage taken over the fight and the hits or
// spells met. The surface fit starts from them (scripts/generate-spot-table.js).
const KIT_PRIOR = Object.freeze({ fight: Object.freeze([-1, 0, 0, 0]), taken: Object.freeze([-1, -1, -1, 0]) });
function kitFeatures(numbers, refNumbers, row, magic) {
    const ratio = (own, reference) => Math.log(Math.max(1e-9, own) / Math.max(1e-9, reference));
    return [ratio(damageRate(numbers, magic, row), damageRate(refNumbers, magic, row)),
        ratio(hitsOn(refNumbers, row), hitsOn(numbers, row)),
        ratio(Math.max(1, numbers.mDef), Math.max(1, refNumbers.mDef)),
        ratio(Math.max(1, numbers.maxHp), Math.max(1, refNumbers.maxHp))];
}
// The features weighed by the part of a row's damage from spells (T108):
// P.Def meets the hits, M.Def the spells. The reader weighs by the row's
// spellTaken, the generator by the author's kit's measured one.
function weighFeatures(features, spellShare) {
    const spells = Math.min(1, Math.max(0, Number(spellShare) || 0));
    return [features[0], features[1] * (1 - spells), features[2] * spells, features[3]];
}
function surfaceRatio(coefficients, features) {
    let sum = 0;
    for (let at = 0; at < features.length; at++) sum += (Number(coefficients[at]) || 0) * features[at];
    return Math.exp(sum);
}

// One kill of a kit at a spot row: fight and rest seconds, damage taken (and
// its share of the reference's), deaths. potionHeal: the HP a potion heals
// when the bot drinks none (its potions' heal is rested instead), else 0.
// per: the row's numbers of the reader (the bot rests for mana; the
// reference's seated seconds, damage rate and hits taken).
// per.surface: the table's kit surface of the role and level (measured fight
// and damage taken against the kit's numbers), else the closed-form ratios.
function kill(state, numbers, regen, row, ref, magic, spells, potionHeal, per) {
    const features = per.surface ? weighFeatures(kitFeatures(numbers, ref.numbers, row, magic),
        row.taken > 0 ? row.spellTaken / row.taken : 0) : null;
    // A cell with no measured damage (no hit landed) has no taken coefficients.
    const fight = features && per.surface.fight ? row.fight * surfaceRatio(per.surface.fight, features)
        : row.fight * per.refRate / damageRate(numbers, magic, row);
    const share = row.fight > 0 ? fight / row.fight : 1;
    // spells (a casting threat's read): all the damage meets M.Def.
    const taken = features && !spells && per.surface.taken ? row.taken * surfaceRatio(per.surface.taken, features)
        : row.taken * share * damageScale(numbers, ref.numbers, row, spells, per);
    const takenShare = row.taken > 0 ? taken / row.taken : 1;
    const hpNeed = row.hpLost + taken - row.taken + potionHeal * row.potions * takenShare;
    // The reference's need beyond its rest it regenerates standing (fights,
    // walks): a kit's need above or below the reference's moves the rest by
    // the difference.
    const own = ColdRest.restSeconds(state, hpNeed, row.mpLost * share, { regen, requireMana: per.requireMana });
    const seated = Math.max(0, row.rest + own - per.refNeed);
    const load = taken / Math.max(1, numbers.maxHp), refLoad = row.taken / Math.max(1, ref.numbers.maxHp);
    const deaths = refLoad > 0 ? row.deaths * load / refLoad : row.deaths;
    return { fight, rest: seated, share, takenShare, deaths };
}

// The spots a bot's kit is weighed on: the table's 3 best incomes for its
// role and level, the spot it earns on now and the best income among the
// first 16 where the reference's fights do not reach the spot's kill cap (a
// capped spot pays nothing for a faster kit; a stronger kit earns there).
const SPOTS = 3, OPEN_CHECKS = 16;

// One review's reader (the review's owners share it: one per state and
// review inputs, the hunt object a build makes): ctx { hunt, hourAdena,
// deathHours, gearThreatMask }. income(numbers): the kit's best net
// adena per hour on the spots; gain(before, after): the hours of the bot's
// hour a change adds per hour (its income share); kept(before, after): the
// share of the income left;
// potionGain(numbers, heal): the hours per hour the healing potions add (the
// rest their heal saves; heal: the HP of one).
// numbers: a kit profile (ColdCombatProfile.candidateProfiles before or
// after). A bot with no table row reads 0 everywhere.
const readers = new WeakMap();
function reader(state, ctx = {}) {
    const held = readers.get(state);
    if (held && held.hunt === ctx.hunt && held.hourAdena === ctx.hourAdena && held.deathHours === ctx.deathHours
        && held.mask === ctx.gearThreatMask && held.level === state.level) return held.reader;
    const built = build(state, ctx);
    readers.set(state, { hunt: ctx.hunt, hourAdena: ctx.hourAdena, deathHours: ctx.deathHours, mask: ctx.gearThreatMask,
        level: state.level, reader: built });
    return built;
}
function build(state, ctx) {
    // The bot's class weighs against its own class's reference (Table.roleFor, T115).
    const role = Table.roleFor(state), level = Number(state.level) || 1;
    const ref = reference(role, level);
    const shots = ctx.hunt?.useShots !== false;
    // Shots and potions at their NPC prices, as the bot's hour (BotHuntEfficiency.huntIncome).
    const costs = Hunt.consumablePrices(state);
    const rewardOptions = { spoilSkillLevel: Rewards.spoilSkillLevel(state) };
    const ranked = Table.rankedIncome(role, level, costs, -7, shots, rewardOptions);
    const ids = new Set(ranked.slice(0, SPOTS).map(row => row.spotId));
    if (ctx.hunt?.spotId) ids.add(ctx.hunt.spotId);
    const rows = [];
    let open = false;
    const add = spotId => {
        const row = ref && Table.cycle(spotId, role, level, shots, rewardOptions);
        if (!row) return;
        rows.push(row);
        open ||= row.kph < row.cap;
    };
    for (const spotId of ids) add(spotId);
    const weighed = rows.length;
    for (let at = SPOTS; !open && at < Math.min(ranked.length, OPEN_CHECKS); at++) {
        if (!ids.has(ranked[at].spotId)) add(ranked[at].spotId);
        if (!open) rows.length = weighed;
    }
    const magic = Roles.usesCasterWeaponCombat(state);
    // The bot's mana rest and the reference's seated seconds, damage rate
    // and hits taken per row: once.
    const requireMana = ColdRest.requiresManaRecovery(state);
    const surface = Table.kitSurface(role, level);
    const rests = rows.map(row => ({ requireMana, surface, refRate: damageRate(ref.numbers, magic, row), refHits: hitsOn(ref.numbers, row),
        refNeed: ColdRest.restSeconds(state, row.hpLost, row.mpLost, { regen: ref.regen, requireMana }) }));
    if (Diagnostics.active()) Diagnostics.count('hunt_cycle', 'reader', !rows.length ? 'none' : rows.length > weighed ? 'open' : 'top');
    const hourAdena = Math.max(1, Number(ctx.hourAdena) || Hunt.huntHour(ctx.hunt, state));
    const deathAdena = Math.max(0, Number(ctx.deathHours) || 0) * hourAdena;
    const mayCast = ctx.gearThreatMask !== 1;
    // The review's kits differ in CON and MEN by a few points: one regeneration each.
    const regens = new Map();
    const regenOf = numbers => {
        const key = numbers.con * 1024 + numbers.men;
        let regen = regens.get(key);
        if (!regen) regens.set(key, regen = regenOfKit(state, numbers));
        return regen;
    };
    // One spot's hour of the kit: kills and net adena. spells: the mob damage
    // meets M.Def (damageScale); potionHeal: as kill's, none bought then;
    // potionCost: false for the potions' own worth (their price is the buy's).
    const hour = (numbers, regen, index, spells = false, potionHeal = 0, potionCost = true) => {
        const row = rows[index];
        const one = kill(state, numbers, regen, row, ref, magic, spells, potionHeal, rests[index]);
        const idle = Math.max(0, 3600 / row.kph - row.fight - row.rest);
        const own = 3600 / Math.max(1, one.fight + one.rest + idle);
        const kills = Math.min(own, row.cap) * row.pull;
        const potions = potionHeal > 0 || !potionCost ? 0 : row.potions * one.takenShare * costs.potions;
        one.own = own; one.kills = kills;
        one.income = kills * (row.money - row.shots * one.share * costs.shots - potions - one.deaths * deathAdena);
        return one;
    };
    const income = (numbers, spells = false, potionHeal = 0, potionCost = true) => {
        if (!rows.length) return 0;
        const regen = regenOf(numbers);
        let best = -Infinity;
        for (let at = 0; at < rows.length; at++) best = Math.max(best, hour(numbers, regen, at, spells, potionHeal, potionCost).income);
        return best;
    };
    // The kit a review compares every candidate with: its incomes once.
    let heldNumbers = null, held = null;
    const current = numbers => {
        if (numbers !== heldNumbers) { heldNumbers = numbers; held = [income(numbers), mayCast ? income(numbers, true) : 0]; }
        return held;
    };
    // A change's hours per hour: its income over the model's own hour of the
    // kit (the bot's hour where the kit earns nothing).
    const share = (was, now) => (now - was) / (was > 0 ? was : hourAdena);
    return {
        income,
        // The spots weighed and one's hour (scripts/hunt-cycle-check.js).
        spotIds: rows.map(row => row.spotId),
        hourAt: (numbers, index) => hour(numbers, regenOf(numbers), index),
        // Where the threat may cast (GearThreat mask 3), the better of the
        // change against hits or against spells, as each piece defends one.
        gain: (before, after) => {
            if (!rows.length) return 0;
            const [hits, spells] = current(before);
            const physical = share(hits, income(after));
            return mayCast ? Math.max(physical, share(spells, income(after, true))) : physical;
        },
        potionGain: (numbers, heal) => rows.length && heal > 0
            ? Math.max(0, share(income(numbers, false, heal), income(numbers, false, 0, false))) : 0,
        kept: (before, after) => {
            const was = current(before)[0];
            return was > 0 ? Math.min(1, Math.max(0, income(after)) / was) : 1;
        }
    };
}

module.exports = { reader, referenceState, referenceId, kitFeatures, weighFeatures, KIT_FEATURES, KIT_PRIOR };
