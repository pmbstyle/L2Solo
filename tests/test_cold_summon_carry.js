const assert = require('assert');
const fs = require('node:fs');
const path = require('node:path');
const isolated = require('./helpers/isolatedSocialDatabase')('cold_summon_carry', path.resolve(__dirname, '..'));
require('./helpers/databaseIsolation');
require('../src/Global');
isolated.assertConfigured(options.default);
const DataCache = invoke('GameServer/DataCache');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const BackgroundResolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const ChargeLifecycle = invoke('GameServer/Skills/ChargeLifecycle');
const SummonControl = invoke('GameServer/Npc/SummonControl');
const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
DataCache.init();

let nativeDatabase;
async function run() {
try {
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
// Preserve the original hot-owned empty list as a refusal, rather than
// backfilling an unowned summon from the class tree.
const emptyOwnedFresh = BackgroundResolver.resolveSolo({ state: { ...coldSummoner,
    stats: { ...coldSummoner.stats, coldCombat: { ...snapshot, summon: null } } },
    spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert.strictEqual(emptyOwnedFresh.debug.summonUses || 0, 0, 'an authoritative empty-owned capture cannot recast');
assert.strictEqual(emptyOwnedFresh.patch.stats.coldCombat.summon, null, 'an empty-owned profile receives no servitor');
assert.deepStrictEqual(coldSummoner.inventory, {}, 'refusal does not mint a crystal');

// Historical already-owned unit input, NOT a paid skill/book/SQL grant.
// Capture the actual native1276/1 model and its authored item1459x1 cost.
const Skill = invoke('GameServer/Model/Skill');
const definition = DataCache.skills.find(row => Number(row.selfId) === 1276);
const rank = definition.levels.find(row => Number(row.level) === 1);
const ownedSkill = new Skill({ selfId: definition.selfId, ...definition.template, ...definition.time, ...rank });
const ownedSnapshot = ColdCombatProfile.capture({ ...hotSummoner, summon: null,
    skillset: { fetchSkills: () => [ownedSkill] } }, timestamp);
assert.deepStrictEqual(ownedSnapshot.skills.map(row => [row.selfId, row.level, row.itemId, row.itemCount]),
    [[1276, 1, 1459, 1]], 'the already-owned capture retains native authored cast costs');
const crystal = DataCache.items.find(row => Number(row.selfId) === 1459);
const alreadyOwned = { ...coldSummoner,
    inventory: { 1459: { selfId: 1459, name: crystal.template.name, amount: 1 } },
    stats: { ...coldSummoner.stats, coldCombat: ownedSnapshot } };
const noCrystalState = { ...alreadyOwned, inventory: {} };
const noCrystal = BackgroundResolver.resolveSolo({ state: noCrystalState,
    spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert.strictEqual(noCrystal.debug.summonUses || 0, 0, 'an owned summon cannot cast without its authored crystal');
assert.strictEqual(noCrystal.patch.stats.coldCombat.summon, null, 'missing crystal creates no summon');
assert.deepStrictEqual(noCrystalState.inventory, {}, 'missing-crystal refusal preserves the input inventory');
const fresh = BackgroundResolver.resolveSolo({ state: alreadyOwned,
    spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert(fresh.debug.summonUses > 0, 'without a kept servitor the cold summoner casts one');
assert.strictEqual(fresh.debug.summonUses, 1, 'one authored crystal admits exactly one cast');
assert.strictEqual(fresh.patch.inventory[1459].amount, 0, 'the result debits the upfront crystal exactly once');
assert.strictEqual(alreadyOwned.inventory[1459].amount, 1, 'the unit simulation does not mutate its input crystal stack');
const twoCrystals = { ...alreadyOwned, inventory: { 1459: { ...alreadyOwned.inventory[1459], amount: 2 } } };
const spentOne = BackgroundResolver.resolveSolo({ state: twoCrystals,
    spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert.strictEqual(spentOne.patch.inventory[1459].amount, 1, 'the authored cast does not consume a second crystal');
assert.strictEqual(twoCrystals.inventory[1459].amount, 2, 'quantity controls preserve the caller input');
const carriedOwned = { ...alreadyOwned, ...fresh.patch, stats: fresh.patch.stats, inventory: fresh.patch.inventory };
const keptAgain = BackgroundResolver.resolveSolo({ state: carriedOwned,
    spot, elapsedMs: 12000, timestamp: timestamp + 1000, rng: () => 0.1 });
assert.strictEqual(keptAgain.debug.summonUses || 0, 0, 'a carried servitor never charges its upfront crystal twice');
assert.strictEqual(keptAgain.patch.inventory[1459].amount, 0, 'carry does not mint or re-debit crystals');
const raidPreparation = BackgroundResolver.prepareRaidParty([alreadyOwned], timestamp);
assert.strictEqual(raidPreparation.summonCasts, 1, 'raid preparation casts the same already-owned native skill');
assert.strictEqual(raidPreparation.memberResults[0].result.patch.inventory[1459].amount, 0,
    'preparation propagates the existing inventory field before the lifecycle write');
assert.strictEqual(alreadyOwned.inventory[1459].amount, 1, 'preparation uses the private combat inventory copy');
const beforePreparationMp = Math.min(alreadyOwned.vitals.mp,
    ColdCombatProfile.profileFor(alreadyOwned, timestamp).maxMp);
assert.strictEqual(ownedSnapshot.skills[0].mp, 70, 'native1276/1 costs its authored MP');
assert.strictEqual(raidPreparation.memberResults[0].result.patch.vitals.mp, beforePreparationMp - 70,
    'a material-admitted preparation debits exactly the authored MP');
assert.strictEqual(raidPreparation.memberResults[0].result.patch.stats.coldCombat.cooldowns[1276],
    timestamp + ownedSnapshot.skills[0].reuse, 'a paid cast installs the authored cooldown');
const refusedPreparation = BackgroundResolver.prepareRaidParty([noCrystalState], timestamp);
assert.strictEqual(refusedPreparation.summonCasts, 0);
assert.strictEqual(refusedPreparation.memberResults[0].result.patch.vitals.mp, beforePreparationMp,
    'missing crystal refuses before MP debit');
assert.strictEqual(refusedPreparation.memberResults[0].result.patch.stats.coldCombat.cooldowns[1276], undefined,
    'missing crystal creates no cooldown');
const coolingState = { ...alreadyOwned, stats: { ...alreadyOwned.stats,
    coldCombat: { ...ownedSnapshot, cooldowns: { 1276: timestamp + ownedSnapshot.skills[0].reuse } } } };
const coolingPreparation = BackgroundResolver.prepareRaidParty([coolingState], timestamp);
assert.strictEqual(coolingPreparation.summonCasts, 0, 'a retained cooldown cannot spend another crystal');
assert.strictEqual(coolingPreparation.memberResults[0].state.inventory[1459].amount, 1);
assert.strictEqual(coolingPreparation.memberResults[0].result.patch.vitals.mp, beforePreparationMp);
const lowMpState = { ...alreadyOwned, vitals: { ...alreadyOwned.vitals, mp: ownedSnapshot.skills[0].mp - 1 } };
const lowMpPreparation = BackgroundResolver.prepareRaidParty([lowMpState], timestamp);
assert.strictEqual(lowMpPreparation.summonCasts, 0, 'below the authored MP cost no crystal is spent');
assert.strictEqual(lowMpPreparation.memberResults[0].state.inventory[1459].amount, 1);
assert.strictEqual(lowMpPreparation.memberResults[0].result.patch.vitals.mp, ownedSnapshot.skills[0].mp - 1);


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

// The resolver's copied debit must survive the native lifecycle projection;
// these remain historical already-owned inputs, not a paid-training claim.
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const projectionInput = { ...alreadyOwned, phase: 'cold', exp: Number(DataCache.experience[39]) + 1, sp: 0,
    stats: { ...alreadyOwned.stats, classProgressionLevel: 40, classProgressionClassId: 14 } };
const projected = await Life.prepareResolve(projectionInput, fresh,
    { persist: false, projectClassProgression: true, timestamp });
assert.strictEqual(Number(projected.inventory[1459]?.amount || 0), 0,
    'the native lifecycle cannot restore a resolver-spent upfront crystal');
assert.strictEqual(projectionInput.inventory[1459].amount, 1, 'projection retains the old canonical input');
const keptProjection = await Life.prepareResolve({ ...projected, stats: projected.stats }, keptAgain,
    { persist: false, projectClassProgression: true, timestamp: timestamp + 1000 });
assert.strictEqual(Number(keptProjection.inventory[1459]?.amount || 0), 0, 'projecting a carried servitor charges no second crystal');
const refusedProjection = await Life.prepareResolve({ ...projectionInput, inventory: {} }, noCrystal,
    { persist: false, projectClassProgression: true, timestamp });
assert.strictEqual(Number(refusedProjection.inventory[1459]?.amount || 0), 0, 'a refusal cannot mint a crystal during projection');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const partyState = { ...projectionInput, activity: 'grouped', party: { partyId: 'carry-material-party', role: 'mage' } };
const partyResolved = Party.resolve({ party: { partyId: 'carry-material-party', leaderId: partyState.characterId,
    cohesion: 0.7, risk: 0.2, stats: {} }, members: [partyState], spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert.strictEqual(partyResolved.debug.summonUses, 1, 'the genuine party resolver casts the same owned summon once');
const partyMember = partyResolved.memberResults[0];
const partyProjected = await Life.prepareResolve(partyMember.state, partyMember.result,
    { persist: false, projectClassProgression: true, timestamp });
assert.strictEqual(Number(partyProjected.inventory[1459]?.amount || 0), 0, 'party projection retains its own spent crystal');
assert.strictEqual(partyState.inventory[1459].amount, 1, 'party resource consumption stays in copied state');
const prepMember = raidPreparation.memberResults[0];
const prepProjected = await Life.prepareResolve(prepMember.state, prepMember.result,
    { persist: false, projectClassProgression: true, timestamp });
assert.strictEqual(Number(prepProjected.inventory[1459]?.amount || 0), 0, 'preparation projection preserves the already-debited private input');
// A native reward granted after this fight is added AFTER its cast debit.
const rewarded = await Life.prepareResolve(projectionInput, { ...fresh, materialize: { ...fresh.materialize,
    items: [{ selfId: 1459, name: crystal.template.name, amount: 1 }] } },
    { persist: false, projectClassProgression: true, timestamp });
assert.strictEqual(rewarded.inventory[1459].amount, 1, 'a distinct materialized reward does not erase the cast charge');
// Physical SQLite persistence is verified independently from training ownership.
// This is an already-owned historical unit state, not proof of a paid skill grant.
nativeDatabase = invoke('Database');
await nativeDatabase.init();
assert(nativeDatabase.isReady(), 'the isolated native schema opened successfully');
await nativeDatabase.createAccount('bot_carry_resource', 'fixture');
const physicalId = Number((await nativeDatabase.createCharacter('bot_carry_resource', {
    name: 'CarryResource', race: 0, classId: 14, maxHp: 3000, maxMp: 2500,
    sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 })).insertId);
await nativeDatabase.updateCharacterExperience(physicalId, 40, projectionInput.exp, 0);
await nativeDatabase.setItem(physicalId, { selfId: 1459, name: crystal.template.name, amount: 1, slot: 0, enchant: 0, equipped: false });
await Life.init();
const physicalInput = await Life.upsertState({ ...projectionInput, characterId: physicalId,
    accountName: 'bot_carry_resource', name: 'CarryResource',
    inventory: Life.inventorySummaryFromItems(await nativeDatabase.fetchItems(physicalId)) }, 'carry_historical_owned');
assert.strictEqual(physicalInput.inventory[1459].amount, 1, 'the physical stack exists before the native cast');
const physicalFight = BackgroundResolver.resolveSolo({ state: physicalInput, spot, elapsedMs: 12000, timestamp, rng: () => 0.1 });
assert.strictEqual(physicalFight.debug.summonUses, 1);
const committed = await Life.prepareResolve(physicalInput, physicalFight,
    { projectClassProgression: true, timestamp });
assert(committed, 'native lifecycle persistence publishes its actual resource result');
const physicalItems = await nativeDatabase.fetchItems(physicalId);
assert.strictEqual(physicalItems.filter(row => Number(row.selfId) === 1459).reduce((sum, row) => sum + Number(row.amount), 0), 0,
    'the real items table debits the upfront crystal');
const [physicalLife] = await nativeDatabase.execute(['SELECT inventorySummary FROM bot_life_state WHERE characterId = ?', [physicalId]]);
assert.strictEqual(Number(JSON.parse(physicalLife.inventorySummary)[1459]?.amount || 0), 0,
    'the actual persisted lifecycle summary contains the same debit');
assert.strictEqual(Number(committed.inventory[1459]?.amount || 0), 0, 'published native state cannot restore the paid crystal');
const noRecast = BackgroundResolver.resolveSolo({ state: committed, spot, elapsedMs: 12000, timestamp: timestamp + 1000, rng: () => 0.1 });
assert.strictEqual(noRecast.debug.summonUses || 0, 0, 'a physically committed carry retains the live summon');
const carriedCommit = await Life.prepareResolve(committed, noRecast,
    { projectClassProgression: true, timestamp: timestamp + 1000 });
assert(carriedCommit);
assert.strictEqual((await nativeDatabase.fetchItems(physicalId)).filter(row => Number(row.selfId) === 1459)
    .reduce((sum, row) => sum + Number(row.amount), 0), 0, 'the carry commit neither mints nor double-charges crystals');
console.log('Native summon crystal projection and SQLite consumption: input 1 -> cast/summary/items 0 -> carry 0');

console.log('test_cold_summon_carry: ok');
} finally { if (nativeDatabase?.isReady()) await nativeDatabase.close(); fs.rmSync(isolated.directory, { recursive: true, force: true }); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
