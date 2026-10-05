const assert = require('assert');
const path = require('path');

const gameRoot = path.resolve(process.env.N62_GAME_ROOT || path.join(__dirname, '..'));
require(path.join(gameRoot, 'src/Global'));
const World = invoke('GameServer/World/World');
const ActorModel = invoke('GameServer/Model/Actor');
const Actor = invoke('GameServer/Actor/Actor');
const Session = invoke('GameServer/Session');
const Shared = invoke('GameServer/Network/Shared');
const Revive = invoke('GameServer/Actor/Generics/Revive');
const DeathExperience = invoke('GameServer/Progression/DeathExperience');
const Restart = invoke('GameServer/Network/Request/Restart');
const Logout = invoke('GameServer/Network/Request/Logout');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Floor = invoke('GameServer/Bot/Population/FloorAwareActivationPolicy');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

// Real World lifecycle, ActorModel hooks and cold visibility reader. Geometry
// alone is controlled below; no World.init, geodata loading, DB or listeners.
const registered = new Set();
let sequence = 8000000;
const origin = { locX: 5999, locY: 5999, locZ: -3400 };
const coordinator = new ColdSimulationCoordinator({ population: Population });
coordinator.population = Population;
const cold = loc => ({ characterId: 9000000, phase: 'cold', activity: 'hunting', stats: {}, loc });
const visible = loc => coordinator.visibleToRealPlayer(cold(loc));

function sessionAt(loc, { account = `player_n62_${++sequence}`, id = ++sequence, online = true } = {}) {
    const session = { accountId: account, fetchAccountId() { return this.accountId; },
        socket: { destroy() { session.destroyed = true; } }, dataSendToMe() {}, dataSendToMeAndOthers() {} };
    session.actor = new ActorModel({ id, name: account, username: account, isOnline: false, clanId: 0, ...loc });
    session.actor.session = session;
    World.insertUser(session);
    if (online) session.actor.setIsOnline(true);
    registered.add(session);
    return session;
}

function clearSessions() {
    for (const session of registered) World.removeUser(session);
    registered.clear();
    Floor.resetCache();
}

function ids(rows) { return rows.map(row => row.actor.fetchId()).sort((a, b) => a - b); }
function expectNear(loc, radius, sessions) {
    assert.deepStrictEqual(ids(World.realPlayerSessionsNear(loc, radius)), ids(sessions));
}

function instrument(session) {
    const counts = { predicate: 0, location: 0 };
    let actor = session.actor;
    Object.defineProperty(session, 'actor', { configurable: true,
        get() { counts.predicate += 1; return actor; }, set(value) { actor = value; } });
    const online = actor.fetchIsOnline;
    actor.fetchIsOnline = function () { counts.predicate += 1; return online.call(this); };
    for (const key of ['fetchLocX', 'fetchLocY', 'fetchLocZ']) {
        const original = actor[key];
        actor[key] = function () { counts.location += 1; return original.call(this); };
    }
    return counts;
}

function withoutSessionScan(work) {
    const sessions = World.user.sessions;
    World.user.sessions = new Proxy(sessions, { get(target, key) {
        if (key === Symbol.iterator || ['filter', 'find', 'some', 'map', 'forEach', 'values', 'entries'].includes(key)) {
            throw new Error('indexed visibility must not enumerate all World sessions');
        }
        return Reflect.get(target, key);
    } });
    try { return work(); } finally { World.user.sessions = sessions; }
}

function deathCleanupFor(actor) {
    actor.attack = { destructor() {} };
    actor.automation = { destructor() {}, replenishVitals() {} };
    actor.destructor = () => Actor.prototype.destructor.call(actor);
}

async function terminalRequest(request) {
    const player = sessionAt(origin);
    deathCleanupFor(player.actor);
    player.persistCharacterStatus = () => Promise.reject(new Error('fixture_persist_failed'));
    await assert.rejects(request(player), /fixture_persist_failed/);
    expectNear(origin, 0, [player]);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    player.persistCharacterStatus = () => gate;
    const fetchCharacters = Shared.fetchCharacters;
    Shared.fetchCharacters = () => Promise.resolve([]);
    const pending = request(player);
    try {
        expectNear(origin, 0, [player]);
        release();
        await pending;
        expectNear(origin, 9000, []);
        player.actor.setLocXYZ(origin);
        player.actor.setIsOnline(true);
        expectNear(origin, 9000, []);
    } finally { release(); Shared.fetchCharacters = fetchCharacters; }
}

const originalConfig = { activationRadius: Config.activationRadius, activationFloorDirectZ: Config.activationFloorDirectZ };
const originalGeo = { hasGeo: Geodata.hasGeo, hasLineOfSight: Geodata.hasLineOfSight };

async function run() {
    World.user = { sessions: [], revision: 0 };
    assert.strictEqual(invoke('Database').isReady(), false, 'native index fixture never opens a database');
    Config.activationRadius = 9000;
    Config.activationFloorDirectZ = 1200;
    Geodata.hasGeo = () => true;
    Geodata.hasLineOfSight = () => false;

    const unrelated = [];
    for (let i = 0; i < 20; i++) {
        unrelated.push(instrument(sessionAt(origin, { account: `bot_n62_unrelated_${i}` })));
        unrelated.push(instrument(sessionAt({ ...origin, locX: origin.locX + 100000 + i * 6000 })));
    }
    sessionAt({ ...origin, locX: origin.locX + 100 });
    unrelated.forEach(count => { count.predicate = 0; count.location = 0; });
    assert.strictEqual(visible(origin), true, 'native same-floor visible player is the positive control');
    const total = unrelated.reduce((sum, count) => ({ predicate: sum.predicate + count.predicate,
        location: sum.location + count.location }), { predicate: 0, location: 0 });
    console.log(`same-floor control=true; 20 unrelated bots + 20 distant players reads=${JSON.stringify(total)}`);
    assert.deepStrictEqual(total, { predicate: 0, location: 0 },
        'a local query touches neither predicates nor locations of unrelated bots/distant players');
    assert.strictEqual(typeof World.realPlayerSessionsNear, 'function', 'native indexed query is available');
    assert.strictEqual(typeof Population.realPlayerSessionsNear, 'function', 'population delegates the nearby interface');
    withoutSessionScan(() => {
        assert.strictEqual(visible(origin), true);
        assert.strictEqual(visible({ ...origin, locX: -100000 }), false);
        assert.strictEqual(Population.realPlayerSessionsNear(origin, 200).length, 1);
    });
    console.log('indexed local cost and legacy-iterator exclusion: pass');
    clearSessions();

    const player = sessionAt(origin);
    expectNear(origin, 0, [player]);
    assert.strictEqual(visible(origin), true);
    player.actor.setLocXYZ({ ...origin, locX: origin.locX - 1000 });
    expectNear(origin, 500, []);
    player.actor.setLocXYZH({ ...origin, head: 2345 });
    assert.strictEqual(player.actor.fetchHead(), 2345);
    expectNear(origin, 0, [player]);
    const remote = { locX: -20000, locY: 40000, locZ: -3400 };
    player.actor.setLocXYZH({ ...remote, head: 4321 });
    expectNear(origin, 9000, []);
    expectNear(remote, 0, [player]);
    player.actor.setLocXYZ({ ...remote, locZ: remote.locZ + 1200 });
    assert.strictEqual(visible(remote), true, 'inclusive direct floor height remains accepted');
    player.actor.setLocXYZ({ ...remote, locZ: remote.locZ + 3000 });
    expectNear(remote, 0, [player]);
    assert.strictEqual(visible(remote), false, 'Z-only setter uses fresh height in native blocked-floor policy');
    Geodata.hasLineOfSight = () => true;
    Floor.resetCache();
    assert.strictEqual(visible(remote), true, 'native visible-slope exception remains accepted');
    Geodata.hasGeo = () => false;
    Floor.resetCache();
    assert.strictEqual(visible(remote), true, 'missing-geodata fallback remains permissive');
    Geodata.hasGeo = () => true;
    Geodata.hasLineOfSight = () => false;
    Floor.resetCache();
    player.actor.setIsOnline(false);
    expectNear(remote, 9000, []);
    player.actor.setIsOnline(true);
    expectNear(remote, 0, [player]);
    assert.doesNotThrow(() => player.actor.setLocXYZ({ ...remote, locX: NaN }));
    expectNear(remote, 9000, []);
    player.actor.setLocXYZ(remote);
    expectNear(remote, 0, [player]);
    World.removeUser(player);
    player.actor.setLocXYZ(origin);
    player.actor.setIsOnline(true);
    expectNear(origin, 9000, []);
    World.insertUser(player);
    expectNear(origin, 0, [player]);
    World.insertUser(player);
    expectNear(origin, 0, [player]);
    assert.strictEqual(World.user.sessions.length, 1, 'idempotent explicit insert retains one current source');
    assert.strictEqual(player.destroyed, undefined, 'idempotent registration keeps the current socket');
    console.log('native within-cell, cross-cell, teleport, Z and online/location eligibility: pass');
    clearSessions();

    const edge = sessionAt({ ...origin, locX: origin.locX + 9000 });
    expectNear(origin, 9000, [edge]);
    assert.strictEqual(visible(origin), true, '9000 radius reaches beyond an adjacent 6000 cell');
    edge.actor.setLocXYZ({ ...origin, locX: origin.locX + 9001 });
    expectNear(origin, 9000, []);
    assert.strictEqual(visible(origin), false, 'exact inclusive radius excludes one extra unit');
    const negative = { locX: -6001, locY: -6001, locZ: -3400 };
    edge.actor.setLocXYZ({ ...negative, locX: negative.locX - 9000 });
    expectNear(negative, 9000, [edge]);
    assert.strictEqual(visible(negative), true, 'negative cell boundary retains the full configured radius');
    edge.actor.setLocXYZ({ ...negative, locX: negative.locX + 9000, locY: negative.locY + 9000 });
    expectNear(negative, 9000, []);
    for (const radius of [NaN, Infinity, -1]) assert.throws(() => World.realPlayerSessionsNear(origin, radius), RangeError);
    for (const loc of [{ ...origin, locX: Infinity }, { ...origin, locY: NaN }, { ...origin, locZ: undefined }]) {
        assert.throws(() => World.realPlayerSessionsNear(loc, 9000), RangeError);
    }
    console.log('finite inputs, exact radius, negative cells and XY circle: pass');
    clearSessions();

    const old = sessionAt(origin, { account: 'player_n62_replace' });
    const replacement = sessionAt(remote, { account: old.accountId });
    assert.strictEqual(old.destroyed, true, 'actual World replacement retires the old socket');
    expectNear(origin, 9000, []);
    expectNear(remote, 0, [replacement]);
    old.actor.setLocXYZ(remote);
    old.actor.setIsOnline(true);
    World.removeUser(old);
    expectNear(remote, 0, [replacement]);
    const sameCharacter = sessionAt(origin, { id: replacement.actor.fetchId() });
    expectNear(remote, 9000, []);
    expectNear(origin, 0, [sameCharacter]);
    World.removeUser(replacement);
    replacement.actor.setLocXYZ(origin);
    expectNear(origin, 0, [sameCharacter]);
    const prepared = new ActorModel({ id: ++sequence, isOnline: false, ...origin });
    prepared.setLocXYZ(remote);
    prepared.setIsOnline(true);
    expectNear(remote, 9000, []);
    console.log('account/character replacement, late removal and unregistered actor: pass');
    clearSessions();

    const connecting = { accountId: 'player_n62_connecting', actor: null,
        fetchAccountId() { return this.accountId; }, dataSendToMe() {} };
    World.insertUser(connecting);
    registered.add(connecting);
    expectNear(origin, 9000, []);
    connecting.actor = new ActorModel({ id: ++sequence, isOnline: false, clanId: 0, ...origin });
    connecting.actor.session = connecting;
    connecting.actor.setIsOnline(true);
    expectNear(origin, 0, [connecting]);
    console.log('registered connection receives its actor through the online hook: pass');
    clearSessions();

    const neverOnline = sessionAt(origin, { online: false });
    const neverOnlineActor = neverOnline.actor;
    expectNear(origin, 9000, []);
    Shared.enterCharacterHall(neverOnline, []);
    neverOnlineActor.setLocXYZ(origin);
    neverOnlineActor.setIsOnline(true);
    expectNear(origin, 9000, []);
    Session.prototype.setActor.call(neverOnline, { id: ++sequence, name: 'N62FirstSelection', username: neverOnline.accountId,
        isOnline: false, clanId: 0, ...origin, items: [], paperdoll: utils.tupleAlloc(16, {}) });
    neverOnline.actor.setIsOnline(true);
    expectNear(origin, 0, [neverOnline]);
    World.retireUserActor(neverOnline, neverOnlineActor);
    expectNear(origin, 0, [neverOnline]);
    console.log('terminal hall retires a registered actor that was never online: pass');
    clearSessions();

    const selecting = sessionAt(origin);
    const previous = selecting.actor;
    deathCleanupFor(previous);
    previous.destructor();
    expectNear(origin, 0, [selecting]);
    previous.state.setDead(true);
    const clearRestoration = DeathExperience.clearPendingRestoration;
    DeathExperience.clearPendingRestoration = () => Promise.resolve();
    try { Revive(selecting, previous, { delayMs: 0 }); }
    finally { DeathExperience.clearPendingRestoration = clearRestoration; }
    assert.strictEqual(previous.state.fetchDead(), false);
    expectNear(origin, 0, [selecting]);
    Shared.enterCharacterHall(selecting, []);
    expectNear(origin, 9000, []);
    previous.setLocXYZ(origin);
    previous.setIsOnline(true);
    expectNear(origin, 9000, []);
    Session.prototype.setActor.call(selecting, { id: ++sequence, name: 'N62Selected', username: selecting.accountId,
        isOnline: false, clanId: 0, ...remote, items: [], paperdoll: utils.tupleAlloc(16, {}) });
    selecting.actor.setIsOnline(true);
    expectNear(remote, 0, [selecting]);
    World.retireUserActor(selecting, previous);
    expectNear(remote, 0, [selecting]);
    const nextPrevious = selecting.actor;
    Session.prototype.setActor.call(selecting, { id: ++sequence, name: 'N62SelectedAgain', username: selecting.accountId,
        isOnline: false, clanId: 0, ...origin, items: [], paperdoll: utils.tupleAlloc(16, {}) });
    nextPrevious.setLocXYZ(origin);
    nextPrevious.setIsOnline(true);
    expectNear(origin, 9000, []);
    selecting.actor.setIsOnline(true);
    expectNear(origin, 0, [selecting]);
    console.log('death cleanup/native revive, terminal hall/selection and late old actor identity: pass');
    clearSessions();

    await terminalRequest(Restart);
    clearSessions();
    await terminalRequest(Logout);
    console.log('native restart/logout wait for successful persistence before retiring: pass');
    clearSessions();

    sessionAt(origin);
    assert.strictEqual(visible(Object.fromEntries(Object.entries(origin).map(([key, value]) => [key, String(value)]))), true,
        'numeric string candidate coordinates retain native Number conversion');
    for (const loc of [{ ...origin, locX: NaN }, { ...origin, locY: 'bad' }, { ...origin, locX: Infinity }]) {
        assert.strictEqual(visible(loc), false, 'malformed effective candidate location returns false without throwing');
    }
    for (const loc of [{ locX: origin.locX, locY: origin.locY }, { ...origin, locZ: NaN }, { ...origin, locZ: Infinity }]) {
        assert.strictEqual(visible(loc), true, 'native floor missing-location fallback preserves nonfinite candidate Z');
    }
    const crafting = cold({ ...remote, locX: 500000 });
    crafting.stats.craftShop = { loc: origin };
    assert.strictEqual(coordinator.visibleToRealPlayer(crafting), true, 'craft shop location is the queried effective location');
    crafting.stats.craftShop.loc = remote;
    assert.strictEqual(coordinator.visibleToRealPlayer(crafting), false);
    const oldNearby = Population.realPlayerSessionsNear;
    Population.realPlayerSessionsNear = () => { throw new Error('exempt cold state must not query nearby players'); };
    try {
        for (const activity of ['traveling', 'pk_hunting']) {
            assert.strictEqual(coordinator.visibleToRealPlayer({ ...cold(origin), activity }), false);
        }
        assert.strictEqual(coordinator.visibleToRealPlayer({ ...cold(origin), stats: { supplyErrand: { itemSelfId: 1864 } } }), false);
    } finally { Population.realPlayerSessionsNear = oldNearby; }
    console.log('native craft effective location and persisted cold exemptions: pass');
    assert.strictEqual(invoke('Database').isReady(), false);
    console.log('N62 native indexed cold visibility: focused contracts passed');
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    clearSessions();
    Object.assign(Config, originalConfig);
    Object.assign(Geodata, originalGeo);
});
