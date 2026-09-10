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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-hot-party-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now();
const saved = [];
function replace(object, key, value) { saved.push(() => { object[key] = value; }); object[key] = value; }
let spawnCount = 0, failAt = 0, hook = null, activeParty;
const notifications = [];

async function createParty(ids) {
    const prepared = Parties.prepareCommit({ partyId: `hot-test-${ids[0]}`, leaderId: ids[0], memberIds: ids,
        spotId: 'test', status: 'active', startedAt: at, nextResolveAt: at + 1000,
        stats: { objective: { npcId: 10 }, coldCompetition: { conflictUntil: at + 600000 } } });
    const assigned = ids.map((id, index) => Life.preparePartyAssignment(Life.cachedState(id), prepared.row.partyId,
        index ? 'mage' : 'tank', ids[0], at + 1000));
    assert((await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned })).ok);
    Life.acceptPartyAssignments(assigned);
    activeParty = Parties.acceptCommit(prepared);
    return activeParty;
}

function fakeSession(state, data) {
    const actor = { fetchId: () => state.characterId, fetchName: () => state.name, fetchLocX: () => data.locX,
        fetchLocY: () => data.locY, fetchLocZ: () => data.locZ, isDead: () => false, fetchIsOnline: () => true,
        fetchLevel: () => state.level, fetchHp: () => 80, fetchMaxHp: () => 100,
        fetchMp: () => 70, fetchMaxMp: () => 100, fetchClanId: () => 0,
        state: { fetchDead: () => false }, destructor() { this.destroyed = true; },
        automation: { replenishVitals() {}, stopReplenish() {} } };
    const session = { actor, accountId: state.accountName, coldLifeState: state, populationStaging: true,
        plan: 'hunting', dataSendToOthers() {} };
    actor.session = session;
    return session;
}

async function run() {
    Database.init();
    for (let id = 1; id <= 22; id++) {
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
        vitals: { hp: 80, maxHp: 100, mp: 70, maxMp: 100 } }));
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
    await Database.close(); Database.init();
    assert.strictEqual((await Database.execute(['SELECT status FROM bot_background_parties WHERE partyId=?', [party.partyId]]))[0].status, 'active');
    assert.strictEqual((await Database.execute(['SELECT COUNT(*) AS n FROM bot_life_state WHERE partyId=? AND phase=?', [party.partyId, 'cold']]))[0].n, 9);
    // A new process must recover an interrupted hot reservation as the same
    // cold group, even when Life and Parties initialize concurrently.
    await Database.execute(["UPDATE bot_background_parties SET status='hot' WHERE partyId=?", [party.partyId]]);
    await Database.execute(["UPDATE bot_life_state SET phase='hot' WHERE partyId=?", [party.partyId]]);
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
    `, options.default.Database.path, party.partyId], { cwd: path.resolve(__dirname, '..'), stdio: 'pipe' });
    console.log('Hot party lifecycle: atomic activation/cooldown, full roster publication, rollback, CAS, memory, visibility, PvP and reopen passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    saved.reverse().forEach(restore => restore());
    await Database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
