const assert = require('assert');

require('../src/Global');

const Projection = invoke('WorldObserver/WorldObserverProjection');

Projection.clear();
const initial = Projection.reset([
    { id: 1, kind: 'bot', name: 'One', loc: { locX: 10, locY: 20 } },
    { id: 2, kind: 'player', name: 'Two', loc: { locX: 30, locY: 40 } }
]);
assert.strictEqual(initial.revision, 1);
assert.strictEqual(initial.actors.length, 2);

const unchanged = Projection.apply({ upserts: [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 10, locY: 20 } }] });
assert.strictEqual(unchanged.revision, 1, 'identical actors must not advance the world revision');
assert.deepStrictEqual(Projection.changesSince(1), { revision: 1, reset: false, upserts: [], removals: [] });

const changed = Projection.apply({
    upserts: [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 11, locY: 20 } }],
    removals: [{ id: 2, kind: 'player' }]
});
assert.strictEqual(changed.revision, 2);
assert.deepStrictEqual(Projection.changesSince(1), {
    revision: 2,
    reset: false,
    upserts: [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 11, locY: 20 } }],
    removals: [{ id: 2, kind: 'player' }]
});

const reset = Projection.changesSince(0);
assert.strictEqual(reset.reset, true);
assert.deepStrictEqual(reset.actors, [{ id: 1, kind: 'bot', name: 'One', loc: { locX: 11, locY: 20 } }]);

Projection.clear();
console.log('World observer projection checks passed');

// Native cold receipts publish the accepted cache row without going through
// subscribeChanges (which also posts main-thread changes back to the worker).
// Exercise the same bootstrap/delta payloads and reducer the open pages use.
(async () => {
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const Clan = invoke('GameServer/Clan/ClanService');
    const Database = invoke('Database');
    const Manager = invoke('GameServer/Bot/BotManager');
    const World = invoke('GameServer/World/World');
    const Config = invoke('GameServer/Bot/Population/PopulationConfig');
    const PopulationStatus = invoke('GameServer/Bot/Population/PopulationStatus');
    const Observer = invoke('WorldObserver/WorldObserverServer');
    const State = require('../src/WorldObserver/public/worldState');
    const Pages = require('../src/WorldObserver/public/playerPages');
    const saved = { sync: Clan.syncColdMember, execute: Database.execute, everyState: Life.everyState,
        statuses: Manager.getAllBotStatuses, session: Manager.findSessionById, user: World.user,
        diagnostics: Config.developerDiagnostics, counts: PopulationStatus.counts };
    let scans = 0, statuses = [], hotSession = null;
    const id = 2006912, peer = 2006209;
    const publish = (characterId, patch) => {
        const previous = Life.cachedState(characterId);
        const state = { ...previous, ...patch, characterId, updatedAt: Number(previous?.updatedAt || 1000) + 1 };
        return Life.acceptSimulationOwnership(characterId, { revision: Number(previous?.simulation?.revision || 0) + 1 }, state);
    };
    const actors = snapshot => snapshot.bots.map(actor => ({ ...actor, kind: 'bot' }));
    try {
        Clan.syncColdMember = () => {};
        Database.execute = async ([sql]) => {
            assert.match(sql, /^SELECT id FROM characters WHERE karma > 0$/,
                'Observer updates must not read full bot rows from SQLite');
            return [];
        };
        World.user = { sessions: [] };
        Config.developerDiagnostics = false;
        PopulationStatus.counts = () => ({ total: 2, parties: 1 });
        Manager.getAllBotStatuses = () => statuses;
        Manager.findSessionById = actorId => Number(actorId) === id ? hotSession : null;
        const base = { phase: 'cold', activity: 'grouped', level: 55, exp: 100, adena: 500,
            currentRegion: 'Tamlin Orc fields', loc: { locX: 165269, locY: 51129, locZ: -3904 },
            party: { partyId: 'previous_party', leaderId: id, role: 'tank' },
            inventory: {}, stats: { classId: 5, role: 'tank' }, vitals: {} };
        publish(id, { ...base, name: 'KROvnik' });
        publish(peer, { ...base, name: 'Vincent', party: { ...base.party, role: 'healer' } });
        Life.everyState = (...args) => {
            scans++;
            const captured = saved.everyState.apply(Life, args);
            // A committed update can arrive after bootstrap captured the rows
            // but before its cooperative compaction has finished.
            publish(id, { level: 56 });
            return captured;
        };
        let snapshot = State.decodeBootstrap(await Observer.worldBootstrap());
        assert.strictEqual(snapshot.bots.find(actor => actor.id === id).level, 56,
            'a native receipt during bootstrap must reach the first frame');
        assert.strictEqual(Pages.groupParties(actors(snapshot))[0].members.length, 2);
        let revision = snapshot.revision;

        publish(id, { level: 57, exp: 300, adena: 900 });
        publish(id, { activity: 'hunting', party: { partyId: null }, currentRegion: 'Solo fields',
            loc: { locX: 92467, locY: 67813, locZ: -3664 } });
        publish(peer, { activity: 'hunting', party: { partyId: null } });
        const changes = await Observer.worldChanges(revision);
        assert.strictEqual(changes.reset, false);
        assert.deepStrictEqual(changes.upserts.map(actor => actor.id).sort(), [peer, id].sort(),
            'all departed members must reach the open page, once per actor');
        snapshot = State.applyChanges(snapshot, changes).snapshot;
        revision = changes.revision;
        const solo = snapshot.bots.find(actor => actor.id === id);
        assert.deepStrictEqual([solo.level, solo.exp, solo.adena, solo.mode, solo.party, solo.region],
            [57, 300, 900, 'hunting', null, 'Solo fields']);
        assert.deepStrictEqual(solo.loc, Life.cachedState(id).loc);
        assert.deepStrictEqual(Pages.groupParties(actors(snapshot)), [],
            'a dissolved party must disappear through live deltas');
        const reloaded = State.decodeBootstrap(await Observer.worldBootstrap());
        const withoutNulls = actor => Object.fromEntries(Object.entries(actor).filter(([, value]) => value !== null));
        assert.deepStrictEqual(reloaded.bots.find(actor => actor.id === id), withoutNulls(solo),
            'reloading and the already open directory must agree');
        assert.deepStrictEqual((await Observer.worldChanges(revision)).upserts, [],
            'an unchanged poll must not rebuild or retransmit cold actors');

        for (const characterId of [id, peer]) publish(characterId, { activity: 'grouped',
            party: { partyId: 'next_party', leaderId: peer, role: characterId === peer ? 'healer' : 'tank' } });
        const regrouped = await Observer.worldChanges(revision);
        snapshot = State.applyChanges(snapshot, regrouped).snapshot;
        revision = regrouped.revision;
        const groups = Pages.groupParties(actors(snapshot));
        assert.strictEqual(groups.length, 1);
        assert.strictEqual(groups[0].name, 'Vincent');
        assert.strictEqual(groups[0].members.length, 2);

        hotSession = { actor: {} };
        statuses = [{ id, name: 'KROvnik', available: true, level: 58, classId: 5,
            mode: 'hunting', loc: base.loc, vitals: {} }];
        publish(id, { level: 1 });
        const hot = await Observer.worldChanges(revision);
        assert.strictEqual(hot.upserts.find(actor => actor.id === id).level, 58,
            'a lifecycle publication must not overwrite the live actor');
        revision = hot.revision;
        hotSession = null; statuses = [];
        publish(id, { level: 59, phase: 'cold', activity: 'hunting', party: { partyId: null } });
        const cold = await Observer.worldChanges(revision);
        assert.strictEqual(cold.upserts.find(actor => actor.id === id).level, 59,
            'returning from a live actor must use the latest cold state');
        const current = Life.cachedState(id);
        Life.acceptInventoryProjection({ characterId: id, phase: 'cold', inventoryPatch: {},
            adena: 1234, mp: 25, updatedAt: current.updatedAt + 1,
            simulationRevision: current.simulation.revision + 1 });
        const purchase = await Observer.worldChanges(cold.revision);
        assert.strictEqual(purchase.upserts.find(actor => actor.id === id).adena, 1234,
            'native inventory receipts must also refresh the character directory');
        assert.strictEqual(scans, 1, 'subsequent polls must not scan the whole cold population');
        console.log('Observer native publications: bootstrap race, live progression, party departure/regrouping and hot/cold handoff passed');
    } finally {
        Clan.syncColdMember = saved.sync; Database.execute = saved.execute; Life.everyState = saved.everyState;
        Manager.getAllBotStatuses = saved.statuses; Manager.findSessionById = saved.session;
        World.user = saved.user; Config.developerDiagnostics = saved.diagnostics; PopulationStatus.counts = saved.counts;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
