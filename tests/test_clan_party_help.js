const assert = require('assert');
require('./helpers/databaseIsolation');
require('../src/Global');
const Help = invoke('GameServer/Bot/Population/ClanPartyHelp');
const Chat = invoke('GameServer/Bot/AI/BotClanChat');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Clan = invoke('GameServer/Clan/ClanService');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const World = invoke('GameServer/World/World');

// Native ActorModel/World publication follows test_n62_visibility_index.
// This isolated fixture creates no database rows, cold claims or World timers.
const ActorModel = invoke('GameServer/Model/Actor');
const publishedSessions = new Set();
let fixtureWorld;
function clearPublishedSessions() {
    // Disconnect the whole old scene before removing its registrations: no
    // still-connected peer should receive an unrelated clan UI update here.
    for (const session of publishedSessions) session.actor.setIsOnline(false);
    for (const session of publishedSessions) World.removeUser(session);
    publishedSessions.clear();
}
function publishSessions(sessions) {
    clearPublishedSessions();
    if (!fixtureWorld) {
        fixtureWorld = { sessions: [], revision: 0 };
        World.user = fixtureWorld;
    }
    for (const session of sessions) {
        session.actor.session = session;
        World.insertUser(session);
        session.actor.setIsOnline(true);
        publishedSessions.add(session);
    }
}
function presenceSession(characterId, accountId, receive, clanId = 0, locX = 0) {
    const session = { accountId, fetchAccountId() { return this.accountId; },
        socket: { write() {}, destroy() {} }, dataSendToMe: receive,
        dataSendToMeAndOthers() {}, dataSendToOthers() {} };
    session.actor = new ActorModel({ id: characterId, name: accountId, username: accountId,
        title: '', level: 20, classId: 0, clanId, clanPrivileges: 0,
        locX, locY: 0, locZ: 0, hp: 100, maxHp: 100, isOnline: false });
    session.actor.session = session;
    return session;
}

const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Response = invoke('GameServer/Network/Response');
const originals = [];
function stub(object, key, value) { const old = object[key]; originals.push(() => { object[key] = old; }); object[key] = value; }
const bot = (id, extra = {}) => ({ characterId: id, name: `Bot${id}`, phase: 'cold', activity: 'hunting',
    level: 20, spotId: 'safe', vitals: { hp: 500 }, stats: { clanId: 11 }, ...extra });
let now = 1000000, rows, parties, clanIds, reads, commits, creates, packets;
// Declared native listener, distinct from the original cold member IDs 1/2/3.
const player = presenceSession(8000009, 'human', packet => packets.push(packet), 11);
function reset() {
    Help.reset(); Chat.reset(); rows = [bot(1), bot(2), bot(3)]; parties = []; clanIds = [1, 2, 3];
    reads = commits = creates = 0; packets = []; publishSessions([player]);
}
const callbacks = {
    async commit(party) { commits++; parties = [party]; return { party, failed: [] }; },
    async create(members, objective) { creates++; const party = { partyId: 'new', status: 'active',
        leaderId: members[0].characterId, memberIds: members.map(m => m.characterId), stats: { objective } };
        parties = [party]; return party; }
};
async function run() {
    stub(Date, 'now', () => now);
    stub(World, 'user', null); stub(Config, 'clanChatEnabled', true); stub(Config, 'partyMaxSize', 5);
    stub(Response, 'speak', (actor, data) => ({ ...data, id: actor.fetchId() }));
    stub(Clan, 'findById', id => ({ id, members: clanIds.map(id => ({ id })) }));
    stub(Life, 'statesByIds', async (ids, options) => {
        reads++; assert(options.excludeReserved);
        return rows.filter(row => ids.includes(row.characterId));
    });
    stub(Life, 'cachedState', id => rows.find(row => row.characterId === Number(id)) || null);
    stub(Life, 'statesForParty', async id => rows.filter(row => row.party?.partyId === id));
    stub(Parties, 'active', () => parties);
    // The leader read goes through the party index; here it filters the stubbed active().
    stub(Parties, 'activeByLeaders', leaders => {
        const ids = new Set([...leaders].map(Number));
        return parties.filter(party => ids.has(Number(party.leaderId)));
    });
    stub(Parties, 'find', id => parties.find(p => p.partyId === id));
    stub(Spots, 'findById', id => id ? { id, minLevel: id === 'danger' ? 40 : 15, maxLevel: 25 } : null);
    stub(Risk, 'backoffForStates', (members, spot) => members.some(m => m.stats.badSpot === spot));
    reset();
    clearPublishedSessions();
    assert(!Help.request(1, 11, now)); await Help.processOne(callbacks, now); assert.strictEqual(reads, 0);
    reset();
    for (let i = 0; i < 3; i++) Chat.onDeath(rows[0], `d${i}`, now);
    assert(Help.hasDue(), 'delivered solo plea creates actual help demand');
    assert.strictEqual(packets.length, 1);
    const mini = await Help.processOne(callbacks, now);
    assert.deepStrictEqual(mini.memberIds, [2, 1]); assert.strictEqual(creates, 1);
    assert.strictEqual(mini.stats.objective.reason, 'clan_help');
    assert.strictEqual(packets.length, 1, 'reply waits behind the plea');
    now += 15000; Chat.flush(now);
    assert.strictEqual(packets.length, 2); assert(packets[1].text.includes('Bot1'));
    assert(!Help.hasDue());

    reset();
    parties = [{ partyId: 'existing', status: 'active', leaderId: 2, memberIds: [2, 3], spotId: 'safe', stats: {} }];
    rows[1].party = rows[2].party = { partyId: 'existing' };
    Help.request(1, 11, now); const joined = await Help.processOne(callbacks, now);
    assert.deepStrictEqual(joined.memberIds, [2, 3, 1]); assert.strictEqual(commits, 1); assert.strictEqual(creates, 0);
    assert.strictEqual(packets.length, 1);

    reset();
    parties = [{ partyId: 'existing', status: 'active', leaderId: 2, memberIds: [2, 3], spotId: 'safe', stats: {} }];
    rows[1].party = rows[2].party = { partyId: 'existing' };
    Help.request(1, 11, now);
    await Help.processOne({ ...callbacks, commit: async () => ({ party: null, failed: [rows[0]] }) }, now);
    assert.strictEqual(packets.length, 0, 'recruitment conflict cannot announce success');

    reset(); Help.request(1, 11, now);
    await Help.processOne({ ...callbacks, create: async () => null }, now);
    assert.strictEqual(packets.length, 0, 'failed admission/commit stays silent');
    // Tried once; asked again only when its answer can change, never on a clock.
    assert(!Help.hasDue()); await Help.processOne(callbacks, now + Help.TTL_MS - 1); assert.strictEqual(reads, 1, 'no timed retry');
    assert(!Help.observe(2, rows[1], now), 'a member already free when tried wakes nothing');
    assert(!Help.observe(1, rows[0], now), 'the requester re-published unchanged wakes nothing');

    // A clanmate turning free answers the plea: one try per turn.
    reset(); rows[1].activity = rows[2].activity = 'shopping'; Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null); assert.strictEqual(reads, 1);
    assert(!Help.observe(2, { ...rows[1], level: 21 }, now), 'a busy member\'s other moves wake nothing');
    assert(!Help.observe(9, { ...bot(9), stats: { clanId: 12 } }, now), 'another clan\'s member wakes nothing');
    rows[1] = { ...rows[1], activity: 'hunting', stats: { clanId: 11 } };
    assert(Help.observe(2, rows[1], now), 'a clan member turning free makes the plea due');
    const answered = await Help.processOne(callbacks, now + 1000);
    assert.deepStrictEqual(answered.memberIds, [2, 1]); assert.strictEqual(reads, 2);
    // The requester busy when tried: its own readiness returning makes the plea due.
    reset(); rows[0].activity = 'shopping'; Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null);
    rows[0] = { ...rows[0], activity: 'hunting' };
    assert(Help.observe(1, rows[0], now), 'the requester ready again makes the plea due');
    assert(await Help.processOne(callbacks, now), 'and is answered');
    // A clanmate turning free while the requester is busy wakes nothing; the
    // requester turning ready then does.
    reset(); rows[0].activity = rows[1].activity = rows[2].activity = 'shopping'; Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null);
    rows[1] = { ...rows[1], activity: 'hunting' };
    assert(!Help.observe(2, rows[1], now), 'a member turning free while the requester is busy wakes nothing');
    rows[0] = { ...rows[0], activity: 'hunting' };
    assert(Help.observe(1, rows[0], now), 'the requester ready then makes it due');
    assert(await Help.processOne(callbacks, now), 'and the free member answers');
    // A member leaving the cache is no longer free: back in it free, it can answer again.
    reset(); Help.request(1, 11, now);
    await Help.processOne({ ...callbacks, create: async () => null }, now);
    assert(!Help.observe(2, null, now), 'leaving the cache wakes nothing');
    assert(Help.observe(2, rows[1], now), 'a member back in the cache and free makes the plea due');
    // A clan help party full when tried takes the requester when a member leaves it.
    reset(); rows.push(bot(4), bot(5), bot(6)); clanIds = [1, 2, 3, 4, 5, 6];
    parties = [{ partyId: 'existing', status: 'active', leaderId: 2, memberIds: [2, 3, 4, 5, 6], spotId: 'safe', stats: {} }];
    rows.slice(1).forEach(row => { row.party = { partyId: 'existing' }; row.activity = 'grouped'; });
    Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null, 'a full help party takes no one');
    rows[5] = { ...rows[5], party: null, activity: 'shopping' };
    parties = [{ ...parties[0], memberIds: [2, 3, 4, 5] }];
    assert(Help.observeParty(parties[0], now), 'a member leaving a help party makes the plea due');
    const roomy = await Help.processOne(callbacks, now);
    assert.deepStrictEqual(roomy.memberIds, [2, 3, 4, 5, 1], 'the requester joins the party with room');
    // Tries per plea are bounded and the drop is counted.
    reset(); Help.request(1, 11, now);
    const failing = { ...callbacks, create: async () => null };
    const dropped = () => Number(invoke('FailureLog').snapshot()?.['clan.help_tries'] || 0);
    const droppedBefore = dropped();
    for (let n = 0; n < Help.MAX_TRIES; n++) {
        await Help.processOne(failing, now); Help.observe(2, null, now); Help.observe(2, rows[1], now);
    }
    assert.strictEqual(reads, Help.MAX_TRIES); assert(!Help.hasDue(), 'a plea is tried at most MAX_TRIES times');
    assert.strictEqual(dropped(), droppedBefore + 1, 'the dropped plea is counted');

    reset();
    rows[0].stats.equipmentPlan = { status: 'active', requiresParty: true, partyNeed: 'required',
        partyNeedReason: 'underleveled' };
    rows[0].stats.partyRequest = { priority: 'required', reason: 'gear_acquisition' };
    Help.request(1, 11, now);
    assert(await Help.processOne(callbacks, now), 'a requester needing a party for a difficult personal goal can receive help');
    reset();
    rows[0].stats.partyRequest = { priority: 'required', clanGoalKey: 'reserved-clan-work' };
    Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null, 'clan assignments remain protected for requesters');

    reset(); rows[1].level = 60; rows[2].phase = 'hot'; Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null); assert.strictEqual(creates, 0);
    reset(); rows[1].stats.equipmentPlan = { requiresParty: true }; rows[2].activity = 'shopping'; Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null);
    reset(); rows.forEach(row => { row.spotId = 'danger'; }); Help.request(1, 11, now);
    assert.strictEqual(await Help.processOne(callbacks, now), null, 'level-inappropriate farm rejected');
    reset(); rows[0].stats.badSpot = 'safe'; Help.request(1, 11, now);
    assert(await Help.processOne(callbacks, now), 'a new party does not inherit a solo death-pressure ban');
    reset(); Help.request(1, 11, now); clanIds = [2, 3]; await Help.processOne(callbacks, now);
    assert.strictEqual(reads, 0); assert(!Help.hasDue());
    reset(); Help.request(1, 11, now); clearPublishedSessions(); await Help.processOne(callbacks, now);
    assert.strictEqual(reads, 0); assert(!Help.hasDue());
    reset(); Help.request(1, 11, now); await Help.processOne(callbacks, now + Help.TTL_MS);
    assert.strictEqual(reads, 0); assert(!Help.hasDue());

    reset(); for (let i = 0; i < 3; i++) Chat.onDeath(rows[0], `d${i}`, now);
    await Help.processOne(callbacks, now); parties[0].memberIds = [2];
    now += 15000; Chat.flush(now); assert.strictEqual(packets.length, 1, 'stale reply discarded after departure');

    reset();
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Database = invoke('Database');
    const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
    const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
    stub(Population, 'resolving', false); stub(Population, 'partyFormationRunning', false);
    stub(Config, 'enabled', true); stub(Config, 'backgroundPartyEnabled', true);
    stub(Database, 'pending', () => 1);
    stub(Coordinator, 'snapshot', () => ({ ready: true, snapshotsLoaded: true, queue: {} }));
    stub(Metrics, 'currentEventLoopLag', () => 0);
    Help.request(1, 11, now); await Population.helpClanParty(now);
    assert.strictEqual(reads, 0, 'player protection defers lookup while DB is busy');
    assert(Help.hasDue(), 'a busy main tried nothing: the plea stays due');
    Database.pending = () => 0;
    stub(Help, 'processOne', async () => {
        assert(Population.partyFormationRunning, 'membership lock held throughout help transaction');
        throw new Error('commit probe');
    });
    await assert.rejects(Population.helpClanParty(now), /commit probe/);
    assert.strictEqual(Population.partyFormationRunning, false, 'failed help releases scheduler lock');

    console.log('Clan party help: delivered plea, recruitment, mini-party, truthful replies, eligibility, safety and retries on members moves passed.');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    clearPublishedSessions();
    originals.reverse().forEach(restore => restore()); Help.reset(); Chat.reset();
});
