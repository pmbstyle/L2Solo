'use strict';
const assert = require('assert');
require('../src/Global');
const Index = require('../src/GameServer/World/CharacterLocationIndex');
const Cache = require('../src/GameServer/Bot/Population/LifeStateCache');
const { SpotOccupancyIndex } = require('../src/GameServer/Bot/Population/SpotOccupancyIndex');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Database = invoke('Database');
const originalNow = Date.now;
let clock = 100000;
Date.now = () => clock;
const make = (id, patch = {}) => ({ characterId: id, phase: 'cold', activity: 'hunting', spotId: 'a',
    loc: { locX: 1, locY: 2, locZ: 3 }, stats: {}, inventory: {}, updatedAt: clock,
    timing: { lastResolvedAt: clock, nextResolveAt: clock + 3600000 }, simulation: { revision: 1 }, ...patch });
const profiles = ['a', 'b', 'intent', 'destination'].map(id => ({ id, minLevel: 1, maxLevel: 20,
    avgLevel: 10, density: 10, capacity: 100 }));
const snapshot = occupancy => SpotProfiles.indexedOccupancy(occupancy, profiles);
const raw = (index, id, source) => {
    const record = { id, source, phase: 'hot', loc: () => { throw Error('planning_point_read'); } };
    index.setSource(id, 'state', record, { indexed: false });
    return record;
};
try {
    assert.strictEqual(Database.isReady(), false);
    const kernel = new ColdSimulationKernel({ resolveSolo: () => { throw Error('no resolve'); }, now: () => clock });
    const original = make(1, { phase: 'hot', activity: 'resting' });
    kernel.upsert({ state: original, context: {} });
    const record = kernel.states.locationIndex.getSource(1, 'state');
    assert.strictEqual(record.source, original);
    assert.strictEqual(kernel.states.locationIndex.records.get(1).state.indexed, false);
    const bound = new SpotOccupancyIndex({ locationIndex: kernel.states.locationIndex });
    bound.update(original);
    assert.strictEqual(bound.places.get('1').state, original);
    assert.strictEqual(snapshot(bound).a.count, 1);
    console.log('Current raw unindexed original and actual planning positives: PASS');
    assert.strictEqual(bound.places.get('1').record, record,
        'planning membership must point at the same canonical original record');
    assert.strictEqual(kernel.occupancy.locationIndex, kernel.states.locationIndex);
    assert.strictEqual(kernel.occupancy.places.get('1').record, record);
    assert.strictEqual(kernel.occupancy.places.get('1').state, original);

    // Standalone missing state remains empty derived metadata, not a fake character.
    const standalone = new SpotOccupancyIndex();
    standalone.update();
    assert.strictEqual(standalone.places.size, 1);
    assert.strictEqual(standalone.places.get('').record, null);
    assert.strictEqual(standalone.places.get('').state, undefined);
    assert.strictEqual(standalone.locationIndex.sourceSize('state'), 0);
    assert.strictEqual(standalone.physical.size, 0); assert.strictEqual(standalone.reserved.size, 0);
    const empty = standalone.places.get('');
    assert.throws(() => { empty.state = {}; }, TypeError);
    assert.throws(() => standalone.update(null), TypeError);
    assert.strictEqual(standalone.places.get(''), empty);
    standalone.remove(''); assert.strictEqual(standalone.places.size, 0);
    const noPhaseRead = make(2);
    Object.defineProperty(noPhaseRead, 'phase', { get() { throw Error('planning_phase_read'); } });
    Object.defineProperty(noPhaseRead, 'loc', { get() { throw Error('planning_location_read'); } });
    standalone.update(noPhaseRead);
    assert.strictEqual([...standalone.members('a', 'physical')][0][1], noPhaseRead);
    assert.strictEqual(standalone.places.get('2').record.source, noPhaseRead);
    assert.strictEqual(standalone.locationIndex.records.get('2').state.indexed, false);
    for (const value of [false, 0, -0, '', NaN, 0n, Symbol('scalar')]) {
        standalone.update(value);
        const current = standalone.places.get('');
        assert(Object.is(current.state, value)); assert(Object.is(current.record.source, value));
    }
    standalone.update(undefined);
    assert.strictEqual(standalone.places.get('').record, null);
    assert.strictEqual(standalone.locationIndex.getSource('', 'state'), null);
    const ownActor = { id: 2, source: {}, phase: 'hot', loc: { locX: 1, locY: 2, locZ: 3 } };
    standalone.locationIndex.put(ownActor);
    standalone.clear(); assert.strictEqual(standalone.locationIndex.sourceSize('state'), 0);
    assert.strictEqual(standalone.locationIndex.get(2), ownActor);
    const independent = new SpotOccupancyIndex();
    assert.notStrictEqual(independent.locationIndex, standalone.locationIndex);

    // Bound mode never bootstraps/copies/publishes sources or touches another view.
    const index = new Index({ legacyStateCache: true });
    const actor = { id: 11, source: {}, phase: 'hot', loc: { locX: 1, locY: 2, locZ: 3 } };
    index.put(actor);
    let unrelatedReads = 0;
    for (let id = 32; id < 96; id++) {
        const source = make(id);
        Object.defineProperty(source, 'characterId', { get() { unrelatedReads++; throw Error('unrelated_fact_read'); } });
        raw(index, id, source);
    }
    const selected = make(11, { phase: 'warm', loc: { locX: 'bad' } }), selectedRecord = raw(index, 11, selected);
    const facet = new SpotOccupancyIndex({ locationIndex: index });
    assert.strictEqual(facet.places.size, 0); assert.strictEqual(unrelatedReads, 0);
    for (const invalid of [new Index(), {}, false]) {
        assert.throws(() => new SpotOccupancyIndex({ locationIndex: invalid }), TypeError);
        assert.strictEqual(index.getSource(11, 'state'), selectedRecord);
    }
    assert.strictEqual(facet.updateRecord(selectedRecord), true);
    assert.strictEqual(facet.places.get('11').record, selectedRecord);
    assert.deepStrictEqual([...facet.members('a', 'physical')], [['11', selected]]);
    assert.throws(() => [...facet.members('a', 'unknown')], TypeError);
    assert.strictEqual(facet.update(undefined), false);
    assert.throws(() => facet.update(null), TypeError);
    assert.strictEqual(facet.places.get('11').record, selectedRecord);
    assert.strictEqual(unrelatedReads, 0);
    const before = facet.places.get('11'), replacement = make(11, { spotId: 'b' });
    const replacementRecord = raw(index, 11, replacement);
    assert.strictEqual(facet.removeRecord(selectedRecord), false);
    assert.strictEqual(facet.places.get('11'), before);
    assert.strictEqual(facet.updateRecord({ ...replacementRecord }), false);
    assert.strictEqual(facet.places.get('11'), before);
    assert.strictEqual(facet.updateRecord(replacementRecord), true);
    assert.strictEqual(before.record.source, selected);
    assert.strictEqual(facet.updateRecord(selectedRecord), false);
    assert.deepStrictEqual([...facet.members('b', 'physical')], [['11', replacement]]);
    assert.strictEqual(facet.removeRecord(selectedRecord), false);
    index.removeSource(11, 'state', replacement);
    assert.strictEqual(facet.removeRecord(replacementRecord), true, 'source-first Cache delete order');
    assert.strictEqual(facet.removeRecord(replacementRecord), false);
    const restored = raw(index, 11, replacement);
    facet.updateRecord(restored); facet.clear();
    assert.strictEqual(index.getSource(11, 'state'), restored); assert.strictEqual(index.get(11), actor);
    assert.strictEqual(facet.locationIndex, index); assert.strictEqual(unrelatedReads, 0);

    // Planning distinctions do not depend on the spatial eligibility of their source.
    const cases = [make(20, { phase: 'hot' }), make(21, { activity: 'dead' }), make(22, { activity: 'resting' }),
        make(23, { activity: 'grouped' }), make(24, { activity: 'pk_hunting', loc: { locX: NaN } }),
        make(25, { activity: 'traveling', stats: { travel: { spotId: 'destination' } } }),
        make(26, { activity: 'traveling' }), make(27, { activity: 'merchant' }),
        make(28, { activity: 'shopping' }), make(29, { activity: 'crafting' })];
    for (const source of cases) facet.updateRecord(raw(index, source.characterId, source));
    assert.deepStrictEqual(snapshot(facet), SpotProfiles.occupancySnapshot(profiles, cases));
    assert(snapshot(facet).destination.reservedKeys.has('25'));
    for (const id of [20, 21, 22, 23, 24]) assert(snapshot(facet).a.reservedKeys.has(String(id)));
    for (const id of [26, 27, 28, 29]) assert(!snapshot(facet).a.reservedKeys.has(String(id)));
    const backed = make(101, { stats: { partyRequest: { spotId: 'intent', status: 'deferred' },
        capacityBackoffs: [{ spotId: 'intent', until: clock + 1 }] } });
    facet.updateRecord(raw(index, 101, backed));
    assert(snapshot(facet).a.reservedKeys.has('101')); assert(!snapshot(facet).intent);
    clock++; assert(snapshot(facet).intent.reservedKeys.has('101'));
    const dedup = make(102, { stats: { partyRequest: { spotId: 'a', status: 'open' } } });
    facet.updateRecord(raw(index, 102, dedup));
    assert.strictEqual([...facet.members('a', 'reserved')].filter(([key]) => key === '102').length, 1);
    const precedence = make(103, { stats: { clanPartyObjective: { spotId: 'b', status: 'open' },
        partyRequest: { spotId: 'intent', status: 'open' },
        equipmentPlan: { status: 'active', strategy: 'direct_drop', next: { spotId: 'destination' } } } });
    const precedenceRecord = raw(index, 103, precedence); facet.updateRecord(precedenceRecord);
    assert.strictEqual(facet.places.get('103').intentSpotId, 'b');
    const mutable = snapshot(facet);
    assert(SpotProfiles.reserveCapacity(mutable, profiles[0], [{ characterId: 999 }], { maxOverflowUnits: 1000 }));
    assert(mutable.a.reservedKeys.has('999')); assert(!snapshot(facet).a.reservedKeys.has('999'));
    const excluded = SpotProfiles.indexedOccupancy(facet, profiles, new Set(['103']));
    assert(!excluded.a.reservedKeys.has('103')); assert(!excluded.b?.reservedKeys.has('103'));
    assert(snapshot(facet).b.reservedKeys.has('103'));
    const changedProfiles = profiles.map(profile => ({ ...profile, capacity: 1 }));
    const currentStates = [...facet.places.values()].map(place => place.state);
    assert.deepStrictEqual(SpotProfiles.indexedOccupancy(facet, changedProfiles),
        SpotProfiles.occupancySnapshot(changedProfiles, currentStates));

    const cache = new Cache(), duplicateA = make(70), duplicateB = make(70, { spotId: 'b' });
    cache.set('raw-a', duplicateA); cache.set('raw-b', duplicateB);
    assert.strictEqual(cache.occupancy.places.get('70').record, cache.locationIndex.getSource('raw-b', 'state'));
    cache.delete('raw-a'); assert.strictEqual(cache.occupancy.places.has('70'), false);
    assert.strictEqual(cache.get('raw-b'), duplicateB);
    for (const value of [false, 0, -0, '', NaN]) {
        cache.set(0, value); assert(Object.is(cache.get(0), value));
        assert.strictEqual(cache.occupancy.places.get('').record, cache.locationIndex.getSource(0, 'state'));
        assert(Object.is(cache.occupancy.places.get('').state, value));
    }
    const opaque = make(71, { stats: { partyRequest: { spotId: 'intent', status: 'open' },
        capacityBackoffs: [{ spotId: 'intent', until: clock + 1 }] } });
    cache.set('opaque-backoff', opaque);
    const opaqueRecord = cache.locationIndex.getSource('opaque-backoff', 'state');
    assert.strictEqual(cache.occupancy.places.get('71').record, opaqueRecord);
    assert(!snapshot(cache.occupancy).intent);
    clock++;
    assert(snapshot(cache.occupancy).intent.reservedKeys.has('71'));
    assert.strictEqual(cache.occupancy.places.get('71').record, opaqueRecord);
    assert.strictEqual(cache.locationIndex.getSource('opaque-backoff', 'state'), opaqueRecord);
    cache.clear(); assert.strictEqual(cache.occupancy.places.size, 0);

    // Existing Main in-place refresh and reuse clocks remain authoritative.
    const current = Life.acceptLifecycleRow({ characterId: 9001, phase: 'cold', activity: 'traveling', spotId: 'a',
        level: 1, updatedAt: clock, statsJson: JSON.stringify({ travel: { spotId: 'destination' } }), inventoryJson: '{}' });
    assert(snapshot(Life.occupancyIndex()).destination.reservedKeys.has('9001'));
    current.activity = 'hunting'; current.stats.travel = null; Life.refreshOccupancy(current);
    assert(!snapshot(Life.occupancyIndex()).destination);
    assert(snapshot(Life.occupancyIndex()).a.reservedKeys.has('9001'));
    const reused = SpotProfiles.currentOccupancy(profiles, 1000);
    clock += 500; assert.strictEqual(SpotProfiles.currentOccupancy(profiles, 1000), reused);
    clock += 500; assert.notStrictEqual(SpotProfiles.currentOccupancy(profiles, 1000), reused);
    assert.strictEqual(Database.isReady(), false);
    console.log('Canonical occupancy sources/empty-domain/lifetime/planning parity and reservation checks passed');
} finally { Date.now = originalNow; }
