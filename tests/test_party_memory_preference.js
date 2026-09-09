const assert = require('assert');
require('../src/Global');
const Composition = require('../src/GameServer/Bot/Population/BackgroundPartyComposition');
const Preference = require('../src/GameServer/Bot/Population/PartyMemoryPreference');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const at = Date.now();
const memory = new Memory();
const bot = (characterId, role = 'buffer', level = 20) => ({ characterId, level, party: { role } });
const anchor = bot(1, 'tank'), stranger = bot(2), friend = bot(3);
let snapshot = Policy.apply(Policy.empty(1), { key: 'hunt', sourceId: 1, targetId: 3, type: 'hunted_together', at }, at).snapshot;
memory.accept(snapshot);
const options = { maxSize: 2, memory, timestamp: at };
assert.deepStrictEqual(Composition.selectRecruits([anchor], [stranger, friend], options).map(x => x.characterId), [3],
    'an existing member remembering the candidate must affect recruitment even when the candidate has no loaded memory');
assert.deepStrictEqual(Composition.selectMembers([stranger, friend, anchor], options).map(x => x.characterId).sort(), [1, 3],
    'formation must compare relationship scores across equally suitable anchor groups');
snapshot = Policy.apply(snapshot, { key: 'attack', sourceId: 1, targetId: 3, type: 'attacked', at: at + 1 }, at + 1).snapshot;
memory.accept(snapshot);
friend.stats = { partyHistory: { 1: { runs: 100000 } } };
assert.deepStrictEqual(Composition.selectRecruits([anchor], [friend, stranger], { ...options, timestamp: at + 1 }).map(x => x.characterId), [2],
    'a personal grievance must override the old count of shared parties');
assert.deepStrictEqual(Composition.selectRecruits([anchor], [friend], options).map(x => x.characterId), [3],
    'negative memories are preferences, not a hard veto on required support');
assert.deepStrictEqual(Composition.selectRecruits([anchor], [bot(4, 'buffer', 40)], options), [],
    'memory must not bypass the level filter');
const empty = new Memory();
assert.strictEqual(Preference.create({ memory: empty, timestamp: at }).score(anchor, [friend]), 0);
let calls = 0;
const cached = Preference.create({ timestamp: at, memory: { assess(...args) { calls++; return memory.assess(...args); } } });
cached.score(anchor, [friend]); cached.score(friend, [anchor]); cached.groupScore([anchor, friend]);
assert.strictEqual(calls, 2, 'each directed pair is evaluated only once per selection');
const support = bot(5, 'healer');
assert.deepStrictEqual(Composition.selectRecruits([anchor], [bot(6, 'dps'), support], options).map(x => x.characterId), [5]);
const existing = [anchor, support, bot(7)];
const first = bot(20, 'dps'), rival = bot(21, 'dps'), neutral = bot(22, 'dps');
first.stats = { partyHistory: { 1: { runs: 10 } } };
rival.stats = { partyHistory: { 1: { runs: 9 } } };
memory.accept(Policy.apply(Policy.empty(20), { key: 'rival', sourceId: 20, targetId: 21, type: 'attacked', at }, at).snapshot);
assert.deepStrictEqual(Composition.selectRecruits(existing, [rival, neutral, first], { ...options, maxSize: 5 }).map(x => x.characterId), [20, 22],
    'the second recruit must be scored against the first recruit as well as existing members');
const clanAnchor = { ...anchor, clanId: 10 }, clanPeer = { ...stranger, clanId: 10 };
assert.deepStrictEqual(Composition.selectRecruits([clanAnchor], [friend, clanPeer], options).map(x => x.characterId), [2]);
const nowScore = Preference.create({ memory, timestamp: at + 1 }).score(anchor, [friend]);
const laterScore = Preference.create({ memory, timestamp: at + 1 + 7 * 86400000 }).score(anchor, [friend]);
assert(Math.abs(laterScore - nowScore / 2) < 1e-8, 'selection respects memory decay');
console.log('Party memory formation, recruitment, asymmetric feelings, fallback and scoring cache checks passed');
