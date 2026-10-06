'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const gameRoot = process.env.N53_GAME_ROOT || path.resolve(__dirname, '..');
require(path.join(gameRoot, 'src/Global'));

const directory = fs.mkdtempSync(path.resolve(__dirname, '../tmp/bot-current-visibility-'));
const databasePaths = { world: path.join(directory, 'world.sqlite'), history: path.join(directory, 'history.sqlite') };
const previousPaths = { world: options.default.Database.path, history: options.default.Database.historyPath };
options.default.Database.path = databasePaths.world;
options.default.Database.historyPath = databasePaths.history;
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Model/Actor');
const BotAI = invoke('GameServer/Bot/BotAI');
const Shared = invoke('GameServer/Network/Shared');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Runtime = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationRuntime'));
const previousUser = World.user;
const originalNow = Date.now;
let clock = 1800000000000, serial = 9700000;
Date.now = () => clock;
const observations = [];
let cleanup;

function reset() { World.user = { sessions: [], revision: 0 }; }
function member({ id = ++serial, account = `player_visibility_${++serial}`, online = true,
    locX = 0, locY = 0, locZ = 0, missingXGetter = false, ...flags } = {}) {
    const session = { ...flags, accountId: account,
        fetchAccountId() { return this.accountId; }, socket: { destroy() { session.destroyed = true; } },
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    session.actor = new Actor({ id, name: String(account), username: account, clanId: 0, isOnline: false,
        locX, locY, locZ, hp: 100, maxHp: 100, mp: 100, maxMp: 100 });
    session.actor.session = session;
    if (missingXGetter) session.actor.fetchLocX = undefined;
    World.insertUser(session);
    session.actor.setIsOnline(online);
    return session;
}
function query(source, fresh = true) {
    if (fresh) clock += 251;
    return BotAI.visibleRealPlayers(source, source.actor, World);
}
function refs(actual, expected, label) {
    assert.equal(actual.length, expected.length, label);
    expected.forEach((session, i) => assert.equal(actual[i], session, `${label}: original ordered reference ${i}`));
}
function observed(name, details) { observations.push({ name, ...details }); console.log(`PASS ${name}`); }
function instrument(session) {
    const count = { online: 0, x: 0, y: 0, z: 0 };
    for (const [method, key] of [['fetchIsOnline', 'online'], ['fetchLocX', 'x'], ['fetchLocY', 'y'], ['fetchLocZ', 'z']]) {
        const original = session.actor[method];
        session.actor[method] = function () { count[key]++; return Reflect.apply(original, this, []); };
    }
    return count;
}

try {
    assert.equal(Database.isReady(), false);
    assert.equal(World.botRealPlayerIndex, true);
    assert.equal(typeof World.botVisibleRealPlayers, 'function');
    reset();
    const source = member();
    const farFirst = member({ locX: 400 }), nearSecond = member({ locX: 100 });
    const boundary = member({ locX: 6000 }), beyond = member({ locX: 6000.5 });
    refs(query(source), [farFirst, nearSecond, boundary], 'authored session order, self exclusion and inclusive6000');
    const nativeProvider = World.botVisibleRealPlayers;
    let nativeCalls = 0, nativeResult;
    World.botVisibleRealPlayers = function (givenSession, givenBot) {
        assert.equal(this, World);
        assert.equal(givenSession, source); assert.equal(givenBot, source.actor);
        nativeCalls++;
        nativeResult = Reflect.apply(nativeProvider, this, [givenSession, givenBot]);
        return nativeResult;
    };
    try {
        const result = query(source);
        assert.equal(result, nativeResult, 'selected native branch returns the exact provider array');
        assert.equal(nativeCalls, 1);
        refs(result, [farFirst, nearSecond, boundary], 'native receiver/arguments preserve ordered originals');
    } finally { World.botVisibleRealPlayers = nativeProvider; }
    assert.equal(World.registeredActorById(boundary.actor.fetchId()).actor, boundary.actor);
    assert(!query(source).includes(beyond));
    World.insertUser(farFirst);
    refs(query(source), [farFirst, nearSecond, boundary], 'idempotent registration preserves original arrival order');
    World.removeUser(farFirst); World.insertUser(farFirst);
    refs(query(source), [nearSecond, boundary, farFirst], 'explicit remove/reinsert appends the same original session');
    observed('registered originals/order/self/inclusive6000', { ids: [farFirst, nearSecond, boundary].map(s => s.actor.fetchId()) });

    reset();
    const classifierSource = member();
    const truthy = member({ online: 1 }), simulated = member({ simPlayer: true }), flaggedBot = member({ botSession: true });
    const numericAccount = member({ account: 12345 });
    const offline = member({ online: false }), missingOnline = member({ online: null });
    const botAccount = member({ account: `bot_visibility_${++serial}` }), emptyAccount = member({ account: '' });
    refs(query(classifierSource), [truthy, simulated, flaggedBot, numericAccount], 'exact BotAI human classifier');
    assert.equal(truthy.actor.fetchIsOnline(), 1);
    assert.equal(offline.actor.fetchIsOnline(), false);
    assert.equal(missingOnline.actor.fetchIsOnline(), null);
    assert.equal(botAccount.accountId.startsWith('bot_'), true);
    assert.equal(emptyAccount.accountId, '');
    observed('truthy online/account prefix independent of SimPlayer/botSession flags', { truthyOnline: 1, numericAccount: 12345 });

    reset();
    const xySource = member({ locX: '0', locY: null });
    const stringXY = member({ locX: '75', locY: '0', locZ: NaN });
    const nullXY = member({ locX: null, locY: null, locZ: undefined });
    const undefinedXY = member(), nanXY = member({ locX: NaN }), missingGetter = member({ missingXGetter: true });
    undefinedXY.actor.setLocXYZ({ locX: undefined, locY: 0, locZ: 0 });
    const dead = member({ locX: 100, locZ: NaN });
    dead.actor.state.setDead(true);
    refs(query(xySource), [stringXY, nullXY, dead], 'raw subtraction XY/noZ/dead inclusion');
    assert.equal(World.registeredActorById(undefinedXY.actor.fetchId()).actor, undefinedXY.actor);
    assert.equal(World.registeredActorById(nanXY.actor.fetchId()).actor, nanXY.actor);
    assert.equal(World.registeredActorById(missingGetter.actor.fetchId()).actor, missingGetter.actor);
    assert.equal(Runtime.index.getSource(stringXY.actor.fetchId(), 'actor').actor, stringXY.actor);
    assert(Runtime.index.nearSources({ locX: 0, locY: 0, locZ: 0 }, 6000, { view: 'actor' })
        .some(record => record.actor === stringXY.actor), 'actual common projected XY already admits badZ');
    assert(!World.realPlayerSessionsNear({ locX: 0, locY: 0, locZ: 0 }, 6000).includes(stringXY),
        'first reader still requires actual finite XYZ');
    observed('string/null vs undefined/NaN XY; badZ and dead positives', { undefinedAndNaNRemainRaw: true, firstReaderBadZExcluded: true });

    reset();
    const booleanSource = member({ locX: false, locY: true });
    const booleanXY = member({ locX: true, locY: false, locZ: NaN });
    const emptyStringXY = member({ locX: '', locY: '  ', locZ: undefined });
    const booleanBoundary = member({ locX: 6000, locY: true });
    refs(query(booleanSource), [booleanXY, emptyStringXY, booleanBoundary], 'boolean and empty-string numeric projection matches subtraction');
    booleanSource.actor.setLocXYZ({ locX: undefined, locY: true, locZ: 0 });
    refs(query(booleanSource), [], 'undefined native origin is unusable rather than nullish zero');
    booleanSource.actor.setLocXYZ({ locX: false, locY: true, locZ: 0 });
    refs(query(booleanSource), [booleanXY, emptyStringXY, booleanBoundary], 'valid native origin recovers');
    observed('boolean/empty strings and undefined origin recovery preserve native scalar domain');

    reset();
    const terminalSource = member(), terminal = member({ locX: 100 });
    const beforeRetire = World.registeredActorById(terminal.actor.fetchId());
    Shared.enterCharacterHall(terminal, []);
    const retired = World.registeredActorById(terminal.actor.fetchId());
    assert.notEqual(retired, beforeRetire);
    assert.notEqual(retired.token, beforeRetire.token);
    assert.equal(retired.retired, true);
    assert.equal(retired.actor, terminal.actor);
    refs(query(terminalSource), [terminal], 'current terminal raw actor remains a BotAI human');
    terminal.actor.setLocXYZ({ locX: 12500, locY: 0, locZ: 0 });
    refs(query(terminalSource), [], 'late terminal XYZ crosses cell and reads original live point');
    assert.equal(World.registeredActorById(retired.id), retired);
    terminal.actor.setLocXYZH({ locX: 5500, locY: 0, locZ: NaN, head: 321 });
    refs(query(terminalSource), [terminal], 'late terminal XYZH returns without generic/token revival');
    assert.equal(World.registeredActorById(retired.id), retired);
    assert.equal(retired.retired, true);
    assert.equal(terminal.actor.fetchHead(), 321);
    assert(!Runtime.index.nearSources({ locX: 0, locY: 0, locZ: 0 }, 6000, { view: 'actor' }).includes(retired));
    assert(!World.realPlayerSessionsNear({ locX: 0, locY: 0, locZ: 0 }, 6000).includes(terminal));
    observed('actual hall + terminal XYZ/XYZH live XY, stable retired token, no generic revival', { retiredTokenStableAfterMoves: true });

    const accepted = Life.acceptLifecycleRow({ characterId: retired.id, phase: 'cold', activity: 'hunting', level: 10,
        hp: 37, mp: 31, locX: 72000, locY: 0, locZ: 0, updatedAt: 1 });
    const stateRecord = Runtime.index.getSource(retired.id, 'state'), stateBefore = structuredClone(accepted);
    assert.equal(stateRecord.source, accepted); assert.equal(Life.cachedState(retired.id), accepted);
    terminal.actor.setLocX(12500);
    refs(query(terminalSource), [], 'terminal individual X refreshes raw XY without registration revival');
    terminal.actor.setLocXYZ({ locX: 6000, locY: 0, locZ: NaN });
    refs(query(terminalSource), [terminal], 'terminal valid XY/badZ returns on inclusive boundary');
    assert.equal(World.registeredActorById(retired.id), retired);
    assert.equal(retired.retired, true);
    assert.equal(Runtime.index.getSource(retired.id, 'state'), stateRecord);
    assert.equal(Life.cachedState(retired.id), accepted); assert.deepEqual(accepted, stateBefore);
    reset();
    terminal.actor.setLocXYZ({ locX: 100, locY: 0, locZ: 0 });
    assert.equal(World.registeredActorById(retired.id), null, 'late terminal setter cannot republish after reset');
    assert.equal(Runtime.index.getSource(retired.id, 'state'), stateRecord);
    assert.equal(Life.cachedState(retired.id), accepted); assert.deepEqual(accepted, stateBefore);
    observed('actual accepted state survives independent terminal XY and actor reset');

    const unsupportedSource = member(), unsupported = member({ locX: 100 });
    Shared.enterCharacterHall(unsupported, []);
    const unsupportedRecord = World.registeredActorById(unsupported.actor.fetchId());
    let coercions = 0;
    const objectXY = { valueOf() { coercions++; throw new Error('unexpected_raw_xy_coercion'); } };
    for (const value of [undefined, NaN, 'not_a_number', Infinity, 100n, Symbol('raw_xy'), objectXY]) {
        unsupported.actor.setLocXYZ({ locX: value, locY: 0, locZ: NaN });
        assert(Object.is(unsupported.actor.fetchLocX(), value), 'unsupported raw scalar remains original');
        assert.equal(World.registeredActorById(unsupportedRecord.id), unsupportedRecord);
        assert.equal(unsupportedRecord.retired, true);
        refs(query(unsupportedSource), [], 'unusable or unsupported terminal XY disables only native membership');
    }
    assert.equal(coercions, 0, 'native raw XY does not add object conversion');
    unsupported.actor.setLocXYZ({ locX: '100', locY: null, locZ: NaN });
    refs(query(unsupportedSource), [unsupported], 'supported terminal scalar recovers with same raw token');
    assert.equal(World.registeredActorById(unsupportedRecord.id), unsupportedRecord);
    observed('native unsupported scalar disable/no coercion and terminal recovery; no all-JS parity claim');

    reset();
    const replacementSource = member(), old = member({ account: 'player_visibility_replace', locX: 100 });
    const oldRecord = World.registeredActorById(old.actor.fetchId());
    const replacement = member({ id: old.actor.fetchId(), account: old.accountId, locX: 200 });
    const currentRecord = World.registeredActorById(oldRecord.id);
    assert.equal(old.destroyed, true);
    assert.notEqual(currentRecord.token, oldRecord.token);
    old.actor.setLocXYZ({ locX: 50, locY: 0, locZ: 0 });
    old.actor.setLocXYZH({ locX: 60, locY: 0, locZ: 0, head: 12 });
    assert.equal(World.retireUserActor(old, old.actor), false);
    assert.equal(World.registeredActorById(currentRecord.id), currentRecord);
    refs(query(replacementSource), [replacement], 'actual same-account replacement excludes late old source');
    World.removeUser(replacement);
    replacement.actor.setLocXYZ({ locX: 70, locY: 0, locZ: 0 });
    assert.equal(World.registeredActorById(currentRecord.id), null);
    refs(query(replacementSource), [], 'removed source cannot re-register through delayed movement');
    observed('actual replacement/removal/late setters retain current source authority', { replacementTokenStable: true, removedRawAbsent: true });

    reset();
    const cacheSource = member(), cached = member({ locX: 100 });
    refs(query(cacheSource), [cached], 'positive before changing cached online membership');
    cached.actor.setIsOnline(false);
    refs(query(cacheSource, false), [], 'native fresh membership immediately excludes newly offline session');
    refs(query(cacheSource), [], 'expiry rebuild observes offline membership');
    cached.actor.setIsOnline(true);
    refs(query(cacheSource, false), [cached], 'native fresh membership immediately sees online recovery');
    cached.accountId = 'bot_visibility_changed';
    refs(query(cacheSource, false), [], 'fresh classifier sees account prefix without another producer event');
    observed('selected native reader retires250ms membership staleness', { cachedOfflineVisible: false, expiredOfflineVisible: false });

    reset();
    const ghostSource = member(), displaced = member({ locX: 100 });
    const newest = member({ id: displaced.actor.fetchId(), account: 'player_visibility_displaced', locX: 200 });
    assert.equal(World.registeredActorById(newest.actor.fetchId()).session, newest);
    displaced.actor.setLocXYZ({ locX: 150, locY: 0, locZ: 0 });
    assert.equal(World.registeredActorById(newest.actor.fetchId()).session, newest);
    refs(query(ghostSource), [newest], 'native current authority omits displaced ID source');
    const oldUser = World.user;
    reset();
    newest.actor.setLocXYZ({ locX: 180, locY: 0, locZ: 0 });
    assert.equal(World.registeredActorById(newest.actor.fetchId()), null);
    refs(query(ghostSource), [], 'fresh empty reset list');
    World.user = oldUser;
    assert.equal(World.registeredActorById(newest.actor.fetchId()), null);
    refs(query(ghostSource), [], 'reused old array cannot resurrect absent current raw binding');
    observed('native current authority retires reset/displaced array ghosts', { reusedOldArrayHasNoRawSources: true });

    for (const size of [32, 64]) {
        reset();
        const costSource = member(), local = member({ locX: 100 });
        const unrelated = Array.from({ length: size }, (_, i) => member({
            account: `${i % 2 ? 'bot_' : 'player_'}visibility_unrelated_${++serial}`,
            locX: 24000 + i, locY: 24000 }));
        const records = unrelated.map(session => World.registeredActorById(session.actor.fetchId()));
        const models = unrelated.map(session => structuredClone(session.actor.model));
        const revision = World.user.revision;
        const counts = unrelated.map(instrument);
        refs(query(costSource), [local], `expired-cache cost${size}: healthy local original`);
        const sums = Object.fromEntries(['online', 'x', 'y', 'z'].map(key => [key, counts.reduce((sum, count) => sum + count[key], 0)]));
        assert.equal(World.user.revision, revision);
        unrelated.forEach((session, i) => {
            assert.deepEqual(session.actor.model, models[i], 'query conserves original actor facts');
            assert.equal(World.registeredActorById(records[i].id), records[i], 'query conserves exact registered record/token');
        });
        observations.push({ name: `cost${size}`, size, sums, populationReads: sums.online + sums.x + sums.y + sums.z,
            localOriginalPreserved: true, modelsAndTokensConserved: true });
        console.log(`OBS cost${size} ${JSON.stringify(sums)}`);
        assert.equal(sums.online + sums.x + sums.y + sums.z, 0, `cost${size} no unrelated population getter reads`);
    }
    const costs = observations.filter(row => row.name.startsWith('cost'));
    assert.equal(costs[0].populationReads, 0); assert.equal(costs[1].populationReads, 0);

    reset();
    const trapSource = member(), trapLocal = member({ locX: 100 });
    refs(query(trapSource), [trapLocal], 'registered healthy original before enumeration trap');
    const sessions = World.user.sessions;
    let enumerationAttempts = 0;
    World.user.sessions = new Proxy(sessions, { get(targetArray, key, receiver) {
        if (['filter', 'find', 'forEach', 'map', 'reduce', 'values', 'entries'].includes(key) || key === Symbol.iterator) {
            enumerationAttempts++;
            throw new Error(`unexpected_population_enumeration:${String(key)}`);
        }
        return Reflect.get(targetArray, key, receiver);
    } });
    try { refs(query(trapSource), [trapLocal], 'native query does not enumerate sessions after legitimate registration'); }
    finally { World.user.sessions = sessions; }
    assert.equal(enumerationAttempts, 0);
    observations.push({ name: 'enumerationTrap', enumerationAttempts, originalArrayRestored: World.user.sessions === sessions });

    const missingBridge = { botRealPlayerIndex: true, user: { sessions: [] },
        fetchVisibleRealPlayers() { throw new Error('unexpected_missing_bridge_fallback'); } };
    assert.throws(() => BotAI.visibleRealPlayers(trapSource, trapSource.actor, missingBridge),
        error => error instanceof TypeError && error.message === 'invalid_bot_real_player_index');
    refs(BotAI.visibleRealPlayers(null, trapSource.actor, missingBridge), [], 'original null-session guard precedes native capability');
    refs(BotAI.visibleRealPlayers(trapSource, null, missingBridge), [], 'original null-bot guard precedes native capability');
    const bridgeError = new Error('native_bridge_failure');
    assert.throws(() => BotAI.visibleRealPlayers(trapSource, trapSource.actor, { botRealPlayerIndex: true,
        botVisibleRealPlayers() { throw bridgeError; } }), error => error === bridgeError);

    const fallbackTruthy = member({ online: 1 }), fallbackBot = member({ account: 'bot_visibility_fallback' });
    const fallbackOffline = member({ online: false });
    const fallbackInput = { fetchLocX() { return 0; } };
    let fallbackCalls = 0;
    const fallbackWorld = { botRealPlayerIndex: true, user: { sessions: [] },
        botVisibleRealPlayers() { throw new Error('unexpected_missing_bot_xy_native_call'); },
        fetchVisibleRealPlayers(givenSession, givenBot) {
            assert.equal(this, fallbackWorld); assert.equal(givenSession, trapSource); assert.equal(givenBot, fallbackInput);
            fallbackCalls++;
            return [fallbackTruthy, fallbackBot, fallbackOffline];
        } };
    refs(BotAI.visibleRealPlayers(trapSource, fallbackInput, fallbackWorld), [fallbackTruthy], 'missing bot XY retains bound adapter and exact classifier');
    assert.equal(fallbackCalls, 1);
    fallbackWorld.fetchVisibleUsers = fallbackWorld.fetchVisibleRealPlayers;
    delete fallbackWorld.fetchVisibleRealPlayers;
    refs(BotAI.visibleRealPlayers(trapSource, fallbackInput, fallbackWorld), [fallbackTruthy], 'missing bot XY retains visible-users fallback');
    assert.equal(fallbackCalls, 2);

    const legacyWorld = { user: { sessions: [trapSource, fallbackTruthy, fallbackBot], revision: 0 },
        botVisibleRealPlayers() { throw new Error('unexpected_unmarked_native_call'); } };
    refs(BotAI.visibleRealPlayers(trapSource, trapSource.actor, legacyWorld), [fallbackTruthy], 'absent marker preserves explicit VM/cache channel');
    fallbackTruthy.actor.setIsOnline(false);
    refs(BotAI.visibleRealPlayers(trapSource, trapSource.actor, legacyWorld), [fallbackTruthy], 'absent marker preserves inherited250ms cached membership');
    clock += 251;
    refs(BotAI.visibleRealPlayers(trapSource, trapSource.actor, legacyWorld), [], 'legacy cache expiry retains original classifier');
    fallbackTruthy.actor.setIsOnline(1);
    legacyWorld.botRealPlayerIndex = false; legacyWorld.user.revision++;
    refs(BotAI.visibleRealPlayers(trapSource, trapSource.actor, legacyWorld), [fallbackTruthy], 'false marker does not select native capability');
    observed('native required bridge and missing-bot adapter; unmarked explicit legacy cache preserved');
    assert.equal(Database.isReady(), false);
    assert.equal(fs.readdirSync(directory).length, 0, 'uninitialized generated world/history paths create no files');
    console.log('OBSERVATIONS ' + JSON.stringify(observations));
} finally {
    Date.now = originalNow;
    const databaseReady = Database.isReady();
    const filesCreated = fs.readdirSync(directory);
    World.user = previousUser;
    options.default.Database.path = previousPaths.world;
    options.default.Database.historyPath = previousPaths.history;
    fs.rmSync(directory, { recursive: true, force: true });
    cleanup = { databaseReady, filesCreated, generatedPaths: databasePaths, directoryRemoved: !fs.existsSync(directory),
        previousWorldRestored: World.user === previousUser, clockRestored: Date.now === originalNow,
        worldAndHistoryAbsent: !fs.existsSync(databasePaths.world) && !fs.existsSync(databasePaths.history), workerCreated: false };
    const loaded = Object.keys(require.cache).filter(filename => filename.startsWith(path.join(gameRoot, 'src') + path.sep))
        .map(filename => ({ path: filename, sha256: crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex') }));
    if (process.env.N62_VISIBILITY_EVIDENCE_DIR) {
        fs.writeFileSync(path.join(process.env.N62_VISIBILITY_EVIDENCE_DIR, 'observations.json'),
            JSON.stringify({ observations, targetFailures: [], cleanup, loadedSources: loaded }, null, 2) + '\n');
    }
    console.log('CLEANUP ' + JSON.stringify(cleanup));
}
