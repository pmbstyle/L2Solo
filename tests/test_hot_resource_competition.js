const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const Hot = invoke('GameServer/Bot/AI/HotResourceCompetition');
const Claims = invoke('GameServer/Bot/AI/BotMobCompetition');
const World = invoke('GameServer/World/World');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Database = invoke('Database');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Retreat = invoke('GameServer/Bot/AI/BotRetreatPlanner');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const AI = invoke('GameServer/Bot/BotAI');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-hot-resource-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const original = { user: World.user, npcs: World.fetchNpcsInRadius, incoming: Awareness.npcThreateningActor,
    plan: Retreat.plan, spot: Spots.findCurrentSpot, peace: utils.isInPeaceZone, now: Date.now,
    enabled: Config.backgroundPartyEnabled, limit: Config.maxBackgroundParties, enqueue: Memory.events.enqueue, promote: AI.promoteForPlayerInteraction };
let now = Date.now(), serial = 1000, emitted = [];
const sessions = [];
function actor(id) {
    const bot = { id, x: 0, dead: false, effects: {}, fetchId() { return id; }, fetchName: () => `Hot${id}`,
        fetchLevel() { return this.level || 20; }, fetchClassId: () => 0, fetchHp: () => 100, fetchMaxHp: () => 100,
        fetchMp: () => 100, fetchMaxMp: () => 100, fetchClanId: () => 0, fetchKarma: () => 0, fetchPvpFlag: () => 0,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true,
        isDead() { return this.dead; }, unselect() {}, state: { fetchDead: () => bot.dead, fetchCasts: () => false,
            fetchHits: () => false, fetchTowards: () => false, fetchSeated: () => false, setHits() {}, setCasts() {} },
        automation: { abortAll() {} }, moveTo({ to }) { this.requested = to; },
        skillset: { fetchSkills: () => [] }, backpack: { fetchItems: () => [] } };
    const s = { actor: bot, aiActive: true, plan: 'hunting', accountId: `bot_hot_${id}`,
        coldLifeState: Life.cachedState(id), persona: { traits: { caution: 0.5, assertiveness: 0.5, sociability: 0.8, empathy: 0.5 } } };
    bot.session = s; sessions.push(s); return s;
}
function mob(owner) {
    const target = { fetchId: () => target.id, id: serial++, fetchKind: () => 'Monster', fetchSelfId: () => 10,
        fetchHp: () => 100, fetchLocX: () => 100, fetchLocY: () => 0, fetchLocZ: () => 0, isDead: () => false,
        state: { fetchDead: () => false } };
    owner.currentTargetId = target.id;
    World.fetchNpcsInRadius = () => [target];
    Claims.record(owner.actor, target, now);
    return target;
}
async function run() {
    Date.now = () => now;
    AI.promoteForPlayerInteraction = () => {};
    Config.backgroundPartyEnabled = true; Config.maxBackgroundParties = 60;
    World.user = { sessions }; Awareness.npcThreateningActor = s => s.incoming || null;
    utils.isInPeaceZone = () => false;
    Spots.findCurrentSpot = () => ({ id: 'field' });
    Retreat.plan = bot => ({ safe: true, movesAway: true, routeUsable: true, requestedTo: { locX: bot.x - 1400, locY: 0, locZ: 0 } });
    Memory.events.enqueue = event => { emitted.push(event); return true; };
    Database.init();
    for (let id = 1; id <= 32; id++) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_hot_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_hot_${id}`, `Hot${id}`]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,updatedAt,statsJson)
            VALUES (?,?,?,'hot','hunting','field',100,100,100,100,20,?,'{}')`, [id, `bot_hot_${id}`, `Hot${id}`, now]]);
    }
    await Life.init(); await Parties.init(); await Memory.ensureMany(Array.from({ length: 32 }, (_, i) => i + 1));
    await Database.execute(["UPDATE bot_life_state SET phase='hot', spotId='old-field'", []]);
    (await Database.execute(['SELECT * FROM bot_life_state', []])).forEach(row => Life.acceptLifecycleRow(row));
    const a = actor(1), b = actor(2), first = mob(b);
    a.currentTargetId = first.id;
    assert(Hot.beforeAttack(a, first, now, () => 0));
    assert(a.hotCompetitionCommit && b.hotCompetitionCommit, 'both sides are reserved during asynchronous admission');
    assert.strictEqual(invoke('GameServer/Bot/Population/Cooldown').canCooldown(a).reason, 'social_party_commit');
    await a.hotCompetitionPending;
    assert(a.hotBackgroundPartyId && a.hotBackgroundPartyId === b.hotBackgroundPartyId);
    assert(!a.partyCompanion && !b.partyCompanion && !a.followPlayerSession, 'autonomous membership never becomes a player companion');
    const partyId = a.hotBackgroundPartyId;
    assert.strictEqual(Parties.find(partyId).status, 'hot');
    assert.strictEqual(Life.cachedState(1).spotId, 'field', 'formation uses the actual shared ground, not an old cold destination');
    assert.strictEqual(invoke('GameServer/Bot/AI/HotBackgroundParty').roster(a).length, 2);
    assert(!a.hotCompetitionCommit && !b.hotCompetitionCommit);
    assert.strictEqual(emitted.length, 0, 'agreement before the first hit creates no offense');
    assert.strictEqual(Hot.beforeAttack(a, first, now, () => { throw Error('teammates do not reroll'); }), false);
    assert.strictEqual(Claims.record(a.actor, first, now + 1), false);
    assert.strictEqual(emitted.length, 0, 'native accepted hits after joining are shared hunting');
    now += 120001;
    const c = actor(3), second = mob(a);
    assert(Hot.beforeAttack(c, second, now, () => 0)); await c.hotCompetitionPending;
    assert.strictEqual(c.hotBackgroundPartyId, partyId, 'a solo can join an existing hot party');
    assert.strictEqual(Parties.find(partyId).memberIds.length, 3);
    now += 120001;
    const d = actor(4), third = mob(d);
    assert(Hot.beforeAttack(a, third, now, () => 0));
    await Hot.side(a).owner.hotCompetitionPending;
    assert.strictEqual(d.hotBackgroundPartyId, partyId, 'a party can offer membership to a solo claimant');
    now += 120001;
    const y = actor(5), z = actor(6), contested = mob(z);
    y.currentTargetId = contested.id;
    assert(Hot.beforeAttack(y, contested, now, () => 0.99));
    assert.strictEqual(y.currentTargetId, undefined);
    assert(Hot.tick(y, now + 1));
    assert(Hot.blockedTarget(y, contested, now + 1), 'the next target scan does not immediately reclaim the yielded mob');
    assert(!Hot.tick(y, now + Hot.WAIT_MS));
    assert.strictEqual(emitted.length, 0);
    const runner = actor(7), strong = actor(8); strong.actor.level = 60;
    const scary = mob(strong);
    runner.persona.traits.caution = 1;
    assert(Hot.beforeAttack(runner, scary, now, () => 0));
    assert(runner.actor.requested.locX < 0, 'avoid sends a real movement command away from the rival');
    assert(Hot.blockedTarget(runner, { fetchLocX: () => 500, fetchLocY: () => 0, fetchLocZ: () => 0 }, now + 1));
    runner.incoming = scary;
    assert(!Hot.tick(runner, now + 2) && !runner.hotCompetitionHold, 'a new incoming mob overrides the social retreat');
    assert(!Hot.beforeAttack(runner, scary, now + 2, () => { throw Error('defense does not reroll'); }));
    const aggressive = actor(9), victim = actor(10), stolen = mob(victim);
    aggressive.persona.traits = { caution: 0, assertiveness: 1, ambition: 1, empathy: 0, sociability: 0 };
    const rolls = [0.99, 0.99, 0, 0.99];
    assert(!Hot.beforeAttack(aggressive, stolen, now, () => rolls.shift()));
    assert.strictEqual(emitted.length, 0, 'contest intent alone is not an offense');
    Claims.record(aggressive.actor, stolen, now + 1, () => 0.99);
    assert.strictEqual(emitted.length, 1, 'an accepted competing swing still records the actual offense');
    const peaceful = actor(11), occupied = actor(12), busy = mob(occupied);
    World.fetchNpcsInRadius = () => [busy, { ...busy, id: serial++ }];
    assert(Hot.beforeAttack(peaceful, busy, now, () => { throw Error('available resources need no random roll'); }));
    assert.strictEqual(peaceful.lastDecision.action, 'competition_coexist');
    assert(!Hot.tick(peaceful, now + 1000), 'coexist replans promptly instead of paying the full yield delay');
    const companion = actor(13); companion.partyCompanion = true;
    assert(!Hot.beforeAttack(companion, busy, now, () => { throw Error('player party remains independent'); }));
    const unloaded = actor(14); Memory.forget(14);
    assert(Hot.beforeAttack(unloaded, busy, now, () => { throw Error('unloaded is not neutral'); }));
    assert(!unloaded.pvpRevenge);
    const corpse = { ...busy, isDead: () => true };
    assert(!Hot.beforeAttack(y, corpse, now, () => { throw Error('a corpse is not a claimed hunting resource'); }));
    // Admission rechecks the live actor inside the same transaction as membership.
    const raceA = actor(15), raceB = actor(16), raceMob = mob(raceB);
    const commit = Database.commitBackgroundPartyMembership;
    Database.commitBackgroundPartyMembership = async args => { raceA.partyCompanion = true; return commit.call(Database, args); };
    try { assert(Hot.beforeAttack(raceA, raceMob, now, () => 0)); await raceA.hotCompetitionPending; }
    finally { Database.commitBackgroundPartyMembership = commit; }
    assert(!raceA.hotBackgroundPartyId && !raceB.hotBackgroundPartyId);
    assert(!raceA.hotCompetitionCommit && !raceB.hotCompetitionCommit);
    const hookA = actor(17), hookB = actor(18), hookMob = mob(hookB);
    const random = Math.random;
    try {
        Math.random = () => 0.99;
        assert.strictEqual(AI.executeCombat(hookA, hookA.actor, hookMob, {}), false);
        assert.strictEqual(hookA.lastDecision.action, 'competition_yield', 'the real combat entrypoint stops before a hostile skill or swing');
    } finally { Math.random = random; }
    const otherA = actor(19), otherB = actor(20), shared = mob(otherB);
    assert(Hot.beforeAttack(otherA, shared, now, () => 0)); await otherA.hotCompetitionPending;
    now += 120001;
    const partyTarget = mob(otherA);
    assert(Hot.beforeAttack(a, partyTarget, now, () => 0.99));
    assert([a, b, c, d].every(s => s.hotCompetitionHold?.action === 'yield'), 'party vs party yields the entire initiating roster');
    assert(!otherA.hotCompetitionHold && !otherB.hotCompetitionHold, 'the other party keeps its hunt');
    b.incoming = partyTarget;
    assert(!Hot.tick(a, now + 1), 'an add on another member cancels the shared pause');
    assert([a, b, c, d].every(s => !s.hotCompetitionHold));
    b.incoming = null;
    // A hot party consumes the same admission ceiling as a cold one.
    Config.maxBackgroundParties = Parties.admitted().length;
    assert.strictEqual(Population.reserveCompetitionPartySlot(), null);
    // Verify the ordinary hot-to-cold transaction accepts the newly formed roster.
    const party = Parties.find(partyId), states = party.memberIds.map(id => Life.cachedState(id));
    const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
    const cooled = await Database.transitionBackgroundParty({ partyId, expectedStatus: 'hot', expectedUpdatedAt: party.updatedAt,
        expectedPhase: 'hot', phase: 'cold', nextResolveAt: now + 30000, statsJson: JSON.stringify(party.stats),
        members: states.map(s => ({ characterId: s.characterId, expectedRevision: s.simulation.revision, expectedUpdatedAt: s.updatedAt,
            patch: Owner.persistencePatch({ ...s, phase: 'cold', activity: 'grouped', timing: { ...s.timing, lastResolvedAt: now } }, now) })) });
    assert(cooled.ok, JSON.stringify(cooled));
    await Database.close(); Database.init();
    const saved = await Database.execute(['SELECT status, memberIdsJson FROM bot_background_parties WHERE partyId=?', [partyId]]);
    assert.strictEqual(saved[0].status, 'active');
    assert.strictEqual(JSON.parse(saved[0].memberIdsJson).length, 4, 'formation and both recruitment directions survive reopen and cooldown');
    assert.strictEqual((await invoke('GameServer/Social/InteractionMemoryRepository').load(1)).relations.length, 0, 'joining alone gives no farming credit');
    console.log('Hot resource competition: shared policy, native claim attribution, movement, persistent parties, recruitment, admission race and cooldown passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    Date.now = original.now; World.user = original.user; World.fetchNpcsInRadius = original.npcs;
    Awareness.npcThreateningActor = original.incoming; Retreat.plan = original.plan; Spots.findCurrentSpot = original.spot;
    utils.isInPeaceZone = original.peace; Config.backgroundPartyEnabled = original.enabled; Config.maxBackgroundParties = original.limit;
    Memory.events.enqueue = original.enqueue;
    sessions.forEach(s => AI.stop(s));
    AI.promoteForPlayerInteraction = original.promote;
    await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});
