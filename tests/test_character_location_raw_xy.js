'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const gameRoot = path.resolve(process.env.N53_GAME_ROOT || path.join(__dirname, '..'));
const CharacterLocationIndex = require(path.join(gameRoot, 'src/GameServer/World/CharacterLocationIndex'));
const failures = [];

// Pure future API controls. No Global, World, runtime holder, Actor, SQL or
// arithmetic sampling is loaded. Direct border values below come from the
// independently frozen geometry report, rather than a mirror bounds function.
function record(id, source = {}, loc = { locX: 0, locY: 0, locZ: 0 }, extra = {}) {
    return { id, source, loc, phase: 'hot', realPlayer: false, spotId: null, ...extra };
}
function add(index, value, view = 'actor', indexed = false) {
    index.setSource(value.id, view, value, { indexed });
    return value;
}
function enable(index, value, loc) {
    assert.equal(index.updateFacet(value.id, 'actor', value, 'raw_xy', { enabled: true, loc }), true);
    return index.records.get(value.id).actor;
}
function query(index, loc = { locX: 0, locY: 0 }, radius = 6000, accept = null) {
    return index.nearFacet(loc, radius, { view: 'actor', facet: 'raw_xy', accept });
}
function refs(actual, expected, label) {
    assert.equal(actual.length, expected.length, `${label}: no duplicates or omissions`);
    assert.equal(new Set(actual).size, actual.length, `${label}: unique original records`);
    expected.forEach(value => assert.equal(actual.includes(value), true, `${label}: exact original record`));
}
function sameRefs(actual, expected, label) {
    assert.equal(actual.length, expected.length, label);
    expected.forEach((value, i) => assert.equal(actual[i], value, `${label}: original ref ${i}`));
}
function check(name, work) {
    try { work(); console.log('PASS', name); }
    catch (error) { failures.push(name); console.error('FAIL', name, error.stack); }
}

check('same canonical entries and same-cell Set remain while every enable renews descriptor', () => {
    const index = new CharacterLocationIndex();
    const first = add(index, record(1)), second = add(index, record(2));
    const live = { locX: 1, locY: 2 };
    const entry = enable(index, first, () => live);
    enable(index, second, { locX: 3, locY: 4 });
    const bucket = index.cells.get('0_0').rawXY, descriptor = entry.rawXY;
    assert.equal(bucket.has(entry), true); assert.equal(entry.record, first);
    assert.equal(descriptor.record, first); assert.equal(descriptor.key, '0_0');
    refs(query(index), [first, second], 'native same-cell insertion order: unordered query originals');
    sameRefs(Array.from(bucket, entry => entry.record), [first, second], 'native same-cell insertion order: storage order');
    live.locX = 100;
    enable(index, first, () => live);
    assert.equal(index.records.get(1).actor, entry); assert.equal(index.cells.get('0_0').rawXY, bucket);
    assert.notEqual(entry.rawXY, descriptor);
    refs(query(index), [first, second], 'same-cell refresh keeps Set position: unordered query originals');
    sameRefs(Array.from(bucket, entry => entry.record), [first, second], 'same-cell refresh keeps Set position: storage order');
    live.locX = 12000;
    enable(index, first, () => live);
    assert.equal(bucket.has(entry), false); assert.equal(index.cells.get('2_0').rawXY.has(entry), true);
    refs(query(index, live, 0), [first], 'raw crossing updates addressed membership');
});

check('generic actor disable/crossing and same-id state do not remove facet-only cells or groups', () => {
    const index = new CharacterLocationIndex({ legacyStateCache: true });
    const point = { locX: 1, locY: 1, locZ: 0 }, raw = { locX: 18000, locY: 0 };
    const actor = add(index, record(1, {}, () => point, { spotId: 'actor_spot', realPlayer: true }), 'actor', true);
    const state = add(index, record(1, {}, { locX: 0, locY: 0, locZ: 0 }, { phase: 'cold', spotId: 'state_spot' }), 'state', true);
    const entry = enable(index, actor, () => raw), rawSet = index.cells.get('3_0').rawXY;
    const groupKey = {};
    assert.equal(index.updateGroups(1, 'actor', actor, 'pvp_party', [groupKey], 1), true);
    const groupSet = index.groups.get(groupKey).entries;
    point.locX = 18000;
    assert.equal(index.updateSource(1, 'actor', actor.source), true);
    assert.equal(index.cells.get('3_0').rawXY, rawSet);
    assert.equal(index.updateSource(1, 'actor', actor.source, { indexed: false }), true);
    assert.equal(index.cells.get('3_0').actor, undefined); assert.equal(index.cells.get('3_0').rawXY, rawSet);
    refs(query(index, raw, 0), [actor], 'raw-only cell survives generic detach');
    refs(index.nearSources({ locX: 0, locY: 0, locZ: 0 }, 0, { view: 'state', kind: 'cold' }), [state], 'state view independent');
    assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: false }), true);
    assert.equal(entry.rawXY, null); assert.equal(index.cells.has('3_0'), false);
    assert.equal(index.getSource(1, 'state'), state); assert.equal(index.groups.get(groupKey).entries, groupSet);
    sameRefs(Array.from(index.groupSources(groupKey)), [actor], 'facet disable does not detach party metadata');
    sameRefs(index.inSpotSources('state_spot', { view: 'state' }), [state], 'state spot untouched');
});

check('same-source wrapper renewal invalidates old provider until exact rebind; replacement cleans old facet', () => {
    const index = new CharacterLocationIndex(), source = {}, old = add(index, record(1, source));
    let oldReads = 0, accepts = 0;
    const entry = enable(index, old, () => { oldReads++; return { locX: 0, locY: 0 }; });
    const bucket = index.cells.get('0_0').rawXY, oldDescriptor = entry.rawXY;
    const current = record(1, source);
    add(index, current);
    assert.equal(index.records.get(1).actor, entry); assert.equal(entry.rawXY, oldDescriptor);
    oldReads = 0;
    refs(query(index, { locX: 0, locY: 0 }, 6000, () => { accepts++; return true; }), [], 'old record descriptor is not current');
    assert.equal(oldReads, 0); assert.equal(accepts, 0);
    assert.equal(index.updateFacet(1, 'actor', old, 'raw_xy', { enabled: true, get loc() { throw Error('old loc read'); } }), false);
    enable(index, current, { locX: 0, locY: 0 });
    assert.equal(index.cells.get('0_0').rawXY, bucket); assert.notEqual(entry.rawXY, oldDescriptor);
    refs(query(index), [current], 'renewed current wrapper returns original record');
    const replacement = record(1);
    add(index, replacement);
    assert.equal(entry.rawXY, null); assert.equal(bucket.size, 0); assert.equal(index.cells.has('0_0'), false);
    assert.equal(index.updateFacet(1, 'actor', current, 'raw_xy', { enabled: true, get loc() { throw Error('predecessor loc'); } }), false);
    enable(index, replacement, { locX: 12000, locY: 0 });
    refs(query(index, { locX: 12000, locY: 0 }, 0), [replacement], 'different source alone owns new facet');
});

check('actor/state/full clear and remove detach exact facets/providers without touching opposite source', () => {
    for (const mode of ['state', 'actor', 'full', 'remove']) {
        const index = new CharacterLocationIndex({ legacyStateCache: true });
        const actor = add(index, record(1)), state = add(index, record(1), 'state');
        const entry = enable(index, actor, { locX: 0, locY: 0 }), set = index.cells.get('0_0').rawXY;
        if (mode === 'state') {
            index.clearSourceView('state'); assert.equal(index.getSource(1, 'actor'), actor);
            assert.equal(index.cells.get('0_0').rawXY, set); refs(query(index), [actor], 'state reset leaves raw actor');
        } else {
            if (mode === 'actor') index.clearSourceView('actor');
            if (mode === 'full') index.clear();
            if (mode === 'remove') assert.equal(index.removeSource(1, 'actor', actor.source), true);
            assert.equal(set.size, 0); assert.equal(entry.rawXY, null); assert.equal(index.cells.size, 0);
            assert.equal(index.getSource(1, 'state'), mode === 'full' ? null : state);
            assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: true, get loc() { throw Error('detached loc'); } }), false);
            const next = add(index, record(1)); enable(index, next, { locX: 0, locY: 0 });
            refs(query(index), [next], 'reset/reinsert only new exact record');
        }
    }
});

check('disabled/stale/accept-false paths read no loc and validation precedes mutation', () => {
    const index = new CharacterLocationIndex(), actor = add(index, record(1));
    let reads = 0;
    const provider = () => { reads++; return { locX: 1, locY: 1 }; };
    const entry = enable(index, actor, provider), set = index.cells.get('0_0').rawXY, descriptor = entry.rawXY;
    reads = 0;
    refs(query(index, { locX: 0, locY: 0 }, 6000, () => false), [], 'reject before location'); assert.equal(reads, 0);
    const badOptions = [null, { enabled: undefined }, { enabled: 1 }, { enabled: true, loc: null },
        { enabled: true, loc: { locX: NaN, locY: 0 } }, { enabled: true, loc: { locX: '0', locY: 0 } }];
    for (const options of badOptions) {
        assert.throws(() => index.updateFacet(1, 'actor', actor, 'raw_xy', options));
        assert.equal(entry.rawXY, descriptor); assert.equal(index.cells.get('0_0').rawXY, set); assert.equal(set.size, 1);
    }
    for (const [id, view, facet] of [[0, 'actor', 'raw_xy'], [1, 'state', 'raw_xy'], [1, 'actor', 'other']]) {
        let invalidReads = 0;
        assert.throws(() => index.updateFacet(id, view, actor, facet, { enabled: true,
            get loc() { invalidReads++; return { locX: 0, locY: 0 }; } }), RangeError);
        assert.equal(invalidReads, 0, 'invalid typed domain rejects before loc property');
        assert.equal(entry.rawXY, descriptor);
    }
    for (const mode of [undefined, 1, null]) {
        let invalidReads = 0;
        assert.throws(() => index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: mode,
            get loc() { invalidReads++; return { locX: 0, locY: 0 }; } }), TypeError);
        assert.equal(invalidReads, 0, 'invalid mode rejects before loc property');
    }
    const producerFailure = Error('ordinary producer location failure');
    assert.throws(() => index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: true,
        loc() { throw producerFailure; } }), thrown => thrown === producerFailure);
    assert.equal(entry.rawXY, descriptor); assert.equal(index.cells.get('0_0').rawXY, set);
    assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: false, get loc() { throw Error('disabled loc read'); } }), true);
    assert.equal(reads, 0); assert.equal(entry.rawXY, null);
    assert.equal(index.updateFacet(1, 'actor', {}, 'raw_xy', { get enabled() { throw Error('stale mode read'); }, get loc() { throw Error('stale loc'); } }), false);
});

check('query typed errors/custom sizes and generic strict unsafe contracts remain separate', () => {
    const index = new CharacterLocationIndex(), actor = add(index, record(1));
    let reads = 0;
    const entry = enable(index, actor, () => { reads++; return { locX: 0, locY: 0 }; }), descriptor = entry.rawXY;
    reads = 0;
    for (const radius of [-1, NaN, Infinity, 6001]) assert.throws(() => query(index, { locX: 0, locY: 0 }, radius));
    for (const loc of [null, { locX: undefined, locY: 0 }, { locX: '0', locY: 0 }, { locX: Infinity, locY: 0 }]) assert.throws(() => query(index, loc));
    assert.throws(() => index.nearFacet({ locX: 0, locY: 0 }, 0, { view: 'state', facet: 'raw_xy' }));
    assert.throws(() => index.nearFacet({ locX: 0, locY: 0 }, 0, { view: 'actor', facet: 'other' }));
    assert.throws(() => query(index, { locX: 0, locY: 0 }, 0, true));
    assert.equal(reads, 0); assert.equal(entry.rawXY, descriptor);
    const custom = new CharacterLocationIndex({ cellSize: 3000 }), other = add(custom, record(2));
    let customReads = 0;
    assert.throws(() => custom.updateFacet(2, 'actor', other, 'raw_xy', { enabled: true,
        get loc() { customReads++; return { locX: 0, locY: 0 }; } }), RangeError);
    assert.equal(customReads, 0, 'custom cell size rejects before loc property');
    assert.throws(() => query(custom));
    const huge = add(index, record(3, {}, { locX: 1e100, locY: 0, locZ: 0 }));
    enable(index, huge, { locX: 1e100, locY: 0 });
    assert.throws(() => index.updateSource(3, 'actor', huge.source, { indexed: true }), RangeError);
    assert.throws(() => index.nearSources({ locX: 1e100, locY: 0, locZ: 0 }, 0), RangeError);
    refs(query(index, { locX: 1e100, locY: 0 }, 0), [huge], 'named raw unsafe coordinates remain independent');
});

check('live invalid candidate is excluded; ordinary predicate/provider errors keep exact identity', () => {
    const index = new CharacterLocationIndex(), actor = add(index, record(1));
    let live = { locX: 0, locY: 0 }, error = null;
    enable(index, actor, () => { if (error) throw error; return live; });
    live = { locX: NaN, locY: 0 }; refs(query(index), [], 'nonfinite live projection');
    live = { locX: 0, locY: undefined }; refs(query(index), [], 'missing live Y');
    live = { locX: 0, locY: 0, get locZ() { throw Error('raw query read Z'); } };
    refs(query(index), [actor], 'valid live recovery and no Z dependency');
    error = Error('ordinary provider failure'); assert.throws(() => query(index), thrown => thrown === error);
    error = null;
    const failure = Error('ordinary predicate failure');
    assert.throws(() => query(index, { locX: 0, locY: 0 }, 6000, () => { throw failure; }), thrown => thrown === failure);
    refs(query(index), [actor], 'ordinary errors do not remove healthy membership');
});

check('producer input/point callbacks cannot overwrite an accepted inner SAME-record descriptor', () => {
    for (const seam of ['mode', 'point']) {
        const index = new CharacterLocationIndex(), actor = add(index, record(1));
        const entry = enable(index, actor, { locX: 0, locY: 0 });
        const options = seam === 'mode' ? {
            get enabled() { assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: false }), true); return true; },
            loc: { locX: 0, locY: 0 }
        } : { enabled: true, loc() {
            assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: false }), true);
            return { locX: 0, locY: 0 };
        } };
        assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', options), false);
        assert.equal(entry.rawXY, null); refs(query(index), [], 'inner disable survives older producer continuation');
    }
    const index = new CharacterLocationIndex(), actor = add(index, record(1));
    enable(index, actor, { locX: 0, locY: 0 });
    const replacement = record(1);
    assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: true, loc() {
        add(index, replacement); enable(index, replacement, { locX: 12000, locY: 0 });
        return { locX: 0, locY: 0 };
    } }), false);
    refs(query(index, { locX: 12000, locY: 0 }, 0), [replacement], 'new record/provider survives old input callback');
});

check('predicate callback replacement/disable/rebind/move cannot return stale entries or duplicates', () => {
    for (const change of ['replace', 'disable', 'rebind', 'move', 'same_cell']) {
        const index = new CharacterLocationIndex(), actor = add(index, record(1));
        const entry = enable(index, actor, { locX: -1, locY: 0 });
        let calls = 0;
        const result = query(index, { locX: 0, locY: 0 }, 6000, () => {
            calls++; assert(calls <= 1, 'seen canonical entry before callback prevents Set reinsertion recurrence');
            if (change === 'replace') add(index, record(1));
            else if (change === 'disable') assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: false }), true);
            else enable(index, actor, { locX: change === 'move' ? 6000 : -1, locY: 0 });
            return true;
        });
        refs(result, [], 'captured old descriptor/record rejects after ' + change); assert.equal(calls, 1);
        if (!['replace', 'disable'].includes(change)) assert.equal(index.records.get(1).actor, entry);
    }
});

check('live provider callback replacement/disable/rebind/move rejects old point before append', () => {
    for (const change of ['replace', 'disable', 'rebind', 'move']) {
        const index = new CharacterLocationIndex(), actor = add(index, record(1));
        let armed = false, calls = 0;
        enable(index, actor, () => {
            if (armed) {
                calls++; assert(calls <= 1, 'provider must not recur after same-entry movement');
                if (change === 'replace') add(index, record(1));
                else if (change === 'disable') assert.equal(index.updateFacet(1, 'actor', actor, 'raw_xy', { enabled: false }), true);
                else enable(index, actor, { locX: change === 'move' ? 6000 : -1, locY: 0 });
            }
            return { locX: -1, locY: 0 };
        });
        armed = true;
        refs(query(index), [], 'callback makes captured point stale: ' + change); assert.equal(calls, 1);
    }
});

check('accepted fractional border and twelve distinct cells preserve exact inclusive comparator', () => {
    const index = new CharacterLocationIndex(), edge = add(index, record(1));
    enable(index, edge, { locX: 6000, locY: 0 });
    refs(query(index, { locX: -1e-20, locY: 0 }), [edge], 'accepted negative tiny origin to6000');
    const outside = add(index, record(2)); enable(index, outside, { locX: 6000.000000000001, locY: 0 });
    refs(query(index, { locX: 0, locY: 0 }), [edge], 'next radius Number is outside');
    const twelve = new CharacterLocationIndex();
    const points = [[5999.999999999999, 5999.999999999999], [5999.999999999999, 6000],
        [6000, 5999.999999999999], [6000, 6000], [-1e-20, 5999.999999999999], [-1e-20, 6000],
        [12000, 5999.999999999999], [12000, 6000], [5999.999999999999, -1e-20], [6000, -1e-20],
        [5999.999999999999, 12000], [6000, 12000]];
    const rows = points.map(([locX, locY], i) => {
        const value = add(twelve, record(i + 1)); enable(twelve, value, { locX, locY }); return value;
    });
    assert.equal(twelve.cells.size, 12, 'accepted copied geometry occupies twelve actual keys');
    refs(query(twelve, { locX: 6000, locY: 6000 }), rows, 'all twelve original records remain visible');
});

check('huge finite singleton keys terminate and do not scan all cells', () => {
    for (const coordinate of [1e100, -1e100, Number.MAX_VALUE, -Number.MAX_VALUE]) {
        const index = new CharacterLocationIndex(), value = add(index, record(1));
        enable(index, value, { locX: coordinate, locY: coordinate });
        const far = add(index, record(2)); enable(index, far, { locX: 0, locY: 0 });
        const originalGet = index.cells.get;
        let gets = 0;
        index.cells.get = function (key) { gets++; return originalGet.call(this, key); };
        index.cells.values = () => { throw Error('raw query scanned all cells'); };
        refs(query(index, { locX: coordinate, locY: coordinate }), [value], 'huge same-coordinate original record');
        assert.equal(gets, 1, 'huge query uses exactly one canonical cell key');
    }
});

check('outward actual intervals exclude far cells and query lookup cost is bounded81', () => {
    const index = new CharacterLocationIndex(), nearby = add(index, record(1));
    enable(index, nearby, { locX: 0, locY: 0 });
    let farPointReads = 0, farPredicateReads = 0;
    const far = [24000, -24000].map((coordinate, i) => {
        const value = add(index, record(i + 2));
        enable(index, value, () => { farPointReads++; return { locX: coordinate, locY: coordinate }; });
        return value;
    });
    const originalGet = index.cells.get;
    let gets = 0;
    index.cells.get = function (key) { gets++; return originalGet.call(this, key); };
    index.cells.values = () => { throw Error('raw query scanned all cells'); };
    farPointReads = 0;
    refs(query(index, { locX: 0, locY: 0 }, 6000, value => {
        if (far.includes(value)) farPredicateReads++; return true;
    }), [nearby], 'local cell query excludes far original sources');
    assert.equal(farPointReads, 0); assert.equal(farPredicateReads, 0); assert(gets > 0 && gets <= 81);
    gets = 0;
    query(index, { locX: 36893488147419103000, locY: -36893488147419103000 });
    assert(gets > 0 && gets <= 81, 'accepted branch-boundary query remains bounded');
});

check('radius0 squared underflow still uses conservative outward6000 bounds across a cell boundary', () => {
    const index = new CharacterLocationIndex(), value = add(index, record(1));
    enable(index, value, { locX: 0, locY: 0 });
    refs(query(index, { locX: -1e-200, locY: 0 }, 0), [value], 'legacy squared underflow includes original record');
});

if (failures.length) throw Error('raw XY pure contracts failed: ' + failures.join(', '));
console.log('BOUNDARY', JSON.stringify({ gameRoot, pureOnly: true, runtimeHolderLoaded: false,
    gameImports: false, database: false, arithmeticSampling: false }));
