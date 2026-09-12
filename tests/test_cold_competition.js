const assert = require('assert');
const { decide } = require('../src/GameServer/Bot/Population/ColdCompetitionPolicy');
const { ColdCompetitionMonitor, INTERVAL_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const at = 1800000000000;
const memory = new Memory();
const spot = { id: 'test', npcEntries: [{ selfId: 10, count: 1 }] };
const entries = Array.from({ length: 20 }, (_, i) => ({ state: { characterId: i + 1, name: `Bot${i + 1}`, phase: 'cold',
    activity: 'hunting', level: 40, spotId: 'test', vitals: { hp: 100 }, stats: {} }, context: { spot, targetNpcId: 10 } }));
entries.forEach(e => memory.accept(P.empty(e.state.characterId)));
const make = (capacity = 2) => new ColdCompetitionMonitor({ capacityForSpot: () => capacity, personaFor: () => ({ traits: {} }) });
const monitor = make(), pristine = JSON.stringify(entries);
monitor.sample(entries, memory, at);
assert.strictEqual(monitor.snapshot().evaluated, 0, 'bootstrap must not create catch-up encounters');
for (let i = 1; i <= 480; i++) monitor.sample(entries, memory, at + i * INTERVAL_MS);
const report = monitor.snapshot();
assert(report.evaluated > 10, 'congested independent hunters must produce observable decisions');
assert(report.pvpIntents < report.evaluated / 4, 'ordinary pressure must not produce universal PvP intent');
assert(report.recent.length <= 12);
assert(monitor.pairs.size <= 20 && monitor.bots.size <= 20, 'cooldowns must expire rather than retain encounter history forever');
assert.strictEqual(JSON.stringify(entries), pristine);
assert(entries.every(e => memory.snapshot(e.state.characterId).revision === 0), 'forecasts must never write memories');
const crowdedEntries = Array.from({ length: 8 }, (_, ground) => entries.map((e, index) => {
    const id = 100 + ground * 20 + index;
    memory.accept(P.empty(id));
    const crowdedSpot = { ...spot, id: `crowded-${ground}` };
    return { state: { ...e.state, characterId: id, spotId: crowdedSpot.id }, context: { spot: crowdedSpot, targetNpcId: 10 } };
})).flat();
const crowded = make();
let preservedLargeBatch = false;
for (let i = 0; i <= 60; i++) {
    crowded.sample(crowdedEntries, memory, at + i * INTERVAL_MS);
    const current = crowded.snapshot();
    assert(current.sampledPairs <= 32, 'crowd size cannot create unbounded pair enumeration');
    assert(current.events.length <= 32);
    const participants = current.events.flatMap(e => [e.actor.id, e.peer.id]);
    assert.strictEqual(new Set(participants).size, participants.length, 'extra pairs never reuse a busy hunter in the same scan');
    if (current.events.length > 12) {
        preservedLargeBatch = true;
        assert.strictEqual(current.recent.length, 12, 'observer history stays small while delivery retains the entire current scan');
    }
}
assert(preservedLargeBatch, 'large current batches must survive the twelve-row observer history');
const abundant = make(100);
abundant.sample(entries, memory, at); abundant.sample(entries, memory, at + INTERVAL_MS);
assert.strictEqual(abundant.snapshot().pressuredGroups, 0);
const inactive = make();
inactive.sample(entries.map(e => ({ ...e, state: { ...e.state, activity: 'resting' } })), memory, at);
assert.strictEqual(inactive.snapshot().activeHunters, 0);
const teammates = entries.slice(0, 5).map(e => ({ ...e, state: { ...e.state, party: { partyId: 'one-party' }, activity: 'grouped' },
    context: { ...e.context, party: { partyId: 'one-party', status: 'active', spotId: 'test', leaderId: 1,
        memberIds: entries.slice(0, 5).map(e => e.state.characterId), stats: { objective: { npcId: 10 } } } } }));
const party = make(); party.sample(teammates, memory, at);
assert.strictEqual(party.snapshot().pressuredGroups, 0, 'teammates are a single competitor');
const mixed = make();
const mixedEntries = [entries[0], ...teammates.slice(1, 3).map(e => ({ ...e,
    context: { ...e.context, party: { ...e.context.party, memberIds: [2, 3], leaderId: 2, updatedAt: at } } }))];
mixed.sample(mixedEntries, memory, at);
for (let i = 1; i <= 480; i++) mixed.sample(mixedEntries, memory, at + i * INTERVAL_MS);
assert(mixed.snapshot().recent.length > 0);
const lastEncounter = new Map();
const selectedMembers = new Set();
for (const e of mixed.snapshot().recent) {
    const representative = [e.actor, e.peer].find(p => p.partyId === 'one-party');
    assert(representative, 'party identity must survive worker forecast serialization');
    assert.strictEqual(representative.size, 2);
    assert.strictEqual(representative.partyUpdatedAt, at);
    selectedMembers.add(representative.id);
    const lastAt = lastEncounter.get(representative.partyId);
    if (lastAt !== undefined) assert(e.at - lastAt >= 2 * 60000, 'rotating participants must not bypass the party-pair cooldown');
    lastEncounter.set(representative.partyId, e.at);
}
assert.strictEqual(selectedMembers.size, 2, 'actual party members can take turns as principal');
const recoveryEntries = JSON.parse(JSON.stringify(mixedEntries));
recoveryEntries[2].state.activity = 'resting';
recoveryEntries[2].context.party.updatedAt = at - 1000;
recoveryEntries[2].context.party.memberIds = [2];
const recovery = make(1);
for (let i = 0; i <= 60; i++) recovery.sample(recoveryEntries, memory, at + i * INTERVAL_MS);
assert(recovery.snapshot().evaluated > 0);
for (const event of recovery.snapshot().recent) {
    const side = [event.actor, event.peer].find(s => s.partyId);
    assert.strictEqual(side.size, 2, 'nearby resting members remain part of the actual party roster');
    assert.strictEqual(side.activeSize, 1);
    assert.strictEqual(side.id, 2, 'the resting member never initiates a resource encounter');
    assert.strictEqual(side.partyUpdatedAt, at, 'older teammate context cannot overwrite the current roster');
}
for (const change of ['missing', 'distant', 'dead', 'travelling']) {
    const unavailable = JSON.parse(JSON.stringify(recoveryEntries));
    if (change === 'missing') unavailable.pop();
    else if (change === 'distant') unavailable[2].state.spotId = 'elsewhere';
    else if (change === 'dead') unavailable[2].state.vitals.hp = 0;
    else unavailable[2].state.stats.travel = { arrivalAt: at + 600000 };
    const checked = make(1);
    for (let i = 0; i <= 20; i++) checked.sample(unavailable, memory, at + i * INTERVAL_MS);
    assert.strictEqual(checked.snapshot().evaluated, 0, `${change}: do not fabricate a whole party from its active subset`);
    assert(checked.snapshot().skipped.incompleteParty > 0);
}
const recurring = make(1);
for (let i = 0; i <= 20; i++) recurring.sample(entries.slice(0, 2), memory, at + i * INTERVAL_MS);
assert(recurring.snapshot().evaluated > 1 && recurring.snapshot().evaluated <= 5,
    'two ordinary competitors can meet again within ten minutes, with a two-minute pause');
for (const kind of ['solo', 'party', 'member']) {
    const until = at + 30 * 60000;
    const cooling = JSON.parse(JSON.stringify(kind === 'solo' ? entries.slice(0, 2) : mixedEntries));
    if (kind === 'party') cooling.filter(e => e.context.party).forEach(e => {
        e.context.party.stats.coldCompetition = { conflictUntil: until };
    });
    else cooling.at(-1).state.stats.coldCompetition = { conflictUntil: until };
    const guarded = new ColdCompetitionMonitor({ capacityForSpot: () => 0.5,
        personaFor: () => ({ traits: { ambition: 1, assertiveness: 1, caution: 0, empathy: 0, sociability: 0 } }) });
    for (let i = 0; i < 60; i++) guarded.sample(cooling, memory, at + i * INTERVAL_MS);
    assert.strictEqual(guarded.snapshot().outcomes.contest || 0, 0, `${kind}: actual conflict cooldown suppresses new disputes`);
    assert(guarded.snapshot().evaluated > 0, `${kind}: cooling down a conflict still permits peaceful decisions`);
    assert(guarded.snapshot().skipped.conflictCooldown > 0);
    for (let i = 60; i <= 100; i++) guarded.sample(cooling, memory, at + i * INTERVAL_MS);
    assert(guarded.snapshot().outcomes.contest > 0, `${kind}: disputes become possible after the persisted cooldown expires`);
}
const unknown = make(); unknown.sample(entries, new Memory(), at); unknown.sample(entries, new Memory(), at + INTERVAL_MS);
assert.strictEqual(unknown.snapshot().evaluated, 0, 'unloaded memory must not masquerade as neutrality');
const slow = make(), fast = make();
for (let t = at; t <= at + 120000; t += 1000) fast.sample(entries, memory, t);
for (let t = at; t <= at + 120000; t += INTERVAL_MS) slow.sample(entries, memory, t);
assert.deepStrictEqual(fast.snapshot(), slow.snapshot(), 'heartbeat frequency must not multiply encounters');
const actors = { actor: { level: 40, size: 1 }, peer: { level: 40, size: 1 } };
const friendly = { ready: true, personal: { affinity: 30, trust: 30, hostility: 0, fear: 0 } };
assert.strictEqual(decide({ ...actors, pressure: 4, towardPeer: friendly, towardActor: friendly, rng: () => 0 }).action, 'offer_party');
assert.strictEqual(decide({ ...actors, pressure: 1, rng: () => { throw Error('abundant resources must not roll conflict'); } }).action, 'coexist');
const hostile = { ready: true, personal: { affinity: -30, trust: -30, hostility: 30, fear: 0 } };
const aggressive = { traits: { caution: 0, empathy: 0, resilience: 0, ambition: 1, assertiveness: 1 } };
const rolls = [0.99, 0, 0];
const confrontation = decide({ actor: { level: 40, size: 2, partyId: 'a' }, peer: { level: 40, size: 2, partyId: 'b' },
    pressure: 4, actorPersona: aggressive, peerPersona: aggressive, towardPeer: hostile, towardActor: hostile, rng: () => rolls.shift() });
assert.strictEqual(confrontation.action, 'contest');
assert.strictEqual(confrontation.pvpIntent, true, 'hostile assertive peers can produce escalation intent, never a real attack');
const cautious = decide({ actor: { level: 30, size: 2, partyId: 'a' }, peer: { level: 60, size: 5, partyId: 'b' },
    pressure: 4, actorPersona: { traits: { caution: 1 } }, towardPeer: hostile, towardActor: hostile, rng: () => 0 });
assert.strictEqual(cautious.action, 'avoid', 'hostility must still allow avoiding a stronger enemy');
console.log('Cold competition pressure, cooldowns, independent parties, cadence and four-hour observation checks passed',
    JSON.stringify({ evaluated: report.evaluated, outcomes: report.outcomes, pvpIntents: report.pvpIntents }));

// A regular party without an explicit objective hunts its leader's active target.
const ordinaryEntries = mixedEntries.map(e => ({ ...e,
    state: { ...e.state, stats: { equipmentPlan: { status: 'active', next: { npcId: e.state.characterId === 3 ? 11 : 10 } } } },
    context: e.context.party ? { ...e.context, party: { ...e.context.party, stats: {} } } : e.context
}));
const ordinary = make();
for (let i = 0; i < 60; i++) ordinary.sample(ordinaryEntries.slice().reverse(), memory, at + i * INTERVAL_MS);
assert(ordinary.snapshot().evaluated > 0, 'leader fallback supports ordinary parties');
assert(ordinary.snapshot().recent.every(e => e.npcId === 10), 'different representative goals cannot retarget a party');
const completedLeader = ordinaryEntries.map(e => e.state.characterId === 2
    ? { ...e, state: { ...e.state, stats: { equipmentPlan: { status: 'complete', next: { npcId: 10 } } } } } : e);
const finished = make();
finished.sample(completedLeader, memory, at);
assert.strictEqual(require('../src/GameServer/Bot/Population/PartyHuntingTarget').npcId(
    {}, completedLeader.find(e => e.state.characterId === 2).state), 0,
    'a completed plan is not an explicit target');
assert(finished.snapshot().pressuredGroups > 0, 'ordinary hunting remains competitive after a gear goal completes');
