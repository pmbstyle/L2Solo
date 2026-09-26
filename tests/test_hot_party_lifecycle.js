const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Lifecycle = invoke('GameServer/Bot/Population/HotPartyLifecycle');
const Manager = invoke('GameServer/Bot/BotManager');
const World = invoke('GameServer/World/World');
const AI = invoke('GameServer/Bot/BotAI');
const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const RaidIndex = invoke('GameServer/World/RaidEntityIndex');
const RaidSafety = invoke('GameServer/Bot/AI/BotRaidSafety');
const RaidMinions = invoke('GameServer/World/RaidBossMinionManager');
const ClanEquipment = invoke('GameServer/Clan/ClanEquipmentService');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-hot-party-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now();
const saved = [];
function replace(object, key, value) { saved.push(() => { object[key] = value; }); object[key] = value; }
let spawnCount = 0, failAt = 0, hook = null, activeParty;
const notifications = [];

async function createParty(ids, extraStats = {}) {
    const prepared = Parties.prepareCommit({ partyId: `hot-test-${ids[0]}`, leaderId: ids[0], memberIds: ids,
        spotId: 'test', status: 'active', startedAt: at, nextResolveAt: at + 1000,
        stats: { objective: { npcId: 10, ...(extraStats.objective || {}) },
            coldCompetition: { conflictUntil: at + 600000 }, ...extraStats } });
    const assigned = ids.map((id, index) => Life.preparePartyAssignment(Life.cachedState(id), prepared.row.partyId,
        index ? 'mage' : 'tank', ids[0], at + 1000));
    assert((await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned })).ok);
    Life.acceptPartyAssignments(assigned);
    activeParty = Parties.acceptCommit(prepared);
    return activeParty;
}

function fakeSession(state, data) {
    let hp = 80, mp = 70, dead = false;
    const actor = { fetchId: () => state.characterId, fetchName: () => state.name, fetchLocX: () => data.locX,
        fetchLocY: () => data.locY, fetchLocZ: () => data.locZ, isDead: () => dead, fetchIsOnline: () => true,
        fetchLevel: () => state.level, fetchHp: () => hp, fetchMaxHp: () => 100, setHp: value => { hp = value; },
        fetchMp: () => mp, fetchMaxMp: () => 100, setMp: value => { mp = value; }, fetchClanId: () => 0,
        state: { fetchDead: () => dead, setDead: value => { dead = value; } }, destructor() { this.destroyed = true; },
        automation: { replenishVitals() {}, stopReplenish() {} } };
    const session = { actor, accountId: state.accountName, coldLifeState: state, populationStaging: true, spawnData: data,
        plan: 'hunting', dataSendToOthers() {} };
    actor.session = session;
    return session;
}

async function run() {
    Database.init();
    for (let id = 1; id <= 25; id++) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_hot_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_hot_${id}`, `Hot${id}`]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            nextResolveAt,lastResolvedAt,updatedAt,statsJson) VALUES (?,?,?,'cold','hunting','test',100,100,100,100,20,?,?,?,?)`,
        [id, `bot_hot_${id}`, `Hot${id}`, at + 1000, at - 60000, at, JSON.stringify({ role: 'mage' })]]);
    }
    await Life.init(); await Parties.init(); await Memory.ensureMany([1, 2, 3]);
    const beforeMemory = JSON.stringify([1, 2, 3].map(id => Memory.snapshot(id)));
    replace(World, 'user', { sessions: [] }); replace(Manager, 'sessions', []);
    replace(World, 'insertUser', session => { World.user.sessions.push(session); });
    replace(World, 'removeUser', session => { World.user.sessions = World.user.sessions.filter(s => s !== session); });
    replace(World, 'fetchVisibleRealPlayers', () => []);
    replace(World, 'fetchNpcsInRadius', () => []);
    replace(Placement, 'resolve', state => ({ loc: { ...state.loc }, spot: { id: state.spotId } }));
    replace(Coordinator, 'fenceBot', async () => ({ ok: true }));
    replace(Coordinator, 'notifyState', state => { notifications.push(state); });
    replace(AI, 'stop', session => { session.aiActive = false; });
    replace(AI, 'init', session => {
        assert(activeParty.memberIds.every(id => World.user.sessions.some(s => s.actor?.fetchId() === id)), 'AI starts only after full publication');
        session.aiActive = true;
    });
    replace(Tactics, 'stop', () => {});
    const Response = invoke('GameServer/Network/Response');
    replace(Response, 'charInfo', () => Buffer.alloc(0));
    replace(Response, 'relationChanged', () => Buffer.alloc(0));
    replace(Life, 'partySessionSnapshot', (session, state, phase) => ({ ...state, phase,
        vitals: { hp: session.actor.fetchHp(), maxHp: 100, mp: session.actor.fetchMp(), maxMp: 100 } }));
    replace(Manager, 'loadAndSpawnBot', async (_account, data) => {
        assert(data.prepareOnly && data.coldLifeState.party.partyId, 'staged spawn preserves party identity');
        assert(activeParty.memberIds.every(id => Life.cachedState(id).phase === 'hot'), 'reserve every member before staging');
        assert(!World.user.sessions.length, 'staging does not publish a partial group');
        if (hook) await hook();
        if (++spawnCount === failAt) throw Error('synthetic spawn failure');
        return fakeSession(data.coldLifeState, data);
    });
    let party = await createParty([1, 2, 3]);
    const claims = await Owner.claimBatch(party.memberIds.map(id => Life.cachedState(id)), { allowParty: true, allowLifecycle: true });
    assert.strictEqual(claims.grants.length, 3);
    const originalStates = party.memberIds.map(id => Life.cachedState(id));
    const activated = await Lifecycle.activate(party.partyId);
    assert(activated.ok, JSON.stringify(activated));
    assert.strictEqual(Parties.find(party.partyId).status, 'hot');
    assert.strictEqual(World.user.sessions.length, 3);
    assert(Manager.sessions.every(s => s.aiActive && s.hotBackgroundPartyId === party.partyId && !s.partyCompanion));
    assert.deepStrictEqual(Manager.sessions.map(s => s.coldLifeState.party.role), ['tank', 'mage', 'mage']);
    assert(Manager.sessions.every(s => s.coldLifeState.party.leaderId === 1));
    const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    assert.strictEqual(invoke('GameServer/Bot/AI/PartyCompanionService').attach({ actor: {} }, Manager.sessions[1]), false,
        'direct companion attachment cannot steal a member from the hot lifecycle');
    assert.deepStrictEqual(Awareness.partyActors(Manager.sessions[1]).map(a => a.fetchId()), [1, 2, 3],
        'native party spells see the full autonomous roster from any member');
    assert.strictEqual(await Parties.createOrUpdate({ ...party, status: 'dissolved' }), null,
        'stale cold maintenance cannot dissolve a hot party');
    assert.strictEqual(Parties.find(party.partyId).status, 'hot');
    const Lod = invoke('GameServer/Bot/AI/HotActorLodPolicy');
    Manager.sessions[0].actor.state.fetchHits = () => true;
    assert.strictEqual(Lod.evaluate(Manager.sessions[1], [], Date.now()).tier, 'full',
        'a fighting member keeps the healer active even outside player visibility');
    Manager.sessions[0].actor.state.fetchHits = () => false;
    const stale = await Owner.commitAndReleaseBatch(originalStates.map((state, index) => ({ token: claims.grants[index], nextState: state,
        atomicGroup: { id: 'stale', memberIds: [1, 2, 3] } })), { allowParty: true, allowLifecycle: true });
    assert(stale.every(r => !r.ok), 'stale cold worker cannot overwrite the hot party');
    const group = Manager.sessions.slice();
    group[2].pvpDefense = {};
    assert(!(await Lifecycle.cooldown(party.partyId, 'test', { ignoreVisibility: true })).ok);
    assert.strictEqual(World.user.sessions.length, 3, 'one fighting member keeps everyone hot');
    delete group[2].pvpDefense;
    const originalSettle = Life.settleWrites;
    Life.settleWrites = async ids => { await originalSettle.call(Life, ids); group[2].pvpDefense = {}; };
    assert(!(await Lifecycle.cooldown(party.partyId, 'test', { ignoreVisibility: true })).ok,
        'new aggression while awaiting writes aborts cooling');
    assert(group.every(s => s.aiActive), 'aborted cooldown resumes all AI');
    Life.settleWrites = originalSettle;
    delete group[2].pvpDefense;
    replace(Population, 'realPlayerSessions', () => [{ actor: group[0].actor }]);
    assert(!(await Lifecycle.cooldown(party.partyId)).ok, 'one nearby player keeps the group visible');
    const cooled = await Lifecycle.cooldown(party.partyId, 'test', { ignoreVisibility: true });
    assert(cooled.ok, JSON.stringify(cooled));
    assert(!World.user.sessions.length && !Manager.sessions.length);
    assert(group.every(s => !s.actor && !s.aiActive));
    assert.strictEqual(Parties.find(party.partyId).status, 'active');
    assert(cooled.states.every(s => s.phase === 'cold' && s.vitals.hp === 80 && s.timing.lastResolvedAt >= at));
    assert.strictEqual(Parties.find(party.partyId).stats.coldCompetition.conflictUntil, at + 600000);
    assert.strictEqual(JSON.stringify([1, 2, 3].map(id => Memory.snapshot(id))), beforeMemory, 'lifecycle does not invent relationship events');
    assert.strictEqual(notifications.length, 3);

    party = await createParty([4, 5, 6]); spawnCount = 0; failAt = 2;
    const failed = await Lifecycle.activate(party.partyId);
    assert(!failed.ok && failed.reason === 'synthetic spawn failure');
    assert(party.memberIds.every(id => Life.cachedState(id).phase === 'cold'));
    assert.strictEqual(Parties.find(party.partyId).status, 'active');
    assert(!World.user.sessions.length && !Manager.sessions.length);
    assert(!Lifecycle.pending.size);

    party = await createParty([7, 8]); spawnCount = 0; failAt = 0;
    let release, entered;
    const enteredPromise = new Promise(r => { entered = r; });
    const pause = new Promise(r => { release = r; });
    hook = async () => { entered(); await pause; };
    const first = Lifecycle.activate(party.partyId);
    await enteredPromise;
    assert.strictEqual((await Lifecycle.activate(party.partyId)).reason, 'party_transition_pending');
    release(); assert((await first).ok); hook = null;
    assert((await Lifecycle.cooldown(party.partyId, 'test', { ignoreVisibility: true })).ok);

    party = await createParty(Array.from({ length: 9 }, (_, i) => i + 9)); spawnCount = 0;
    assert((await Lifecycle.activate(party.partyId)).ok, 'full nine-member party can activate');
    const hotRows = await Database.execute(['SELECT phase,partyId,statsJson FROM bot_life_state WHERE partyId=?', [party.partyId]]);
    assert.strictEqual(hotRows.length, 9); assert(hotRows.every(r => r.phase === 'hot'));
    const hot = Parties.find(party.partyId), current = hot.memberIds.map(id => Life.cachedState(id));
    const invalid = await Database.transitionBackgroundParty({ partyId: hot.partyId, expectedStatus: 'hot', expectedUpdatedAt: hot.updatedAt,
        expectedPhase: 'hot', phase: 'cold', nextResolveAt: at + 30000, statsJson: '{}',
        members: current.map((s, index) => ({characterId:s.characterId, expectedRevision:s.simulation.revision + Number(index === 8),
            expectedUpdatedAt:s.updatedAt, patch: Owner.persistencePatch({...s, phase:'cold'})})) });
    assert(!invalid.ok, 'a stale last member aborts the entire transaction');
    assert((await Database.execute(['SELECT phase FROM bot_life_state WHERE partyId=?', [party.partyId]])).every(r => r.phase === 'hot'));
    assert((await Lifecycle.cooldown(party.partyId, 'test', { ignoreVisibility: true })).ok);
    const recoveryPartyId = party.partyId;

    party = await createParty([21, 22], {
        objective: { sourceKind: 'raid', raidBoss: true, raidBossTemplateId: 999999,
            npcId: 999999, sourceLevel: 10 }
    });
    const unsafeRaidActivation = await Lifecycle.activate(party.partyId);
    assert.strictEqual(unsafeRaidActivation.ok, false);
    assert.strictEqual(unsafeRaidActivation.reason, 'party_not_ready');
    assert.match(unsafeRaidActivation.detail, /^member_(21|22)_raid_level$/,
        'hot activation must reject a synthetic or stale raid roster that would receive Raid Curse');
    assert([21, 22].every(id => Life.cachedState(id).phase === 'cold'),
        'rejected overlevel raid members must remain in cold simulation');

    party = await createParty([18, 19, 20], {
        objective: { sourceKind: 'raid', raidBoss: true, raidBossTemplateId: 10131, npcId: 10131 },
        raidEncounter: { status: 'active', bossTemplateId: 10131, hp: 400, maxHp: 1000,
            encounter: { mob: { maxHp: 1000 } }, revision: 1 }
    });
    spawnCount = 0;
    assert((await Lifecycle.activate(party.partyId)).ok, 'raid party can activate');
    const raidSessions = Manager.sessions.slice();
    const deadSession = raidSessions[1];
    raidSessions[0].actor.fetchClassId = () => 4;
    raidSessions[1].actor.fetchClassId = () => 15;
    raidSessions[2].actor.fetchClassId = () => 0;
    let bossHp = 400;
    let failurePersistedBeforeReset = false;
    const boss = {
        fetchId: () => 900001,
        fetchSelfId: () => 10131,
        fetchHp: () => bossHp,
        fetchMaxHp: () => 1000,
        isDead: () => false,
        setHp(value) {
            assert(failurePersistedBeforeReset, 'boss HP resets only after the failed raid is durable');
            bossHp = value;
        },
        statusUpdateVitals() {},
        abortCombatState() {},
        state: { fetchDead: () => false }
    };
    replace(RaidIndex, 'bossByTemplateId', () => boss);
    replace(RaidIndex, 'entitiesForRaid', () => [boss]);
    replace(RaidMinions, 'onBossDeath', () => 0);
    replace(RaidMinions, 'attachBoss', () => null);
    const retreating = [];
    replace(RaidSafety, 'retreat', (session) => {
        retreating.push(session.actor.fetchId());
        session.plan = 'fleeing';
        return true;
    });
    const originalTransition = Database.transitionBackgroundParty.bind(Database);
    replace(Database, 'transitionBackgroundParty', async (request) => {
        const result = await originalTransition(request);
        if (result.ok && JSON.parse(request.statsJson || '{}').raidEncounter?.status === 'failed') {
            failurePersistedBeforeReset = true;
        }
        return result;
    });
    let recordedFailure = null;
    replace(ClanEquipment, 'recordRaidFailure', async (failedParty) => { recordedFailure = failedParty.partyId; });
    assert.strictEqual(Lifecycle.criticalRaidCasualty({ classId: 17 }), true,
        'a caster buffer death must cancel the raid');
    assert.strictEqual(Lifecycle.criticalRaidCasualty({ classId: 21 }), false,
        'a singer death is a damage casualty, not a critical buffer loss');
    assert.strictEqual(Lifecycle.raidDeathDisposition({ classId: 0 }, {
        previousDamageCasualties: 0, remainingHpRatio: 0.9
    }), 'continue', 'the first damage death should not cancel an otherwise viable raid');
    assert.strictEqual(Lifecycle.raidDeathDisposition({ classId: 0 }, {
        previousDamageCasualties: 1, remainingHpRatio: 0.4
    }), 'continue', 'additional damage losses may still try to finish a boss below half HP');
    assert.strictEqual(Lifecycle.raidDeathDisposition({ classId: 0 }, {
        previousDamageCasualties: 1, remainingHpRatio: 0.8
    }), 'fail_attrition', 'repeated early damage losses should end a collapsing raid');

    const damageCasualty = raidSessions[2];
    damageCasualty.actor.isDead = () => true;
    damageCasualty.actor.state.fetchDead = () => true;
    const continuedRaid = await Lifecycle.failRaidOnDeath(damageCasualty, at + 4000);
    assert(continuedRaid.ok && continuedRaid.continued, JSON.stringify(continuedRaid));
    assert.strictEqual(continuedRaid.remainingHpRatio, 0.4);
    assert.strictEqual(Parties.find(party.partyId).stats.raidEncounter.status, 'active');
    assert.strictEqual(bossHp, 400, 'a damage casualty does not heal or cancel the live raid');
    assert.strictEqual(damageCasualty.hotRaidCasualtyRole, 'dps');
    assert.deepStrictEqual(retreating, []);
    damageCasualty.actor.isDead = () => false;
    damageCasualty.actor.state.fetchDead = () => false;

    deadSession.actor.isDead = () => true;
    deadSession.actor.state.fetchDead = () => true;

    const failedRaid = await Lifecycle.failRaidOnDeath(deadSession, at + 5000);
    assert(failedRaid.ok, JSON.stringify(failedRaid));
    assert.strictEqual(Parties.find(party.partyId).status, 'hot');
    assert.strictEqual(Parties.find(party.partyId).stats.raidEncounter.status, 'failed');
    assert.strictEqual(Parties.find(party.partyId).stats.raidEncounter.remainingHpRatio, 0.4);
    assert.strictEqual(bossHp, 1000, 'the failed raid restores the boss after persistence');
    assert.deepStrictEqual(retreating.sort((a, b) => a - b), [18, 20],
        'every living survivor receives the same raid retreat');

    deadSession.actor.isDead = () => false;
    deadSession.actor.state.fetchDead = () => false;
    const failedCooldown = await Lifecycle.cooldown(party.partyId, 'raid_failed', { ignoreVisibility: true });
    assert(failedCooldown.ok, JSON.stringify(failedCooldown));
    assert.strictEqual(Parties.find(party.partyId).status, 'dissolved');
    assert.strictEqual(recordedFailure, party.partyId);
    assert([18, 19, 20].every(id => !Life.cachedState(id).party.partyId),
        'failed raid dissolution releases the complete roster');

    party = await createParty([23, 24, 25], {
        objective: { sourceKind: 'raid', raidBossTemplateId: 10131, npcId: 10131 },
        raidEncounter: { status: 'active', bossTemplateId: 10131, hp: 400, maxHp: 1000,
            encounter: { mob: { maxHp: 1000 } }, revision: 1 }
    });
    for (const memberId of party.memberIds) {
        const state = Life.cachedState(memberId);
        await Life.upsertState({ ...state, activity: memberId === 25 ? 'dead' : 'grouped',
            vitals: { hp: memberId === 25 ? 0 : 45, maxHp: 100, mp: 30, maxMp: 100 } }, 'test_raid_handoff');
    }
    spawnCount = 0;
    const resumed = await Lifecycle.activate(party.partyId);
    assert(resumed.ok, JSON.stringify(resumed));
    assert(Manager.sessions.every(s => s.raidPreparationComplete && !s.spawnData.spawnReady && !s.spawnData.readyOnActivation));
    assert.deepStrictEqual(Manager.sessions.map(s => s.actor.fetchHp()), [45, 45, 0], 'ongoing raid keeps injuries and corpse');
    assert(Manager.sessions.every(s => s.actor.fetchMp() === 30), 'activation must not refill raid MP');
    assert(Manager.sessions[2].actor.isDead() && Manager.sessions[2].hotRaidCasualtyAt,
        'cold DD casualty stays dead and is not counted as a new hot death');

    const hotBoss = Parties.find(party.partyId).stats.hotRaidBoss;
    assert.equal(hotBoss.instanceId, invoke('GameServer/RaidBoss/RaidEncounterScope').instanceId(boss));
    assert.equal(hotBoss.maxHp, 1000);
    Manager.sessions[2].actor.state.setDead(false);
    Manager.sessions[2].actor.setHp(50); // survivor revived before the party leaves
    replace(RaidIndex, 'bossByTemplateId', () => null); // corpse decayed before hot -> cold
    const victoryCooldown = await Lifecycle.cooldown(party.partyId, 'test_victory', { ignoreVisibility: true });
    assert(victoryCooldown.ok, JSON.stringify(victoryCooldown));
    const captured = Parties.find(party.partyId).stats.raidEncounter;
    assert.equal(captured.status, 'defeated');
    assert.equal(captured.raidInstanceId, hotBoss.instanceId);
    assert.equal(captured.maxHp, 1000, 'corpse decay must not reduce the captured boss to 1 HP');
    const beforeRelease = Life.cachedState(23);
    const raidMember = await Life.upsertState({ ...beforeRelease, activity: 'grouped', spotId: 'raid:10131',
        stats: { ...beforeRelease.stats, clanPartyObjective: party.stats.objective,
            equipmentPlan: { next: { sourceKind: 'raid' } }, pveEncounter: { hp: 1 } } }, 'test_detach');
    const detached = await Life.leaveParty(raidMember, 'raid_defeated');
    assert.equal(detached.spotId, null);
    assert.equal(detached.party.partyId, null);
    assert.equal(detached.activity, 'hunting');
    assert.equal(detached.stats.clanPartyObjective, null);
    assert.equal(detached.stats.equipmentPlan, null);
    assert.equal(detached.stats.pveEncounter, null);
    assert.equal(detached.exp, beforeRelease.exp);
    assert.deepStrictEqual(detached.loc, beforeRelease.loc);

    await Database.close(); Database.init();
    assert.strictEqual((await Database.execute(['SELECT status FROM bot_background_parties WHERE partyId=?', [recoveryPartyId]]))[0].status, 'active');
    assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM bot_life_state WHERE partyId=? AND phase=?', [recoveryPartyId, 'cold']]))[0].n, 9);
    // A new process must recover an interrupted hot reservation as the same
    // cold group, even when Life and Parties initialize concurrently.
    await Database.execute(["UPDATE bot_background_parties SET status='hot' WHERE partyId=?", [recoveryPartyId]]);
    await Database.execute(["UPDATE bot_life_state SET phase='hot' WHERE partyId=?", [recoveryPartyId]]);
    await Database.close();
    require('child_process').execFileSync(process.execPath, ['-e', `
        require('./src/Global');
        options.default.Database.path = process.argv[1];
        const D = invoke('Database'), L = invoke('GameServer/Bot/Population/BotLifeState'), P = invoke('GameServer/Bot/Population/BackgroundPartyState');
        D.init();
        Promise.all([L.init(), P.init()]).then(() => {
            const p = P.find(process.argv[2]);
            require('assert')(p?.status === 'active' && p.memberIds.length === 9);
            require('assert')(p.memberIds.every(id => L.cachedState(id)?.phase === 'cold' && L.cachedState(id)?.party.partyId === p.partyId));
        }).catch(e => { console.error(e); process.exitCode = 1; }).finally(() => D.close());
    `, options.default.Database.path, recoveryPartyId], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
    console.log('Hot party lifecycle: atomic activation/cooldown, full roster publication, rollback, CAS, memory, visibility, PvP and reopen passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    saved.reverse().forEach(restore => restore());
    await Database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
