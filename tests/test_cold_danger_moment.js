const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Cold = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
const Encounter = require('../src/GameServer/Bot/Population/ColdPveEncounter');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const DangerMoment = invoke('GameServer/Bot/AI/DangerMoment');
const DangerRule = invoke('GameServer/Bot/AI/DangerRule');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');

// A slice's end is the cold fight's look at its danger: the hot rule, at the
// bot's HP against the mob's HP left. A slice in which nobody acts ends at
// exactly the state the fixture sets.
const T = 1750000000000, SLICE_MS = 1000, IDLE = { botReadyAt: 5000, mobReadyAt: 5000 };
const POTION = HealingPotionStock.POTIONS.find(potion => potion.hot);
const base = { characterId: 901, name: 'Danger', level: 12, phase: 'cold', activity: 'hunting',
    loc: { locX: 0, locY: 0, locZ: 0 }, inventory: {},
    vitals: { hp: 100, maxHp: 500, mp: 200, maxMp: 200 },
    stats: { classId: 0, money: [10000, 1 / 10000, 0, 0], dangerPrice: [0.5, 1.5], coldCombat: { version: 1, classId: 0,
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
        equipment: { weaponKind: 'Weapon.Sword', pAtk: 80, pAtkRnd: 0, mAtk: 40,
            atkSpd: 379, critical: 0, accur: 100, pDef: 120, mDef: 50, evasion: 0, bonusMp: 0, shieldPDef: 0 },
        skills: [], effects: [] } } };
const spot = { id: 'danger', name: 'Danger', minLevel: 12, maxLevel: 12, avgLevel: 12, density: 30,
    rewards: { exp: 1000, sp: 10, adenaMin: 1, adenaMax: 1 } };
const mob = { selfId: 20001, level: 12, maxHp: 300, pAtk: 60, pAtkRnd: 0, pDef: 200, mDef: 100, accur: 1000, evasion: 0,
    critical: 0, atkSpd: 253, mAtk: 1, castSpd: 333, atkRadius: 40, runSpd: 60, aiType: 'fighter' };
const profile = Cold.profileFor(base, T);
base.vitals = { ...base.vitals, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
const fast = { ...mob, runSpd: profile.runSpd + 40 };

function state({ hp = base.vitals.hp, mobHp = mob.maxHp, foe = mob, bottles = 0, stats = {}, timers = IDLE } = {}) {
    const fighter = { ...structuredClone(base), vitals: { ...base.vitals, hp } };
    if (bottles) fighter.inventory = { [POTION.selfId]: { selfId: POTION.selfId, amount: bottles } };
    fighter.stats = { ...fighter.stats, ...stats };
    fighter.stats.pveEncounter = Encounter.save(null, Encounter.key([fighter], spot), foe, mobHp, T, timers);
    return fighter;
}
const slice = (fighter, seed = 0.5) => Solo.resolveSolo({ state: fighter, spot, elapsedMs: SLICE_MS, timestamp: T + 30000, rng: () => seed });
function coldAction(fighter) {
    const { debug, patch } = slice(fighter);
    if (debug.potionsUsed > 0) return 'drink';
    if (patch.activity === 'resting') return 'flee';
    assert.strictEqual(debug.pendingFight, true, 'the fight goes on');
    return 'fight';
}

// The hot bot at the same state (DangerMoment over a live actor).
function hotAction({ hp = base.vitals.hp, mobHp = mob.maxHp, foe = mob, bottles = 0 } = {}) {
    const actor = { effects: {}, fetchId: () => base.characterId, fetchClassId: () => 0, fetchLevel: () => base.level,
        fetchHp: () => hp, fetchMaxHp: () => base.vitals.maxHp, fetchMp: () => base.vitals.mp, fetchMaxMp: () => base.vitals.maxMp,
        fetchCollectiveRunSpd: () => profile.runSpd, state: { fetchDead: () => false, fetchCasts: () => false, fetchWalkin: () => false },
        canUseSkill: () => true, backpack: { fetchItems: () => bottles ? [{ fetchSelfId: () => POTION.selfId, fetchAmount: () => bottles, fetchId: () => 1 }] : [] } };
    const target = { fetchId: () => foe.selfId, fetchHp: () => mobHp, matchupTarget: { ...foe }, fetchCollectiveRunSpd: () => foe.runSpd,
        state: { fetchDead: () => false } };
    const session = { heldEconomy: { decided: true, deathHours: base.stats.dangerPrice[0], riskWeight: base.stats.dangerPrice[1],
        moneyPrice: base.stats.money[1] } };
    return DangerMoment.forActor(session, actor, target, { attackers: [target],
        profiles: TargetMatchup.coldProfiles(profile, base, T, { shot: null }) })?.action;
}

// Hot and cold take the one decision at the same state.
for (const [name, want, input] of [
    ['a healthy bot fights on', 'fight', { hp: 330 }],
    ['a bot winning the race fights on', 'fight', { mobHp: 50 }],
    ['a wounded bot with a bottle drinks', 'drink', { bottles: 5 }],
    ['a wounded bot without one runs', 'flee', {}],
    ['a bot it cannot outrun gets no flight', 'fight', { foe: fast }],
    ['a bottle still works against a faster mob', 'drink', { foe: fast, bottles: 5 }]
]) {
    assert.strictEqual(hotAction(input), want, `hot: ${name}`);
    assert.strictEqual(coldAction(state(input)), want, `cold: ${name}`);
}

// A flight ends the fight into rest, with no kill; a bottle leaves it running.
{
    const fled = slice(state());
    assert.strictEqual(fled.patch.stats.pveEncounter, null, 'the mob is left behind');
    assert.strictEqual(fled.debug.wins, 0);
    assert.strictEqual(fled.materialize.exp, 0, 'a flight pays no kill');
    assert.strictEqual(fled.debug.fights, 1, 'it ends the fight');
    const drank = slice(state({ bottles: 5 }));
    assert(drank.patch.stats.pveEncounter?.hp > 0);
    assert(drank.patch.vitals.hp > 100, 'the bottle heals');
    assert.strictEqual(drank.patch.inventory[POTION.selfId].amount, 4, 'the bottle is spent');
}

// A flight is not free: the run lasts until the chase breaks, and that time is
// no rest; the mob strikes while the bot is in its reach.
{
    const atFight = T + 30000;
    const quiet = { botReadyAt: 1050, mobReadyAt: 1e6 };
    const longRun = slice(state({ foe: { ...mob, runSpd: profile.runSpd - 10 }, timers: quiet }));
    const shortRun = slice(state({ foe: { ...mob, runSpd: 1 }, timers: quiet }));
    assert(longRun.patch.stats.restUntil - shortRun.patch.stats.restUntil
        >= DangerRule.chaseMs(profile.runSpd, profile.runSpd - 10) - DangerRule.chaseMs(profile.runSpd, 1) - 1000,
    'a chaser nearly as fast costs the longer run');
    assert(shortRun.patch.stats.restUntil - atFight >= DangerRule.chaseMs(profile.runSpd, 1), 'the run adds to the rest');
    assert.strictEqual(DangerRule.chaseMs(100, 95), null, 'a gap that opens this slowly is no escape');
    const swing = { botReadyAt: 1050, mobReadyAt: 1100 };
    const melee = slice(state({ timers: swing }));
    assert(melee.debug.damageTaken > 0, 'the swing under way lands as the bot turns');
    assert.strictEqual(slice(state({ timers: { botReadyAt: 1050, mobReadyAt: 3000 } })).debug.damageTaken, 0,
        'a melee mob gets no blow on a bot it cannot catch');
    assert(slice(state({ foe: { ...mob, runSpd: profile.runSpd - 10 }, timers: { botReadyAt: 1050, mobReadyAt: 3000 } })).debug.damageTaken > 0,
        'a chaser nearly as fast keeps the bot in its reach');
    const archer = { ...mob, atkRadius: 900 };
    const shot = slice(state({ foe: archer, timers: swing }));
    assert(shot.debug.damageTaken > melee.debug.damageTaken, 'a ranged mob strikes longer than a melee one');
    assert.strictEqual(slice(state({ hp: 10, foe: archer, timers: swing })).debug.died, true, 'a flight can end in death');
}

// With no decision yet (the table's reference bot, a hot body's first ticks) the retreat rule holds.
{
    const noPrice = { dangerPrice: undefined };
    assert.strictEqual(coldAction(state({ hp: 100, mobHp: 2000, stats: noPrice })), 'flee', 'below the retreat line it runs');
    assert.strictEqual(coldAction(state({ hp: 300, mobHp: 2000, stats: noPrice })), 'fight', 'above it fights on');
    assert.strictEqual(coldAction(state({ hp: 100, mobHp: 2000, foe: fast, stats: noPrice })), 'fight', 'from a faster mob nobody runs');
    assert.strictEqual(coldAction(state({ hp: 100, mobHp: 1, stats: noPrice })), 'fight', 'one strike from the kill it stays');
}

// A mob on its pet does not chase: the owner runs a leg, the pet takes the blows.
{
    const WARLOCK = 14, LEVEL = 45;
    const summoner = { characterId: 902, name: 'Owner', level: LEVEL, classId: WARLOCK, phase: 'cold', activity: 'hunting',
        loc: { locX: 0, locY: 0, locZ: 0 }, inventory: {}, vitals: {}, stats: { classId: WARLOCK, role: 'mage' } };
    summoner.stats.coldCombat = Cold.legacySnapshot(summoner, Cold.skillRecordsFromTree(WARLOCK, LEVEL), T);
    const owner = Cold.profileFor(summoner, T);
    summoner.vitals = { hp: Math.floor(owner.maxHp * 0.2), maxHp: owner.maxHp, mp: owner.maxMp, maxMp: owner.maxMp };
    summoner.stats.coldCombat.summon = { active: true, skillId: Number(Cold.summonSkills(owner)[0].selfId), hp: 5000, maxHp: 5000, expiresAt: T + 1e7 };
    summoner.stats.pveEncounter = Encounter.save(null, Encounter.key([summoner], spot), mob, mob.maxHp, T,
        { botReadyAt: 0, mobReadyAt: 1100, ownerHate: 0, petHate: 1e6 });
    const hotState = (pet, hp, ownerHate = 0) => {
        const fighter = structuredClone(summoner);
        fighter.stats.coldCombat.summon.hp = fighter.stats.coldCombat.summon.maxHp = pet;
        fighter.stats.pveEncounter = Encounter.save(null, Encounter.key([fighter], spot), { ...mob, maxHp: hp }, hp, T,
            { botReadyAt: 0, mobReadyAt: 1100, ownerHate, petHate: 1e6 });
        return fighter;
    };
    // Hot, the pet stays until it or the mob is dead, and its kill pays as hot.
    const wins = slice(hotState(5000, 300));
    assert.strictEqual(wins.patch.activity, 'resting', 'the owner leaves');
    assert.strictEqual(wins.debug.damageTaken, 0, 'the mob does not turn on it');
    assert.strictEqual(wins.debug.wins, 1, 'the pet finishes the mob');
    assert(wins.materialize.exp > 0, 'the kill pays');
    assert(wins.patch.stats.coldCombat.summon.hp <= 5000, 'the pet keeps what it lost');
    const loses = slice(hotState(100, 1e7));
    assert.strictEqual(loses.patch.stats.coldCombat.summon, null, 'a pet that cannot win is lost');
    assert.strictEqual(loses.debug.summonDeaths, 1);
    assert.strictEqual(loses.debug.wins, 0);
    assert(loses.debug.petTaken > 0);
    assert.strictEqual(loses.materialize.exp, 0);
    const hunted = slice(hotState(100, 1e7, 500));
    assert(hunted.patch.stats.restUntil > loses.patch.stats.restUntil, 'a mob with the owner\'s hate comes for it next');
}

console.log('Cold danger moment: the hot rule at a slice\'s end, a flight paid in time and blows passed');
