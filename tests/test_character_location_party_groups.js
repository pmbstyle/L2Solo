'use strict';

const assert = require('node:assert/strict');
const Index = require('../src/GameServer/World/CharacterLocationIndex');
const partyKeys = require('../src/GameServer/World/PvpPartyMembershipKeys');
const point = (locX = 0) => ({ locX, locY: 0, locZ: 0 });
const record = (id, extra = {}) => ({ id, source: {}, phase: 'hot', loc: point(), ...extra });
const group = (index, key) => [...index.groupSources(key)];
const publish = (index, value, keys, order = value.id) =>
    index.updateGroups(value.id, 'actor', value, 'pvp_party', keys, order);
function check(name, work) { work(); console.log(`PASS ${name}`); }

check('party keys preserve strict companion policy, truthy autonomous id and opaque leader references', () => {
    const session = { coldLifeState: { party: { partyId: 7 } } }, leader = {};
    assert.deepEqual(partyKeys(session), [session, 'party:7']);
    session.partyCompanion = 1; session.followPlayerSession = leader;
    assert.deepEqual(partyKeys(session), [session]);
    session.partyCompanion = true;
    assert.deepEqual(partyKeys(session), [leader]);
    for (const value of [Symbol('leader'), 3n, NaN, 0, null, false]) {
        session.followPlayerSession = value;
        assert.deepEqual(partyKeys(session), value ? [value] : []);
    }
    session.partyCompanion = false;
    for (const value of ['forming', '', 0, null, undefined]) {
        session.coldLifeState.party.partyId = value;
        assert.deepEqual(partyKeys(session), [session]);
    }
    const exactError = new Error('native party id conversion');
    session.coldLifeState.party.partyId = { toString() { throw exactError; } };
    assert.throws(() => partyKeys(session), error => error === exactError);
    assert.throws(() => partyKeys(null), TypeError);
    assert.throws(() => partyKeys(undefined), TypeError);
});

check('every native Map key type retains identity and SameValueZero lookup', () => {
    const index = new Index();
    const keys = [undefined, null, false, true, '', 'party:x', 2, NaN, -0, 1n, Symbol('key'), {}, () => {}];
    keys.forEach((key, n) => {
        const value = record(n + 1);
        index.setSource(value.id, 'actor', value, { indexed: false });
        assert.equal(publish(index, value, [key]), true);
        assert.deepEqual(group(index, key), [value]);
        assert.equal(index.groups.get(key).entries.values().next().value, index.records.get(value.id).actor);
    });
    assert.deepEqual(group(index, +0), group(index, -0));
    assert.deepEqual(group(index, {}), []);
    assert.deepEqual(group(index, Symbol('key')), []);
});

check('all argument validation precedes mutation and duplicate keys use SameValueZero', () => {
    const index = new Index(), value = record(1);
    index.put(value); publish(index, value, ['kept']);
    const bucket = index.groups.get('kept'), metadata = index.records.get(1).actor.groupMembership;
    for (const keys of [null, {}, 'key', [1, 2, 3], [NaN, NaN], [-0, 0], ['a', 'a']]) {
        assert.throws(() => publish(index, value, keys), RangeError);
    }
    for (const order of [0, -1, 1.5, NaN, Infinity, '1', Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => publish(index, value, ['new'], order), RangeError);
    }
    for (const id of [0, -1, 1.5, NaN, '1', Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => index.updateGroups(id, 'actor', value, 'pvp_party', [], 1), RangeError);
    }
    assert.throws(() => index.updateGroups(1, 'state', value, 'pvp_party', [], 1), RangeError);
    assert.throws(() => index.updateGroups(1, 'actor', value, 'other', [], 1), RangeError);
    assert.throws(() => index.groupSources('kept', { view: 'state' }), RangeError);
    assert.throws(() => index.groupSources('kept', { family: 'other' }), RangeError);
    assert.equal(index.groups.get('kept'), bucket);
    assert.equal(index.records.get(1).actor.groupMembership, metadata);
    assert.deepEqual(group(index, 'kept'), [value]);
    assert.deepEqual(index.near(point(), 0), [value]);
});

check('stale expected record is refused before reading key payload', () => {
    const index = new Index(), old = record(1), current = record(1);
    index.put(old); publish(index, old, ['old']); index.put(current); publish(index, current, ['new']);
    let reads = 0;
    const keys = new Proxy([], { get() { reads++; throw new Error('stale key payload read'); } });
    assert.equal(index.updateGroups(1, 'actor', old, 'pvp_party', keys, 1), false);
    assert.equal(index.updateGroups(2, 'actor', old, 'pvp_party', keys, 1), false);
    assert.equal(reads, 0); assert.deepEqual(group(index, 'old'), []);
    assert.deepEqual(group(index, 'new'), [current]);
});

check('bounded key reads and reentrant replacement cannot restore stale metadata', () => {
    const index = new Index(), old = record(1), current = record(1);
    index.put(old); publish(index, old, ['old']);
    const keys = [null];
    Object.defineProperty(keys, 0, { get() {
        index.put(current); publish(index, current, ['current']); return 'stale';
    } });
    keys[Symbol.iterator] = () => { throw new Error('custom key iterator must not run'); };
    assert.equal(publish(index, old, keys), false);
    assert.deepEqual(group(index, 'old'), []); assert.deepEqual(group(index, 'stale'), []);
    assert.deepEqual(group(index, 'current'), [current]);
});

check('same keys and order retain canonical entry, metadata, bucket and Set with zero churn', () => {
    const index = new Index(), value = record(1), leader = {};
    index.put(value); const keys = [leader, 'party:x']; publish(index, value, keys);
    const entry = index.records.get(1).actor, metadata = entry.groupMembership;
    const first = index.groups.get(leader), second = index.groups.get('party:x');
    for (const bucket of [first, second]) {
        for (const method of ['add', 'delete', 'clear']) bucket.entries[method] = () => { throw new Error('unchanged group churn'); };
    }
    keys.length = 0;
    assert.equal(publish(index, value, ['party:x', leader]), true);
    assert.equal(entry.groupMembership, metadata); assert.equal(index.groups.get(leader), first);
    assert.equal(index.groups.get('party:x'), second);
    assert.deepEqual(group(index, leader), [value]); assert.deepEqual(index.near(point(), 0), [value]);
});

check('producer maintains registration order for late joins, order changes and tail removal', () => {
    const index = new Index(), older = record(1), middle = record(2), later = record(3);
    for (const value of [older, middle, later]) index.put(value);
    publish(index, later, ['party'], 30); publish(index, middle, ['party'], 20); publish(index, older, ['party'], 10);
    assert.deepEqual(group(index, 'party'), [older, middle, later]);
    publish(index, older, ['party'], 40);
    assert.deepEqual(group(index, 'party'), [middle, later, older]);
    index.remove(1, older.source);
    const fourth = record(4); index.put(fourth); publish(index, fourth, ['party'], 35);
    assert.deepEqual(group(index, 'party'), [middle, later, fourth]);
    publish(index, later, ['other'], 30);
    assert.deepEqual(group(index, 'party'), [middle, fourth]); assert.deepEqual(group(index, 'other'), [later]);
    publish(index, later, ['party'], 30);
    assert.deepEqual(group(index, 'party'), [middle, later, fourth]); assert.equal(index.groups.has('other'), false);
    const tie = record(5); index.put(tie); publish(index, tie, ['party'], 30);
    assert.deepEqual(group(index, 'party'), [middle, later, tie, fourth], 'equal order preserves existing before new');
});

check('terminal same-source renewal retains group entry and emits only the new wrapper', () => {
    const index = new Index(), value = record(1);
    index.put(value); publish(index, value, ['party']);
    const entry = index.records.get(1).actor, bucket = index.groups.get('party'), metadata = entry.groupMembership;
    const retired = { ...value, retired: true };
    index.setSource(1, 'actor', retired, { indexed: false });
    assert.equal(index.records.get(1).actor, entry); assert.equal(index.groups.get('party'), bucket);
    assert.equal(entry.groupMembership, metadata); assert.deepEqual(group(index, 'party'), [retired]);
    assert.deepEqual(index.near(point(), 0), []);
    assert.equal(publish(index, value, ['old']), false);
    assert.deepEqual(group(index, 'old'), []); assert.deepEqual(group(index, 'party'), [retired]);
});

check('different source replacement, removal and explicit reinsert detach old groups', () => {
    const index = new Index(), old = record(1), current = record(1), peer = record(2), key = {};
    index.put(old); index.put(peer); publish(index, old, [key], 1); publish(index, peer, [key], 2);
    const entry = index.records.get(1).actor;
    index.put(current); assert.equal(index.records.get(1).actor, entry);
    assert.deepEqual(group(index, key), [peer]); publish(index, current, [key], 3);
    assert.deepEqual(group(index, key), [peer, current]);
    assert.equal(index.remove(1, old.source), false); assert.deepEqual(group(index, key), [peer, current]);
    index.remove(2, peer.source); index.remove(1, current.source);
    assert.equal(index.groups.has(key), false); assert.equal(index.groups.size, 0);
    index.put(old); publish(index, old, [key], 4); assert.deepEqual(group(index, key), [old]);
    publish(index, old, [], 4); assert.equal(index.groups.size, 0);
});

check('state publication and reset are independent; actor reset releases all group refs', () => {
    const index = new Index(), actor = record(1), state = record(1, { phase: 'cold', loc: point(12000) });
    index.put(actor); publish(index, actor, ['party']); index.setSource(1, 'state', state);
    index.clearSourceView('state'); assert.deepEqual(group(index, 'party'), [actor]);
    index.setSource(1, 'state', state);
    const beforeActorReset = index.groupSources('party');
    index.clearSourceView('actor'); assert.deepEqual([...beforeActorReset], []);
    assert.equal(index.groups.size, 0); assert.equal(index.getSource(1, 'state'), state);
    assert.deepEqual(index.nearSources(point(12000), 0, { view: 'state' }), [state]);
    index.put(actor); publish(index, actor, ['party']);
    const beforeFullReset = index.groupSources('party'), oldEntry = index.records.get(1).actor;
    index.clear(); assert.deepEqual([...beforeFullReset], []); assert.equal(oldEntry.groupMembership, null);
    assert.equal(index.groups.size, 0); assert.equal(index.records.size, 0);
});

check('group query reads selected refs without geometry, tags, sort or population enumeration', () => {
    const index = new Index(), a = record(1), b = record(2);
    index.put(a); index.put(b); publish(index, a, ['selected']); publish(index, b, ['other']);
    for (const value of [a, b]) for (const field of ['loc', 'phase', 'realPlayer', 'spotId']) {
        Object.defineProperty(value, field, { get() { throw new Error(`group query read ${field}`); } });
    }
    for (const map of [index.records, index.sourceViews.actor, index.sourceViews.state, index.cells, index.spots]) {
        for (const method of ['values', 'entries', Symbol.iterator]) map[method] = () => { throw new Error('global enumeration'); };
    }
    index.groups.get('other').entries[Symbol.iterator] = () => { throw new Error('unrelated group read'); };
    assert.deepEqual(group(index, 'selected'), [a]); assert.deepEqual(group(index, 'absent'), []);
});
