'use strict';
const assert = require('node:assert/strict');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Packed = require('../src/GameServer/Social/PackedInteractionRows');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Aid = require('../src/GameServer/Social/OpponentAidPolicy');
const Help = require('../src/GameServer/Social/CombatHelpPolicy');
const clone = value => JSON.parse(JSON.stringify(value));
const at = 1800000000000;
const normalized = snapshot => clone({ version: snapshot.version, ownerId: snapshot.ownerId,
    revision: snapshot.revision, replayFloor: snapshot.replayFloor, readOnly: true,
    relations: snapshot.relations, recent: [] });
const types = ['hunted_together', 'healed', 'attacked', 'killed', 'helped_in_combat', 'resurrected',
    'aided_opponent', 'party_formed', 'party_wiped', 'crafted_for', 'gift', 'loot_taken'];
const relations = [];
for (let index = 0; index < 64; index++) {
    const row = { kind: 'character', targetId: Number.MAX_SAFE_INTEGER - index, at: at - index,
        affinity: index % 2 ? -19.12345678912345 : 19.12345678912345, trust: index % 2 ? -12 : 12,
        hostility: 8.76543219876543, fear: 0, familiarity: 67.5,
        reasons: Array.from({ length: index % 4 }, (_, slot) => slot % 2
            ? { at: at - index - slot, type: types[(index + slot) % types.length] }
            : { type: types[(index + slot) % types.length], at: at - index - slot }),
        player: true, metadata: { label: '\u0000µ😀', nested: [null, index] },
        undefinedMetadata: undefined };
    if (index % 2) Object.assign(row, { order: index, lastHuntAt: 0, lastAidAt: at - index,
        abandonedAt: 0, lastHelpAt: { healed: 0, resurrected: at - index },
        grudge: 3.141592653589793, gratitude: 0.0000000000123456, gameAt: 0,
        traits: { loyalty: 0.7318239472, resilience: 0.2983145 },
        social: { healed: Number.MAX_SAFE_INTEGER, party_formed: 0 } });
    if (index === 2) row.reasons = [{ type: 'gift', at: 0, detail: { text: 'exact reason extras' } }];
    if (index === 3) Object.defineProperty(row, '__proto__', {
        value: { preserved: true }, enumerable: true, writable: true, configurable: true
    });
    // Accepted public JSON preserves key order, including alternate reason order.
    const keys = Object.keys(row), offset = index % keys.length;
    relations.push(Object.fromEntries([...keys.slice(offset), ...keys.slice(0, offset)].map(key => [key, row[key]])));
}
for (const kind of ['clan', 'alliance']) relations.push({ kind, targetId: 77, at: -0, order: 0,
    affinity: -0, trust: 0, hostility: 0, fear: 0, familiarity: 0, reasons: [], player: false });
const input = { ...Policy.empty(1), revision: 100, relations, readOnly: false,
    metadata: 'snapshot metadata is deliberately absent from the existing public contract' };
Policy.validate(input);
const memory = new Memory();
assert.equal(memory.accept(input), true);
const expected = normalized(input);
assert.deepEqual(memory.snapshot(1), expected);
assert.equal(JSON.stringify(memory.snapshot(1)), JSON.stringify(expected), 'all public key/row/reason order is exact');
assert.equal(memory.views.get(1).characterIds.length, 64, 'protected player rows have no new truncation');
assert(Object.is(memory.snapshot(1).relations.at(-1).affinity, 0));
const expectedView = Policy.view(expected);
for (const hours of [undefined, 0, 4.25, 24, 168]) {
    memory.playingHours = () => hours;
    const reference = Policy.view(expected, () => hours);
    for (const time of [0, at, at + 1800000, at + 7 * 86400000]) {
        for (const row of expected.relations) {
            const actual = memory.views.get(1).relation(row.kind, row.targetId, time);
            assert.deepEqual(actual, reference.relation(row.kind, row.targetId, time));
            assert.equal(Aid.eligible(actual, time), Aid.eligible(reference.relation(row.kind, row.targetId, time), time));
            for (const type of Help.TYPES) assert.equal(Help.eligible(actual, type, time),
                Help.eligible(reference.relation(row.kind, row.targetId, time), type, time));
        }
    }
}
memory.playingHours = () => undefined;
for (const target of [Number.MAX_SAFE_INTEGER, `${Number.MAX_SAFE_INTEGER}`, BigInt(Number.MAX_SAFE_INTEGER),
    { toString: () => `${Number.MAX_SAFE_INTEGER}` }, `0${Number.MAX_SAFE_INTEGER}`, ' 77', undefined, null]) {
    assert.deepEqual(memory.views.get(1).relation('character', target, at), expectedView.relation('character', target, at));
}
for (const row of expected.relations) {
    const source = { id: 1, partyId: 'native' };
    const target = { id: row.targetId, clanId: 77, allianceId: 77, partyId: 'native' };
    const context = { attackingMe: true };
    const reference = Policy.assess(expectedView, source, target, context, at);
    assert.deepEqual(memory.assess(source, target, context, at), { ...reference, sourceClanId: 0, targetClanId: 77 });
}

const exported = memory.snapshot(1);
exported.relations[0].hostility = 99;
exported.relations[0].metadata.nested[1] = -1;
exported.relations.splice(1, 1);
assert.deepEqual(memory.snapshot(1), expected, 'mutable exported plain snapshots cannot mutate private rows');
const result = memory.views.get(1).relation('character', Number.MAX_SAFE_INTEGER - 1, at);
result.social.healed = 0; result.lastHelpAt.healed = 9;
result.reasons[0].type = 'gift';
assert.deepEqual(memory.snapshot(1), expected, 'public policy copies remain mutable and isolated');
input.relations[0].hostility = 98; input.relations[0].metadata.nested[1] = -2;
assert.deepEqual(memory.snapshot(1), expected, 'accepted input objects are detached');
assert.equal(memory.accept({ ...input, revision: 99 }), false);
assert.equal(memory.accept({ ...input, revision: 100 }), false);
assert.throws(() => new Memory().accept({ ...input, revision: 101,
    relations: [{ ...input.relations[0], reasons: [{ type: 'unknown reason', at }] }] }), /invalid reason/);

// The private codec also has a lossless fallback for future/unusual rows. The
// public accept validator retains its existing rejection of unsupported types.
for (const reasons of [[{ type: 'futureµ😀type', at, detail: [1, 2] }],
    Array.from({ length: 4 }, (_, index) => ({ type: 'gift', at: at - index })),
    [{ type: 'gift', at, detail: { nested: true } }], [null, { at, type: 'gift' }]]) {
    const original = { ...input, relations: [{ ...clone(expected.relations[0]), reasons }] };
    const packed = new Packed(original);
    assert.deepEqual(packed.plain(), normalized(original));
    assert.equal(JSON.stringify(packed.plain()), JSON.stringify(normalized(original)));
}

// Existing policy results shallow-copy unusual reason metadata. Keep that
// observable alias through the fallback, while snapshots themselves deep-copy.
const unusual = { ...Policy.empty(900), revision: 1, relations: [{ kind: 'character', targetId: 901, at,
    affinity: 0, trust: 0, hostility: 0, fear: 0, familiarity: 0,
    reasons: [{ type: 'gift', at, detail: { value: 1 } }] }] };
const unusualReference = normalized(unusual), unusualMemory = new Memory();
unusualMemory.accept(unusual);
Policy.view(unusualReference).relation('character', 901, at).reasons[0].detail.value = 2;
unusualMemory.views.get(900).relation('character', 901, at).reasons[0].detail.value = 2;
assert.deepEqual(unusualMemory.snapshot(900), unusualReference);

// Episodes still use the authoritative plain reducer and exact replay journal.
let source = Policy.empty(500);
const evolving = new Memory();
for (let index = 0; index < 120; index++) {
    const event = { key: `packed:${index}`, sourceId: 500, targetId: 501 + index % 4,
        type: types[index % types.length], at: at + index * 1800001,
        playedHours: index / 4, hours: 0.5, traits: { loyalty: 0.6, resilience: 0.3 } };
    const applied = Policy.apply(source, event, event.at);
    source = applied.snapshot;
    evolving.acceptCommitted({ snapshots: [source], statuses: [applied.status] }, [event]);
    const plain = normalized(source), fast = evolving.fastLayers.get(500);
    const reference = Policy.view(plain, () => event.playedHours, fast);
    evolving.playingHours = () => event.playedHours;
    assert.deepEqual(evolving.snapshot(500), { ...plain, ...(fast ? { fast: clone([...fast]) } : {}) });
    for (const row of source.relations) assert.deepEqual(evolving.views.get(500).relation(row.kind, row.targetId, event.at),
        reference.relation(row.kind, row.targetId, event.at));
    assert.equal(Policy.apply(source, event, event.at).status, 'duplicate');
}
assert(evolving.inspect(500, at + 120 * 1800001).ready);
evolving.forget(500);
assert.equal(evolving.snapshot(500), null);
assert.deepEqual(evolving.size(), { snapshots: 0, views: 0, fastLayers: 0, loading: 0 });
console.log('Packed memory: exact JSON/order/optional fields/full precision/player retention/mutation/cooldowns/fallback/replay/layer updates/removal PASS');
