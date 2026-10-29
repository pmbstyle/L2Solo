const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const HealingPotionStock = invoke('GameServer/Bot/AI/HealingPotionStock');
const DangerMoment = invoke('GameServer/Bot/AI/DangerMoment');

DataCache.init();

// E70: the danger moment compares drinking, fleeing, sitting and fighting on
// in the bot's hours (§13.6).
const base = { hp: 30, maxHp: 100, survivalRatio: 0.9, attacked: true, potion: { heal: 112, price: 50 },
    restHours: 0.02, deathHours: 0.5, moneyPrice: 1 / 10000, riskWeight: 1.5, roll: 0.5 };

assert.strictEqual(DangerMoment.decide(base).action, 'drink',
    'a wounded melee bot losing the race drinks a cheap potion instead of running');
assert.strictEqual(DangerMoment.decide({ ...base, hp: 100, survivalRatio: 3 }).action, 'fight',
    'a healthy bot winning the race keeps fighting');
// Live values: the admitted margin 1.5 at full HP, 8 s of rest, 30 s left to kill.
const live = { ...base, hp: 100, survivalRatio: 1.5, restHours: 8 / 3600, fightHours: 30 / 3600 };
assert.strictEqual(DangerMoment.decide(live).action, 'fight', 'a healthy bot does not run from an admitted mob');
assert.strictEqual(DangerMoment.decide({ ...live, hp: 95, survivalRatio: 1.425 }).action, 'fight',
    'one hit taken is no reason to drink');
assert.strictEqual(DangerMoment.decide({ ...base, potion: null }).action, 'flee',
    'without a potion a bot losing the race runs');
assert.strictEqual(DangerMoment.decide({ ...base, potion: null, canEscape: false }).action, 'fight',
    'an impossible escape cannot receive a risk discount over defending');
assert.strictEqual(DangerMoment.decide({ ...base, canEscape: false }).action, 'drink',
    'a bot that cannot escape can still drink a potion');
assert.strictEqual(DangerMoment.decide({ ...base, attacked: false, potion: null }).action, 'sit',
    'with nobody hitting it a wounded bot sits instead of running');
assert.notStrictEqual(DangerMoment.decide({ ...base, attacked: false }).action, 'flee',
    'nothing to run from when nobody attacks');
assert.strictEqual(DangerMoment.decide({ ...base, moneyPrice: 1 / 10 }).action, 'flee',
    'a potion priced above the risk it removes is not drunk');
assert.strictEqual(DangerMoment.decide({ ...base, survivalRatio: null }), null,
    'an unknown matchup leaves the author rule in place');
// Caution and resilience (riskWeight) move the same moment: a cautious bot
// drinks where a resilient one still fights.
const edge = { ...base, hp: 60, survivalRatio: 1.2, potion: { heal: 112, price: 300 } };
assert.strictEqual(DangerMoment.decide({ ...edge, riskWeight: 4 }).action, 'drink');
assert.strictEqual(DangerMoment.decide({ ...edge, riskWeight: 0.67 }).action, 'fight');

// Hot side: the moment reads the held economy and the live fight.
function item(selfId, amount, objectId = selfId + 100000) {
    return { fetchSelfId: () => selfId, fetchAmount: () => amount, fetchId: () => objectId };
}
let hp = 30;
const used = [];
const actor = {
    effects: {}, fetchId: () => 42, fetchClassId: () => 0, fetchLevel: () => 10,
    fetchHp: () => hp, fetchMaxHp: () => 100, fetchMp: () => 50, fetchMaxMp: () => 50,
    fetchPAtk: () => 100, fetchPDef: () => 100, fetchAtkSpd: () => 300, fetchMAtk: () => 10, fetchCastSpd: () => 333,
    state: { fetchDead: () => false, fetchCasts: () => false },
    canUseSkill: () => true,
    backpack: {
        fetchItems: () => [item(1060, 3)],
        buildItemSkill: () => ({ fetchSelfId: () => 2031 }),
        useItem: (_session, objectId) => used.push(objectId)
    }
};
const mob = { fetchId: () => 7001, fetchHp: () => 80, fetchMaxHp: () => 100, isDead: () => false,
    matchupTarget: { maxHp: 100, pAtk: 100, pDef: 100, atkSpd: 300, vulnerabilities: {} } };
// A received near decision (DecisionEvents.receive) carries decided: true.
const session = { coldLifeState: { stats: { decisionSeq: 3 } },
    heldEconomy: { decided: true, deathHours: 0.5, riskWeight: 1.5, moneyPrice: 1 / 10000, network: { activity: null } } };

assert.strictEqual(DangerMoment.forActor(session, actor, mob, { attackers: [mob] }).action, 'drink',
    'the hot moment at 30% HP against a fresh mob drinks');
assert(HealingPotionStock.tryUseInCombat(session, actor, mob, { dangerMoment: true }), 'the moment drinks');
hp = 50;
assert(HealingPotionStock.tryUseInCombat(session, actor, mob, { dangerMoment: true }),
    'the author cap of one potion per target gives way to the moment (E70)');
assert.strictEqual(used.length, 2);
hp = 30;
assert.strictEqual(HealingPotionStock.tryUseInCombat(session, actor, mob), null,
    'the fixed-ratio potion step yields to the moment the bot took for this target');
assert.strictEqual(DangerMoment.forActor({}, actor, mob, { attackers: [mob] }), null,
    'no held economy: the author rule decides');

// The price of money unknown (no moneyPrice, no money[1] in the stats packet):
// a potion priced at zero would be drunk whenever the last one wears off, so
// the author's 0.35 rule decides.
assert.strictEqual(DangerMoment.decide({ ...base, moneyPrice: null }), null);
assert.strictEqual(DangerMoment.decide({ ...base, moneyPrice: undefined }), null);
const noPrice = { coldLifeState: { stats: { decisionSeq: 3 } },
    heldEconomy: { decided: true, deathHours: 0.5, riskWeight: 1.5, statsPacket: { money: [12000] }, network: { activity: null } } };
assert.strictEqual(DangerMoment.forActor(noPrice, actor, mob, { attackers: [mob] }), null,
    'an unknown price of money leaves the author rule');
noPrice.heldEconomy.statsPacket.money = [12000, 1 / 10000];
assert.strictEqual(DangerMoment.forActor(noPrice, actor, mob, { attackers: [mob] }).action, 'drink',
    'the price of money read from the stats packet (money[1]) as EconomyContext holds it');

// Top0r: effective speed 124 against mobs running at 176/191. A slower
// primary target must not hide the faster add; buffs/slows change the race.
actor.fetchCollectiveRunSpd = () => 124;
actor.fetchRunSpd = () => 300;
mob.fetchCollectiveRunSpd = () => 176;
mob.fetchRunSpd = () => 100;
assert.strictEqual(DangerMoment.forActor(session, actor, mob, { attackers: [mob], potion: null }).action, 'fight',
    'effective speeds rule out running from a faster mob');
mob.fetchCollectiveRunSpd = () => 124;
assert.strictEqual(DangerMoment.forActor(session, actor, mob, { attackers: [mob], potion: null }).action, 'fight',
    'equal speeds cannot open a gap either');
mob.fetchCollectiveRunSpd = () => 80;
assert.strictEqual(DangerMoment.forActor(session, actor, mob, { attackers: [mob], potion: null }).action, 'flee',
    'a slowed pursuer makes escape an option again');
const fastAdd = { ...mob, fetchId: () => 7004, fetchCollectiveRunSpd: () => 191 };
assert.strictEqual(DangerMoment.forActor(session, actor, mob, { attackers: [mob, fastAdd], potion: null }).action, 'fight',
    'escape must beat every attacker, including faster adds');
delete actor.fetchCollectiveRunSpd;
delete actor.fetchRunSpd;
delete mob.fetchCollectiveRunSpd;
delete mob.fetchRunSpd;

// Cost: a full-HP tick does no world scan, no profiles and no bag read;
// a wounded one reads its attackers from the caller's scan.
const World = invoke('GameServer/World/World');
const TargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const oldScan = World.fetchNpcsInRadius, oldProfiles = TargetMatchup.actorProfiles, oldSurvival = TargetMatchup.soloSurvival;
const oldItems = actor.backpack.fetchItems;
try {
    let scans = 0, profileBuilds = 0, bagReads = 0;
    World.fetchNpcsInRadius = () => { scans++; return []; };
    TargetMatchup.actorProfiles = (...args) => { profileBuilds++; return oldProfiles(...args); };
    actor.backpack.fetchItems = () => { bagReads++; return oldItems(); };
    hp = 100;
    assert.strictEqual(DangerMoment.take(session, actor, mob), null, 'at full HP the author rule decides');
    assert.deepStrictEqual([scans, profileBuilds, bagReads], [0, 0, 0], 'a full-HP tick scans nothing');
    assert.strictEqual(session.dangerMoment, undefined);

    // Two mobs on the bot: one view with their HP summed and pull 2, so an
    // area skill is credited against each (F20).
    hp = 60;
    actor.effects = {};
    const second = { fetchId: () => 7002, fetchHp: () => 80, fetchLocX: () => 100, fetchLocY: () => 0,
        fetchAttackable: () => true, isDead: () => false, fetchDestId: () => 42,
        matchupTarget: { maxHp: 100, pAtk: 100, pDef: 100, atkSpd: 300, vulnerabilities: {} } };
    const far = { ...second, fetchId: () => 7003, fetchLocX: () => 2000 };
    actor.fetchLocX = () => 0; actor.fetchLocY = () => 0;
    mob.fetchLocX = () => 50; mob.fetchLocY = () => 0;
    let seen = null;
    TargetMatchup.soloSurvival = (profiles, enemy) => { seen = enemy; return oldSurvival(profiles, enemy); };
    DangerMoment.take(session, actor, mob, { near: [mob, second, far] });
    assert.strictEqual(scans, 0, 'the attackers come from the caller scan');
    assert.strictEqual(seen.pull, 2, 'the combined view carries the pull');
    assert.strictEqual(seen.maxHp, 160, 'the mob 2000 away is not in this fight');
    assert.strictEqual(profileBuilds, 1, 'profiles built once per take');
    assert(bagReads <= 1, 'the bag is read at most once per take');
} finally {
    World.fetchNpcsInRadius = oldScan; TargetMatchup.actorProfiles = oldProfiles; TargetMatchup.soloSurvival = oldSurvival;
    actor.backpack.fetchItems = oldItems;
}

console.log('Bot danger moment tests passed');
