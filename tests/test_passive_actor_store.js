'use strict';

// Pure optional-store endpoint; native Worker attachment has a separate fixture.
const assert = require('node:assert/strict');
const path = require('node:path');
const sourceRoot = path.resolve(process.env.N53_GAME_ROOT
    || path.join(__dirname, '..'));
const TableMirror = require(path.join(sourceRoot, 'src/GameServer/Bot/Population/TableMirror'));
const Sources = require(path.join(sourceRoot, 'src/GameServer/World/CharacterActorSources'));
const sources = Sources.standalone();
const { index } = sources;
const mirror = new TableMirror();
const UNKNOWN = 'CHARACTER_ACTOR_VIEW_UNKNOWN';
const publicSize = () => {
    try { return mirror.rows('actors').size; } catch (error) { return error.code; }
};
const outcomes = [];
let backing, descriptor, owner;
const tag = (value) => value === undefined ? { tag: 'undefined' } : value === null ? { tag: 'null' }
    : { tag: typeof value, value };
const row = (id, publication, x = id, y = 0, z = undefined) => ({ id, worldGeneration: 1,
    sourceGeneration: 1, publication, order: id, axes: { x: tag(x), y: tag(y), z: tag(z) } });
const state = { characterId: 1, packet: 'independent original pure state' };
const stateRecord = { id: 1, source: state, phase: 'cold' };
index.setSource(1, 'state', stateRecord, { indexed: false });
const conserved = () => {
    assert.equal(index.getSource(1, 'state'), stateRecord);
    assert.equal(index.getSource(1, 'state').source, state);
    assert.deepEqual(state, { characterId: 1, packet: 'independent original pure state' });
};
const check = (name, action) => { action(); conserved(); outcomes.push(name); };
const piece = (copyId, transferId, pageIndex, body) => ({ name: 'actors', attachmentId: 1,
    copyId, transferId, pageIndex, worldGeneration: 1, rows: [], removed: [], ...body });
const actors = (packet) => assert.deepEqual(mirror.apply([packet]), []);
try {
    mirror.attachStore('actors', (actualOwner, actualDescriptor) => {
        owner = actualOwner; descriptor = actualDescriptor;
        backing = sources.createStore(owner, descriptor);
        return backing;
    });
    check('actual_owned_attachment_and_no_second_rows_Map', () => {
        const metadata = TableMirror.actorStoreOwner(owner);
        assert.equal(metadata.descriptor, descriptor);
        assert.equal(metadata.mirror, mirror);
        assert.equal(mirror.tables.get('actors'), descriptor);
        assert.equal(descriptor.rows instanceof Map, false);
        assert.equal(descriptor.rows, mirror.rows('actors'));
        assert.equal(mirror.ready('actors'), false);
        assert.equal(index.sourceSize('actor'), 0);
        assert.throws(() => mirror.attachStore('actors', sources.createStore), TypeError);
        assert.throws(() => sources.createStore(Object.freeze({}), descriptor), TypeError);
        assert.throws(() => Sources.standalone(index), TypeError);
    });
    const originals = Array.from({ length: 130 }, (_, n) => row(n + 1, n + 1, n === 0 ? -0 : n + 1));
    check('original_DTO_refs_signed_zero_and_entry_order', () => {
        actors(piece(1, 1, 0, { from: null, to: 1, full: true, last: 0,
            rows: originals.slice(0, 64).map((value) => [value.id, value]) }));
        actors(piece(1, 1, 1, { from: 1, to: 1, full: false, last: 0,
            rows: originals.slice(64, 128).map((value) => [value.id, value]) }));
        actors(piece(1, 1, 2, { from: 1, to: 1, full: false, last: 1,
            rows: originals.slice(128).map((value) => [value.id, value]) }));
        assert.equal(mirror.ready('actors'), true);
        assert.equal(mirror.rows('actors').size, 130);
        assert.equal(backing.get(1), originals[0]);
        assert.equal(index.getSource(1, 'actor').source, originals[0]);
        assert(Object.is(backing.get(1).axes.x.value, -0));
        assert.equal(index.getSource(1, 'actor').phase, 'hot');
        assert.equal(index.records.get(1).actor.indexed, false);
        assert.deepEqual(Array.from(backing.keys()), originals.map((value) => value.id));
    });
    const originalEntry = index.records.get(1).actor;
    const replacement = row(1, 200, '6000', null, undefined);
    check('replacement_SAME_entry_raw_XY_with_undefined_Z', () => {
        actors(piece(1, 2, 0, { from: 1, to: 2, full: false, last: 1,
            rows: [[1, replacement]] }));
        assert.equal(index.records.get(1).actor, originalEntry);
        assert.equal(backing.get(1), replacement);
        assert.equal(index.removeSource(1, 'actor', originals[0]), false);
        assert.equal(Array.from(backing.keys())[0], 1);
        assert(index.nearFacet({ locX: 6000, locY: 0 }, 0).includes(index.getSource(1, 'actor')));
    });
    check('strict_private_domain_and_stale_chain_before_eviction', () => {
        const current = index.getSource(1, 'actor');
        assert.throws(() => backing.put(2, row(1, 201), descriptor.chain), TypeError);
        const malformed = row(1, 201);
        malformed.axes.x = { tag: 'unsupported', value: { valueOf() { throw new Error('must not convert'); } } };
        assert.throws(() => backing.put(1, malformed, descriptor.chain), TypeError);
        assert.throws(() => backing.put(1, row(1, 201), { ...descriptor.chain }), TypeError);
        assert.throws(() => backing.cleanup(65), RangeError);
        assert.equal(index.getSource(1, 'actor'), current);
        assert.equal(backing.get(1), replacement);
    });
    const newer = row(1, 300, false, true, null);
    check('absence_cutoff_protects_later_put_then_exact_removal', () => {
        actors(piece(1, 3, 0, { from: 2, to: 3, full: false, last: 1, rows: [[1, newer]],
            removed: [{ id: 1, worldGeneration: 1, throughPublication: 200 }] }));
        assert.equal(backing.get(1), newer);
        actors(piece(1, 4, 0, { from: 3, to: 4, full: false, last: 1,
            removed: [{ id: 2, worldGeneration: 1, throughPublication: 500 }] }));
        assert.equal(backing.has(2), false);
    });
    const firstNewCopy = row(1, 400);
    const newTail = row(131, 500);
    check('new_full_private_partial_and_bounded_cleanup_with_later_delta', () => {
        actors(piece(2, 5, 0, { from: null, to: 5, full: true, last: 0,
            rows: [[1, firstNewCopy]] }));
        assert.equal(mirror.ready('actors'), false);
        assert.throws(() => mirror.rows('actors').size, { code: UNKNOWN });
        // Private isolated Index diagnostics only; no native advertised actor read.
        assert.equal(backing.get(1), firstNewCopy);
        actors(piece(2, 5, 1, { from: 5, to: 5, full: false, last: 1, rows: [[131, newTail]] }));
        assert.equal(mirror.ready('actors'), false);
        const first = mirror.cleanupStore('actors', 64);
        assert.equal(first.inspected, 64); assert.equal(first.done, false);
        const lastTail = row(132, 600);
        actors(piece(2, 6, 0, { from: 5, to: 6, full: false, last: 1, rows: [[132, lastTail]] }));
        const second = mirror.cleanupStore('actors', 64);
        assert.equal(second.inspected, 64); assert.equal(second.done, false);
        const last = mirror.cleanupStore('actors', 64);
        assert.equal(last.inspected, 1); assert.equal(last.done, true);
        assert.equal(mirror.ready('actors'), true);
        assert.deepEqual(Array.from(backing.entries()), [[1, firstNewCopy], [131, newTail], [132, lastTail]]);
        assert.equal(index.records.get(1).actor, originalEntry);
    });
    check('real_gap_quarantine_and_once_resync', () => {
        const retained = backing.get(1);
        assert.deepEqual(mirror.apply([piece(2, 7, 0, { from: 9, to: 10, full: false, last: 1,
            rows: [[1, row(1, 700)]] })]), ['actors']);
        assert.equal(mirror.ready('actors'), false);
        assert.throws(() => mirror.rows('actors').size, { code: UNKNOWN });
        assert.equal(backing.get(1), retained);
        assert.deepEqual(mirror.apply([piece(2, 8, 0, { from: 10, to: 11, full: false, last: 1,
            removed: [{ id: 1, worldGeneration: 1, throughPublication: 900 }] })]), []);
        assert.equal(backing.get(1), retained);
    });
    check('whole_apply_ordinary_prefix_watcher_unknown_before_actor_full', () => {
        const observed = [];
        mirror.watch('ordinary', { reset() {}, put() { observed.push([mirror.ready('actors'), publicSize()]); }, remove() {} });
        assert.deepEqual(mirror.apply([{ name: 'ordinary', from: null, to: 1, full: true, last: 1,
            rows: [[1, { label: 'ordinary original' }]], removed: [] },
        piece(3, 9, 0, { from: null, to: 12, full: true, last: 1, rows: [[1, row(1, 1000)]] })]), []);
        assert.deepEqual(observed, [[false, UNKNOWN]]);
        assert.equal(mirror.ready('actors'), false);
        const cleanup = mirror.cleanupStore('actors', 64);
        assert.equal(cleanup.done, true);
        assert.equal(mirror.ready('actors'), true);
    });
    check('default_Mirror_waiting_semantics_unchanged', () => {
        const ordinary = new TableMirror();
        const original = { passive: true };
        assert.deepEqual(ordinary.apply([{ name: 'ordinary', from: null, to: 1, full: true, last: 1,
            rows: [[1, original]], removed: [] }]), []);
        assert.equal(ordinary.rows('ordinary').get(1), original);
        assert.deepEqual(ordinary.apply([{ name: 'ordinary', from: 3, to: 4, full: false, rows: [], removed: [] }]), ['ordinary']);
        assert.equal(ordinary.ready('ordinary'), false);
        assert.equal(ordinary.rows('ordinary').get(1), original);
    });
    check('held_private_iterator_and_store_disposal_are_terminal', () => {
        const iterator = backing.entries();
        assert.equal(iterator.next().value[0], 1);
        backing.dispose();
        assert.throws(() => iterator.next(), TypeError);
        assert.throws(() => backing.get(1), TypeError);
        assert.throws(() => backing.cleanup(64), TypeError);
        assert.throws(() => sources.createStore(owner, descriptor), TypeError);
    });
    console.log(JSON.stringify({ scope: 'FUTURE PURE optional actor store only; not native actor delivery',
        outcomes, count: outcomes.length, nativeFactoryCalled: false, nativeRoleClaims: false }));
} finally {
    conserved();
    backing?.dispose();
    index.clear();
    assert.equal(index.sourceSize('actor'), 0);
    assert.equal(index.sourceSize('state'), 0);
    console.log(JSON.stringify({ cleanup: 'isolated pure state/index only', nativeAttachment: false,
        sql: 0, worker: 0, filesWritten: 0 }));
}
