const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const SummonControl = invoke('GameServer/Npc/SummonControl');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
DataCache.init();

// A hot bot going cold keeps its servitor and charges: the cold fight then
// neither recasts the servitor nor starts its charges from zero.
const timestamp = 1_750_000_000_000;
const kai = {
    fetchSummonSkillId: () => 1276,
    fetchHp: () => 42,
    isDead: () => false,
    summonTimeRemaining: 600000,
    summonTimeLostIdle: 1000
};
const hotSummoner = {
    summon: kai,
    fetchCharges: () => 2,
    chargeExpiresAt: timestamp + 300000,
    fetchClassId: () => 14,
    skillset: { fetchSkills: () => [] }
};
const snapshot = ColdCombatProfile.capture(hotSummoner, timestamp);
assert.deepStrictEqual(snapshot.summon, { active: true, skillId: 1276, hp: 42, expiresAt: timestamp + 600000 });
assert.strictEqual(snapshot.charges, 2);
assert.strictEqual(snapshot.chargeExpiresAt, timestamp + 300000);
assert.strictEqual(ColdCombatProfile.capture({ ...hotSummoner, summon: null, fetchCharges: () => 0, chargeExpiresAt: undefined }, timestamp).summon, null);

const coldSummoner = {
    characterId: 905,
    name: 'ColdSummoner',
    level: 40,
    activity: 'hunting',
    vitals: { hp: 3000, maxHp: 3000, mp: 2500, maxMp: 2500 },
    inventory: {},
    stats: { classId: 14, role: 'mage', coldCombat: snapshot },
    party: { role: 'mage' }
};
const spot = { id: 'summon-carry', name: 'Summon carry', avgLevel: 40, density: 1, npcSelfIds: [], rewards: { exp: 10, sp: 2, adenaMin: 1, adenaMax: 1 }, mob: { hp: 100000, damage: 1 } };
const result = BackgroundResolver.resolveSolo({ state: coldSummoner, spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert.strictEqual(result.debug.summonUses || 0, 0, 'the servitor kept from the hot session is not recast');
assert.strictEqual(result.patch.stats.coldCombat.summon.skillId, 1276);
const fresh = BackgroundResolver.resolveSolo({ state: { ...coldSummoner, stats: { ...coldSummoner.stats, coldCombat: { ...snapshot, summon: null } } },
    spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert(fresh.debug.summonUses > 0, 'without a kept servitor the cold summoner casts one');

// Coming back near the player: charges return with their deadline, the
// servitor returns once with its HP and remaining life.
const hotAgain = { charges: 0, fetchCharges() { return this.charges; }, setCharges(value) { this.charges = value; } };
assert.strictEqual(ChargeLifecycle.restore(null, hotAgain, 2, Date.now() + 60000), 2);
assert(hotAgain.chargeExpiresAt > Date.now());
ChargeLifecycle.dispose(hotAgain);
assert.strictEqual(ChargeLifecycle.restore(null, { charges: 0, fetchCharges() { return this.charges; }, setCharges(v) { this.charges = v; } }, 2, Date.now() - 1), 0,
    'expired charges are not restored');

const placed = [];
const place = C4SkillEffects.placeSummon;
C4SkillEffects.placeSummon = (session, actor, skill, npcData, coords, options) => {
    placed.push({ skillId: skill.fetchSelfId(), options });
    actor.summon = { isDead: () => false };
    return actor.summon;
};
try {
    const skill = { fetchSelfId: () => 1276, fetchSummonTimeLostIdle: () => 1000, fetchSummonNpcId: () => 12477 };
    const owner = { skillset: { fetchSkill: (id) => id === 1276 ? skill : null }, fetchHead: () => 0, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0 };
    const now = Date.now();
    const saved = { active: true, skillId: 1276, hp: 42, expiresAt: now + 300000 };
    assert(SummonControl.restoreFromCold({}, owner, saved, now));
    assert.deepStrictEqual(placed[0], { skillId: 1276, options: { hp: 42, remainingLife: 300000 } });
    assert.strictEqual(SummonControl.restoreFromCold({}, owner, saved, now), null, 'an owner with a live servitor gets no second one');
    assert.strictEqual(SummonControl.restoreFromCold({}, { ...owner, summon: null }, { ...saved, expiresAt: now - 1 }, now), null, 'an expired servitor stays gone');
} finally {
    C4SkillEffects.placeSummon = place;
}
// The servitor comes from the cold state the bot was loaded with: a party or
// PvP handoff re-captures the staged actor (no servitor yet) into
// session.coldLifeState before the AI starts, so that copy is not used.
const BotAI = invoke('GameServer/Bot/BotAI');
const restoreFromCold = SummonControl.restoreFromCold;
const restored = [];
SummonControl.restoreFromCold = (session, actor, saved) => { restored.push(saved); return null; };
try {
    const kept = { active: true, skillId: 1128, hp: 300, expiresAt: Date.now() + 600000 };
    const session = { actor: { fetchClanId: () => 0 }, coldSummon: kept,
        coldLifeState: { stats: { coldCombat: { summon: null } } } };
    BotAI.init(session);
    BotAI.init(session);
    BotAI.cancelScheduledTick(session);
    assert.deepStrictEqual(restored, [kept], 'restored once, from the state the bot was loaded with');
} finally {
    SummonControl.restoreFromCold = restoreFromCold;
}
console.log('test_cold_summon_carry: ok');
