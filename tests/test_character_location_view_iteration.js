'use strict';

const assert = require('node:assert/strict');
const Index = require('../src/GameServer/World/CharacterLocationIndex');
const point = (locX = 0) => ({ locX, locY: 0, locZ: 0 });
const record = (id, extra = {}) => ({ id, source: {}, phase: 'cold', loc: point(), spotId: null, ...extra });
// The old common-row enumeration is a baseline comparator only. Order and
// traversal assertions fail on actual existing behavior before new APIs exist.
function values(index, view) {
    if (index.sourceValues) return index.sourceValues(view);
    return (function* () { for (const row of index.records.values()) if (row[view]) yield row[view].record; })();
}
function keys(index, view) {
    if (index.sourceKeys) return index.sourceKeys(view);
    return (function* () { for (const value of values(index, view)) yield value.id; })();
}
function entries(index, view) {
    if (index.sourceEntries) return index.sourceEntries(view);
    return (function* () { for (const value of values(index, view)) yield [value.id, value]; })();
}
const failures = [];
function check(name, work) { try { work(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.stack}`); } }

check('actual existing same-ID raw and spatial source authority positives', () => {
    const index = new Index(), actor = record(1, { phase: 'hot', realPlayer: true, spotId: 'actor' });
    const state = record(1, { loc: point(12000), spotId: 'state' });
    index.put(actor); index.setSource(1, 'state', state);
    assert.equal(index.get(1), actor); assert.equal(index.getSource(1, 'state'), state);
    assert.deepEqual(index.near(point(), 0), [actor]);
    assert.deepEqual(index.nearSources(point(12000), 0, { view: 'state' }), [state]);
    assert.deepEqual(index.inSpot('actor'), [actor]);
    assert.deepEqual(index.inSpotSources('state', { view: 'state' }), [state]);
});

check('independent first insertion order and original record identity per source view', () => {
    const index = new Index(), actor1 = record(1), actor2 = record(2), state1 = record(1), state2 = record(2);
    index.put(actor1); index.put(actor2); index.setSource(2, 'state', state2); index.setSource(1, 'state', state1);
    assert.deepEqual([...keys(index, 'actor')], [1, 2]);
    assert.deepEqual([...keys(index, 'state')], [2, 1], 'actor insertion cannot determine independent state insertion order');
    assert.deepEqual([...values(index, 'state')], [state2, state1]);
    assert.deepEqual([...entries(index, 'state')], [[2, state2], [1, state1]]);
    if (index.sourceSize) { assert.equal(index.sourceSize('actor'), 2); assert.equal(index.sourceSize('state'), 2); }
});

check('replacement retains source order while existing spatial membership appends', () => {
    const index = new Index(), first = record(1, { spotId: 'same' }), second = record(2, { spotId: 'same' });
    index.setSource(1, 'state', first); index.setSource(2, 'state', second);
    const replacement = record(1, { spotId: 'same' }); index.setSource(1, 'state', replacement);
    assert.deepEqual(index.nearSources(point(), 0, { view: 'state' }), [second, replacement]);
    assert.deepEqual(index.inSpotSources('same', { view: 'state' }), [second, replacement]);
    assert.deepEqual([...keys(index, 'state')], [1, 2], 'overwrite preserves Map source order even with a new source');
    assert.deepEqual([...values(index, 'state')], [replacement, second]);
    assert.equal(index.updateSource(1, 'state', first.source), false);
    assert.equal(index.removeSource(1, 'state', first.source), false);
    assert.throws(() => index.setSource(1, 'state', record(1, { phase: 'warm' })), RangeError);
    assert.equal(index.getSource(1, 'state'), replacement);
    assert.deepEqual([...keys(index, 'state')], [1, 2]);
    assert.equal(index.removeSource(1, 'state', replacement.source), true);
    index.setSource(1, 'state', first);
    assert.deepEqual([...keys(index, 'state')], [2, 1], 'explicit remove and reinsert appends');
});

check('live native Map mutation semantics for keys, values and entries', () => {
    for (const iterate of [keys, values, entries]) {
        const index = new Index(), one = record(1), two = record(2), three = record(3), newer = record(2);
        index.setSource(1, 'state', one); index.setSource(2, 'state', two);
        const iterator = iterate(index, 'state'); assert.equal(iterator.next().done, false);
        index.setSource(2, 'state', newer); index.setSource(3, 'state', three);
        const expected = iterate === keys ? [2, 3] : iterate === values ? [newer, three] : [[2, newer], [3, three]];
        assert.deepEqual([...iterator], expected, 'unvisited overwrite and later append are observed once');
        index.setSource(4, 'state', record(4)); assert.equal(iterator.next().done, true, 'finished iterator never revives');
        const live = iterate(index, 'state'); assert.equal(live.next().done, false);
        index.clearSourceView('state'); const fresh = record(5); index.setSource(5, 'state', fresh);
        assert.deepEqual([...live], iterate === keys ? [5] : iterate === values ? [fresh] : [[5, fresh]],
            'clear and later append are visible to a still-active iterator');
        const deleted = iterate(index, 'state'); index.removeSource(5, 'state', fresh.source);
        assert.equal(deleted.next().done, true, 'deleted future key is skipped');
    }
});

check('legacy original keys, unindexed raw sources and opposite-view reset', () => {
    const index = new Index({ legacyStateCache: true }), opaque = {}, ids = [-0, NaN, 'key', opaque];
    let pointReads = 0;
    const states = ids.map(id => record(id));
    for (const value of states) {
        Object.defineProperty(value, 'loc', { get() { pointReads++; throw Error('raw point'); } });
        index.setSource(value.id, 'state', value, { indexed: false });
    }
    const actor = record(10); index.put(actor); pointReads = 0;
    assert.deepEqual([...keys(index, 'state')], [0, NaN, 'key', opaque]);
    assert.equal([...entries(index, 'state')][0][0], 0, 'native Map normalizes a negative-zero key');
    assert.deepEqual([...values(index, 'state')], states);
    assert.equal(pointReads, 0); assert.equal(index.getSource(NaN, 'state'), states[1]);
    const invalid = record(0, { loc: { ...point(), locZ: NaN } });
    assert.throws(() => index.setSource(0, 'state', invalid), RangeError);
    assert.equal(index.getSource(0, 'state'), states[0]);
    index.clearSourceView('actor'); assert.deepEqual([...values(index, 'state')], states);
    assert.equal(index.get(10), null); assert.equal(pointReads, 0);
    index.put(actor); index.clearSourceView('state'); assert.deepEqual([...keys(index, 'actor')], [10]);
    assert.deepEqual([...entries(index, 'state')], []); assert.equal(pointReads, 0);
    const live = values(index, 'actor'); index.clear(); const newer = record(11); index.put(newer);
    assert.deepEqual([...live], [newer], 'whole clear keeps native live iteration of each view');
});

for (const count of [32, 64]) check(`view iteration and clear do not visit ${count} unrelated actor rows`, () => {
    const index = new Index();
    for (let id = 100; id < 100 + count; id++) index.put(record(id));
    const own = record(1); index.setSource(1, 'state', own);
    const original = index.records.values.bind(index.records); let globalRowsVisited = 0;
    index.records.values = function* () { for (const row of original()) { globalRowsVisited++; yield row; } };
    assert.deepEqual([...values(index, 'state')], [own]);
    assert.deepEqual([...keys(index, 'state')], [1]);
    assert.deepEqual([...entries(index, 'state')], [[1, own]]);
    index.clearSourceView('state');
    console.log(JSON.stringify({ unrelated: count, globalRowsVisited }));
    assert.equal(globalRowsVisited, 0, 'selected-view operations have no full common-row traversal');
    assert.equal(index.records.size, count); assert.equal(index.get(100).id, 100);
});

check('view validation occurs at call before acquiring a lazy iterator', () => {
    const index = new Index();
    // Baseline uses the real common-order/cost failures above, not missing APIs.
    if (!index.sourceValues) return;
    for (const method of ['sourceSize', 'sourceKeys', 'sourceValues', 'sourceEntries']) {
        for (const view of [undefined, null, 'all']) assert.throws(() => index[method](view), RangeError);
    }
    assert.equal(index.sourceSize('actor'), 0); assert.equal(index.sourceSize('state'), 0);
});
if (failures.length) throw Error(`${failures.length} source-view enumeration contracts failed`);
