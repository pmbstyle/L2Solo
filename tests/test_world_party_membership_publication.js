'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'world-party-publication-'));
const paths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const previousEnv = { config: process.env.L2NODE_CONFIG_FILE, shared: process.env.L2NODE_SHARED_CONFIG_FILE };
process.env.L2NODE_CONFIG_FILE = path.join(gameRoot, 'config/default.ini');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require(path.join(gameRoot, 'src/Global'));
const previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
options.default.Database.path = paths.world;
options.default.Database.historyPath = paths.history;
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
const partyKeys = require(path.join(gameRoot, 'src/GameServer/World/PvpPartyMembershipKeys'));
const previousUser = World.user;
const observations = [];
let serial = 9700000;

function reset() { World.user = { sessions: [], revision: 0 }; }
function build({ id = ++serial, account = `player_group_${++serial}`, online = true, ...fields } = {}) {
    const session = { ...fields, accountId: account, fetchAccountId() { return this.accountId; },
        socket: { destroy() { session.destroyed = true; } }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    const actor = new Actor({ id, name: account, username: account, clanId: 0, isOnline: false,
        locX: 0, locY: 0, locZ: 0, head: 10, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
    session.actor = actor; actor.session = session;
    return { session, actor, online };
}
function insert(value) {
    World.insertUser(value.session);
    if (value.online) value.actor.setIsOnline(true);
    return value.session;
}
function member(fields) { return insert(build(fields)); }
function sessions(key) { return [...World.pvpPartySessionsForKey(key)]; }
function records(key) { return [...Runtime.index.groupSources(key)]; }
function entry(session) { return Runtime.index.records.get(session.actor.fetchId()).actor; }
function record(session) { return World.registeredActorById(session.actor.fetchId()); }
function observed(name, data = {}) { observations.push({ name, ...data }); console.log(`PASS ${name}`); }
function restoreEnv(key, value) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }

try {
    assert.equal(Database.isReady(), false);
    assert.equal(World.pvpPartyMembershipKeys, partyKeys, 'World exports the exact shared authored key helper');
    reset();
    const leader = member({ coldLifeState: { party: { partyId: 'alpha' } } });
    const older = member(), later = member({ partyCompanion: true, followPlayerSession: leader });
    assert.deepEqual(sessions(leader), [leader, later]);
    assert.deepEqual(sessions('party:alpha'), [leader]);
    const oldEntry = entry(older), oldRecord = record(older);
    older.partyCompanion = true; older.followPlayerSession = leader;
    World.refreshPartyMemberships([older]);
    assert.deepEqual(sessions(leader), [leader, older, later], 'late join retains original registration order');
    assert.equal(entry(older), oldEntry); assert.equal(record(older), oldRecord);
    const bucket = Runtime.index.groups.get(leader), metadata = oldEntry.groupMembership;
    World.refreshPartyMemberships(new Set([older, later]));
    assert.equal(Runtime.index.groups.get(leader), bucket); assert.equal(oldEntry.groupMembership, metadata);
    assert.equal(bucket.entries.values().next().value, entry(leader), 'group uses the same canonical actor entry');
    assert.deepEqual(records(leader), [record(leader), oldRecord, record(later)]);
    observed('healthy original refs, shared canonical entries and stable registration order');

    const pending = build({ online: false, coldLifeState: { party: { partyId: 'notice' } } });
    const notices = [], listenerErrors = [];
    let mode = 'attach';
    const unsubscribe = World.subscribeUserChanges(id => {
        if (id !== pending.actor.fetchId()) return;
        try {
            const current = record(pending.session);
            assert(current); assert(sessions('party:notice').includes(pending.session));
            assert(records('party:notice').includes(current));
            if (mode === 'terminal') assert.equal(current.retired, true);
            notices.push({ mode, record: current });
        } catch (error) { listenerErrors.push(error); }
    });
    try {
        insert(pending);
        assert(notices.some(notice => notice.mode === 'attach'));
        assert.deepEqual(listenerErrors, []);
        const before = record(pending.session), beforeEntry = entry(pending.session);
        const beforeBucket = Runtime.index.groups.get('party:notice'), beforeMetadata = beforeEntry.groupMembership;
        mode = 'terminal';
        assert.equal(World.retireUserActor(pending.session, pending.actor), true);
        const retired = record(pending.session);
        assert.notEqual(retired, before); assert.notEqual(retired.token, before.token);
        assert.equal(retired.actor, before.actor); assert.equal(retired.retired, true);
        assert.equal(entry(pending.session), beforeEntry); assert.equal(Runtime.index.groups.get('party:notice'), beforeBucket);
        assert.equal(beforeEntry.groupMembership, beforeMetadata);
        assert(!records('party:notice').includes(before));
        assert(notices.some(notice => notice.mode === 'terminal' && notice.record === retired));
        assert.deepEqual(listenerErrors, []);
        pending.actor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 });
        assert.equal(record(pending.session), retired, 'retired late movement cannot renew the current wrapper');
        assert.deepEqual(sessions('party:notice'), [pending.session], 'terminal raw source remains a group candidate');
        pending.session.coldLifeState.party.partyId = 'notice-retired';
        World.refreshPartyMemberships([pending.session]);
        assert.equal(record(pending.session), retired, 'explicit current-retired refresh does not re-register');
        assert.deepEqual(sessions('party:notice'), []); assert.deepEqual(sessions('party:notice-retired'), [pending.session]);
    } finally { unsubscribe(); }
    observed('groups published before attach/terminal notification; same-entry terminal wrapper renewal');

    reset();
    const truthyLeader = {}, loose = member({ partyCompanion: 1, followPlayerSession: truthyLeader,
        coldLifeState: { party: { partyId: 'ignored' } } });
    assert.deepEqual(partyKeys(loose), [loose]); assert.deepEqual(sessions(loose), [loose]);
    assert.deepEqual(sessions(truthyLeader), []); assert.deepEqual(sessions('party:ignored'), []);
    loose.partyCompanion = true; World.refreshPartyMemberships([loose]);
    assert.deepEqual(sessions(loose), []); assert.deepEqual(sessions(truthyLeader), [loose]);
    const opaque = [Symbol('leader'), 5n, 9, true, 'leader', {}, () => {}];
    for (const key of opaque) {
        const follower = member({ partyCompanion: true, followPlayerSession: key });
        assert.deepEqual(sessions(key), [follower]); assert.deepEqual(partyKeys(follower), [key]);
    }
    for (const key of [undefined, null, false, 0, NaN]) {
        const empty = member({ partyCompanion: true, followPlayerSession: key });
        assert.deepEqual(partyKeys(empty), []); assert.deepEqual(sessions(key), []);
    }
    const numeric = member({ coldLifeState: { party: { partyId: 7 } } });
    const string = member({ coldLifeState: { party: { partyId: '7' } } });
    assert.deepEqual(sessions('party:7'), [numeric, string]);
    const forming = member({ coldLifeState: { party: { partyId: 'forming' } } });
    assert.deepEqual(partyKeys(forming), [forming]); assert.deepEqual(sessions('party:forming'), []);
    assert.throws(() => partyKeys(null), TypeError); assert.throws(() => partyKeys(undefined), TypeError);
    observed('strict/truthy authored key policy and opaque native Map identities; no business seed rewrite');

    reset();
    const rawLeader = member(), offline = member({ online: false, partyCompanion: true, followPlayerSession: rawLeader });
    const dead = member({ partyCompanion: true, followPlayerSession: rawLeader });
    dead.actor.state.setDead(true); dead.actor.model.hp = 0;
    const malformed = member({ partyCompanion: true, followPlayerSession: rawLeader });
    malformed.actor.setLocXYZ({ locX: NaN, locY: 0, locZ: NaN });
    assert.equal(World.retireUserActor(offline, offline.actor), true);
    assert.deepEqual(sessions(rawLeader), [rawLeader, offline, dead, malformed]);
    assert(!World.realPlayerSessionsNear({ locX: 0, locY: 0, locZ: 0 }, 1).includes(offline));
    assert(!World.realPlayerSessionsNear({ locX: 0, locY: 0, locZ: 0 }, 1).includes(malformed));
    observed('raw group candidate domain keeps offline/dead/malformed XYZ/terminal sources');

    const id = rawLeader.actor.fetchId();
    const accepted = Life.acceptLifecycleRow({ characterId: id, phase: 'cold', activity: 'hunting', level: 10,
        hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1 });
    const stateRecord = Runtime.index.getSource(id, 'state'), stateBefore = structuredClone(accepted);
    assert.equal(stateRecord.source, accepted); assert.equal(Life.cachedState(id), accepted);
    const stateConserved = () => {
        assert.equal(Runtime.index.getSource(id, 'state'), stateRecord);
        assert.equal(Life.cachedState(id), accepted); assert.deepEqual(accepted, stateBefore);
    };
    rawLeader.coldLifeState = { party: { partyId: 'state-independent' } };
    World.refreshPartyMemberships([rawLeader]); stateConserved();
    World.retireUserActor(rawLeader, rawLeader.actor); stateConserved();
    World.removeUser(rawLeader); stateConserved(); reset(); stateConserved();
    observed('accepted Life state/cache stays independent across actor refresh, terminal, removal and reset');

    const first = member({ coldLifeState: { party: { partyId: 'old-a' } } });
    const second = member({ coldLifeState: { party: { partyId: 'old-b' } } });
    const firstEntry = entry(first), secondEntry = entry(second);
    const firstMetadata = firstEntry.groupMembership, secondMetadata = secondEntry.groupMembership;
    const firstBucket = Runtime.index.groups.get('party:old-a'), secondBucket = Runtime.index.groups.get('party:old-b');
    let conversions = 0;
    first.coldLifeState.party.partyId = { toString() { conversions += 1; return 'new-a'; } };
    const exactError = new Error('party-id-conversion-failed');
    second.coldLifeState.party.partyId = { toString() { throw exactError; } };
    assert.throws(() => World.refreshPartyMemberships([first, first, second]), error => error === exactError);
    assert.equal(conversions, 1, 'input session identity is deduplicated before derivation');
    assert.equal(firstEntry.groupMembership, firstMetadata); assert.equal(secondEntry.groupMembership, secondMetadata);
    assert.equal(Runtime.index.groups.get('party:old-a'), firstBucket); assert.equal(Runtime.index.groups.get('party:old-b'), secondBucket);
    assert.deepEqual(sessions('party:old-a'), [first]); assert.deepEqual(sessions('party:old-b'), [second]);
    assert.deepEqual(sessions('party:new-a'), []); assert.equal(typeof first.coldLifeState.party.partyId, 'object');
    second.coldLifeState.party.partyId = 'new-b';
    World.refreshPartyMemberships(new Set([first, second]));
    assert.deepEqual(sessions('party:new-a'), [first]); assert.deepEqual(sessions('party:new-b'), [second]);
    assert.equal(Runtime.index.groups.has('party:old-a'), false); assert.equal(Runtime.index.groups.has('party:old-b'), false);
    const kept = firstEntry.groupMembership;
    for (const invalid of [null, undefined, {}, 'sources', new Map(), (function* () { yield first; })()]) {
        assert.throws(() => World.refreshPartyMemberships(invalid), error => error instanceof TypeError
            && error.message === 'invalid_party_membership_sources');
        assert.equal(firstEntry.groupMembership, kept);
    }
    observed('explicit Array/Set dedup; derive error causes zero metadata effects, caller fields retain edits');

    const replaced = member({ coldLifeState: { party: { partyId: 'before-reentrant' } } });
    const staleRecord = record(replaced), staleActor = replaced.actor;
    let replacementActor, reentries = 0;
    replaced.coldLifeState.party.partyId = { toString() {
        reentries += 1;
        replaced.coldLifeState.party.partyId = 'current-reentrant';
        replacementActor = new Actor({ ...staleActor.model, isOnline: false });
        replacementActor.session = replaced; replaced.actor = replacementActor;
        World.updateUserLocation(replaced, replacementActor);
        return 'stale-reentrant';
    } };
    World.refreshPartyMemberships([replaced]);
    assert.equal(reentries, 1); assert.notEqual(record(replaced), staleRecord);
    assert.equal(record(replaced).actor, replacementActor);
    assert.deepEqual(sessions('party:before-reentrant'), []); assert.deepEqual(sessions('party:stale-reentrant'), []);
    assert.deepEqual(sessions('party:current-reentrant'), [replaced]);
    staleActor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 });
    assert.equal(record(replaced).actor, replacementActor);
    observed('controlled synchronous key derivation replacement cannot publish stale packet or resurrect old actor');

    reset();
    const old = member({ coldLifeState: { party: { partyId: 'displaced' } } });
    const newId = member({ id: old.actor.fetchId(), coldLifeState: { party: { partyId: 'current-id' } } });
    const currentIdRecord = record(newId);
    assert.deepEqual(sessions('party:displaced'), []); assert.deepEqual(sessions('party:current-id'), [newId]);
    old.coldLifeState.party.partyId = 'late-displaced'; World.refreshPartyMemberships([old]);
    old.actor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 }); World.removeUser(old);
    assert.equal(record(newId), currentIdRecord); assert.deepEqual(sessions('party:late-displaced'), []);
    const accountOld = member({ coldLifeState: { party: { partyId: 'old-account' } } });
    const accountNew = member({ account: accountOld.accountId, coldLifeState: { party: { partyId: 'new-account' } } });
    assert.equal(accountOld.destroyed, true); assert.deepEqual(sessions('party:old-account'), []);
    assert.deepEqual(sessions('party:new-account'), [accountNew]);
    const peer = member({ coldLifeState: { party: { partyId: 'new-account' } } });
    World.removeUser(accountNew); assert.deepEqual(sessions('party:new-account'), [peer]);
    accountNew.actor.setLocXYZ({ locX: 12000, locY: 0, locZ: 0 });
    World.refreshPartyMemberships([accountNew]); assert.deepEqual(sessions('party:new-account'), [peer]);
    World.insertUser(accountNew); assert.deepEqual(sessions('party:new-account'), [peer, accountNew]);
    const restoredRecord = record(accountNew);
    World.insertUser(accountNew); assert.equal(record(accountNew), restoredRecord);
    assert.deepEqual(sessions('party:new-account'), [peer, accountNew]);
    const oldUser = World.user, oldGroup = Runtime.index.groupSources('party:new-account');
    reset(); assert.deepEqual([...oldGroup], []); assert.equal(Runtime.index.groups.size, 0); stateConserved();
    accountNew.actor.setLocXYZ({ locX: 24000, locY: 0, locZ: 0 }); World.refreshPartyMemberships([accountNew]);
    assert.deepEqual(sessions('party:new-account'), []);
    World.user = oldUser; assert.deepEqual(sessions('party:new-account'), [], 'old session arrays do not bootstrap groups');
    World.user = null; assert.deepEqual(sessions('party:new-account'), []);
    observed('same-id/account displacement, removal/reinsert, idempotent insert and old-array/reset independence');

    for (const count of [32, 64]) {
        reset();
        const selected = member({ coldLifeState: { party: { partyId: `selected-${count}` } } });
        const selectedPeer = member({ partyCompanion: true, followPlayerSession: selected });
        const key = selected, expected = [selected, selectedPeer];
        assert.deepEqual(sessions(key), expected, 'genuine selected-group healthy positive precedes traps');
        const unrelated = Array.from({ length: count }, () => member({ coldLifeState: { party: { partyId: `other-${++serial}` } } }));
        assert.deepEqual(sessions(key), expected, 'healthy selected group remains current after unrelated registrations');
        const restores = []; let unrelatedReads = 0;
        const patch = (object, field, descriptor) => {
            const previous = Object.getOwnPropertyDescriptor(object, field);
            Object.defineProperty(object, field, { configurable: true, ...descriptor });
            restores.push(() => { if (previous) Object.defineProperty(object, field, previous); else delete object[field]; });
        };
        const forbidden = () => { throw new Error('group query enumerated unrelated population'); };
        for (const value of unrelated) {
            const actor = value.actor;
            for (const field of ['actor', 'partyCompanion', 'followPlayerSession', 'coldLifeState']) {
                const original = value[field];
                patch(value, field, { get() { unrelatedReads += 1; return original; } });
            }
            for (const field of ['fetchIsOnline', 'fetchLocX', 'fetchLocY', 'fetchLocZ']) {
                const original = actor[field];
                patch(actor, field, { value() { unrelatedReads += 1; return Reflect.apply(original, this, []); } });
            }
        }
        for (const map of [Runtime.index.records, Runtime.index.sourceViews.actor, Runtime.index.sourceViews.state,
            Runtime.index.cells, Runtime.index.spots]) {
            for (const method of ['values', 'entries', Symbol.iterator]) patch(map, method, { value: forbidden });
        }
        patch(World.user, 'sessions', { get: forbidden });
        patch(Array.prototype, 'sort', { value: forbidden });
        let actual, missing;
        try { actual = sessions(key); missing = sessions(Symbol('absent')); }
        finally { for (const restore of restores.reverse()) restore(); }
        assert.deepEqual(actual, expected); assert.deepEqual(missing, []); assert.equal(unrelatedReads, 0);
        observed(`selected query avoids global scan/sort and ${count} unrelated predicate/location reads`, { unrelatedReads });
    }
    assert.equal(Database.isReady(), false); assert.deepEqual(fs.readdirSync(directory), []);
    console.log('OBSERVATIONS ' + JSON.stringify(observations));
} finally {
    const cleanup = { databaseReady: Database.isReady(), generatedPaths: paths, filesCreated: fs.readdirSync(directory),
        workerCreated: false, worldInitialized: false, sqlExecuted: false };
    World.user = previousUser;
    options.default.Database.path = previousPaths.world; options.default.Database.historyPath = previousPaths.history;
    restoreEnv('L2NODE_CONFIG_FILE', previousEnv.config); restoreEnv('L2NODE_SHARED_CONFIG_FILE', previousEnv.shared);
    fs.rmSync(directory, { recursive: true, force: true });
    Object.assign(cleanup, { directoryRemoved: !fs.existsSync(directory), worldAndHistoryAbsent:
        !fs.existsSync(paths.world) && !fs.existsSync(paths.history), previousUserRestored: World.user === previousUser });
    const loadedSources = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep))
        .map(filename => ({ path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
    if (process.env.N62_PARTY_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.N62_PARTY_EVIDENCE_DIR, 'observations.json'),
        JSON.stringify({ observations, cleanup, loadedSources }, null, 2) + '\n');
    console.log('CLEANUP ' + JSON.stringify(cleanup));
}
