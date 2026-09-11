const assert = require('assert');
require('../src/Global');
const fixture = require('./fixtures/cold_reencounter.json');
const Policy = require('../src/GameServer/Social/InteractionMemoryPolicy');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const Runtime = invoke('GameServer/Social/InteractionMemoryRuntime');
const Persona = invoke('GameServer/Bot/AI/BotPersona');
const { decide } = require('../src/GameServer/Bot/Population/ColdCompetitionPolicy');
const { reaction } = require('../src/GameServer/Bot/Population/ColdPartyConflict');
const { seeded, ColdCompetitionMonitor, INTERVAL_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionMonitor');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Preference = require('../src/GameServer/Bot/Population/PartyMemoryPreference');
const HotCompetition = invoke('GameServer/Bot/AI/BotMobCompetition');
const ResourceCompetition = require('../src/GameServer/Social/ResourceCompetitionPolicy');
const clone = value => JSON.parse(JSON.stringify(value));
const COOLDOWN = 600001;
const SAMPLES = 20000;
const timestamp = fixture.capturedAt + 9 * COOLDOWN;

function variants(c) {
    const after = clone(c.snapshots);
    after.forEach(Policy.validate);
    const affected = new Set(c.events.map(e => `${e.sourceId}:${e.targetId}`));
    // Remove only this encounter's directed grievances. Preserve teammates'
    // bonds and all other selected relationships in every comparison.
    const neutral = after.map(s => ({ ...clone(s), relations: s.relations.filter(r => !affected.has(`${s.ownerId}:${r.targetId}`)) }));
    const repeated = clone(after);
    for (let repeat = 1; repeat <= 7; repeat++) for (const e of c.events) {
        const at = fixture.capturedAt + repeat * COOLDOWN;
        const index = repeated.findIndex(s => s.ownerId === e.sourceId);
        const result = Policy.apply(repeated[index], { ...e, key: `reencounter:${c.name}:${repeat}:${e.sourceId}:${e.targetId}`, at }, at);
        assert.strictEqual(result.status, 'applied');
        repeated[index] = result.snapshot;
    }
    return { neutral, one: after, repeated };
}

function hydrate(c, snapshots) {
    const kernel = new ColdSimulationKernel({ now: () => timestamp, resolveSolo: () => ({}) });
    for (const s of snapshots) {
        Runtime.forget(s.ownerId);
        Runtime.accept(s);
        // Exercise the actual main-to-worker memory projection and receiver.
        const state = c.states.find(state => state.characterId === s.ownerId);
        kernel.upsert(clone({ state: { ...state, phase: 'cold', activity: 'hunting' },
            context: { interactionMemory: Runtime.snapshot(s.ownerId) } }));
    }
    for (const a of c.states) for (const b of c.states) if (a !== b) {
        const source = { id: a.characterId }, target = { id: b.characterId };
        assert.deepStrictEqual(kernel.interactionMemory.assess(source, target, {}, timestamp),
            Runtime.assess(source, target, {}, timestamp), 'main and worker must assess the same transported memories');
        const persona = Persona.generate(a);
        const relation = kernel.interactionMemory.assess(source, target, {}, timestamp);
        const chance = HotCompetition.attackChance({ actor: { fetchId: () => a.characterId }, persona },
            { fetchId: () => b.characterId }, timestamp);
        assert.strictEqual(chance, ResourceCompetition.escalationChance(persona, relation), 'hot reactions use the same escalation probability as cold forecasts');
        // Reach the accepted-contest branch without cooperation, retreat or
        // a different instigator consuming RNG before the response under test.
        for (const roll of [0, Math.max(0, chance - 0.000001), chance, 0.999]) {
            const rolls = [0.99, 0, roll];
            const forecast = decide({ pressure: 3, actor: { level: 40, size: 2, partyId: 'a' },
                peer: { level: 40, size: 2, partyId: 'b' }, actorPersona: { traits: { assertiveness: 1, ambition: 1, caution: 0, empathy: 0 } },
                peerPersona: persona, towardPeer: { ready: true }, towardActor: relation, rng: () => rolls.shift() });
            assert.strictEqual(forecast.action, 'contest');
            assert.strictEqual(forecast.pvpIntent, roll < chance, 'identical memory, persona and roll produce identical escalation intent');
        }
    }
    return kernel.interactionMemory;
}

function unit(c, side) {
    const ids = c.groups[side];
    return { id: ids[0], size: ids.length, partyId: ids.length > 1 ? `fixture-${side}` : null,
        level: ids.reduce((n, id) => n + c.states.find(s => s.characterId === id).level, 0) / ids.length };
}

function distribution(c, memory, reverse) {
    const actor = unit(c, reverse ? 1 : 0), peer = unit(c, reverse ? 0 : 1);
    const actorPersona = Persona.generate(c.states.find(s => s.characterId === actor.id));
    const peerPersona = Persona.generate(c.states.find(s => s.characterId === peer.id));
    const towardPeer = memory.assess({ id: actor.id }, { id: peer.id }, {}, timestamp);
    const towardActor = memory.assess({ id: peer.id }, { id: actor.id }, {}, timestamp);
    const counts = { offer_party: 0, accepted: 0, contest: 0, avoid: 0, yield: 0, pvpIntent: 0 };
    const decisions = [];
    for (let seed = 0; seed < SAMPLES; seed++) {
        const result = decide({ pressure: 3, actor, peer, actorPersona, peerPersona, towardPeer, towardActor,
            rng: seeded(`repeat:${seed}`) });
        counts[result.action]++;
        counts.accepted += Number(result.accepted === true);
        counts.pvpIntent += Number(result.pvpIntent === true);
        decisions.push(result);
    }
    return { counts, decisions, disposition: towardPeer.disposition };
}

function monitorReplay(c, memory) {
    const monitor = new ColdCompetitionMonitor({ capacityForSpot: () => c.states.length / 3, personaFor: Persona.generate });
    const spot = { id: c.spotId, npcEntries: [{ selfId: c.npcId, count: 1 }] };
    const entries = c.states.map(s => {
        const side = c.groups.findIndex(ids => ids.includes(s.characterId)), u = unit(c, side);
        const party = u.partyId ? { partyId: u.partyId, memberIds: c.groups[side], leaderId: c.groups[side][0],
            status: 'active', spotId: c.spotId, updatedAt: timestamp, stats: { objective: { npcId: c.npcId } } } : null;
        return { state: { ...s, phase: 'cold', activity: party ? 'grouped' : 'hunting', spotId: c.spotId,
            vitals: { hp: 100 }, party: { partyId: party?.partyId || null } },
        context: { spot, party, targetNpcId: c.npcId } };
    });
    const decisions = new Map();
    for (let scan = 0; scan <= 1440; scan++) {
        const at = timestamp + scan * INTERVAL_MS;
        monitor.sample(entries, memory, at);
        for (const e of monitor.snapshot().recent.filter(e => e.at === at)) decisions.set(e.key, { action: e.action, accepted: e.accepted });
    }
    return decisions;
}

function run() {
    const original = JSON.stringify(fixture);
    const report = { source: fixture.source, samplesPerDirection: SAMPLES, pressure: 3, cases: [] };
    for (const c of fixture.cases) {
        const versions = variants(c), runs = {}, memories = {};
        for (const [name, snapshots] of Object.entries(versions)) {
            const memory = memories[name] = hydrate(c, snapshots);
            const before = c.states.map(s => memory.snapshot(s.characterId));
            runs[name] = { forward: distribution(c, memory, false), victimInitiates: distribution(c, memory, true) };
            assert.deepStrictEqual(c.states.map(s => memory.snapshot(s.characterId)), before, 'decisions alone cannot create more grievances');
        }
        const counts = name => runs[name].victimInitiates.counts;
        assert.strictEqual(runs.neutral.victimInitiates.disposition, 'unknown');
        assert.strictEqual(runs.one.victimInitiates.disposition, 'wary');
        assert.strictEqual(runs.repeated.victimInitiates.disposition, 'hostile');
        assert(counts('one').contest > counts('neutral').contest, 'one remembered offense must affect actual decisions');
        assert(counts('repeated').contest > counts('one').contest);
        assert(counts('repeated').avoid > counts('neutral').avoid, 'hostility can also increase avoidance');
        assert(counts('repeated').contest < SAMPLES * 0.8, 'remembered enemies can compete more often while retaining peaceful alternatives');
        assert(counts('repeated').pvpIntent < SAMPLES * 0.45, 'even repeated resource conflicts usually stop short of PvP');
        if (c.name === 'solo') {
            assert(counts('one').accepted < counts('neutral').accepted);
            assert(counts('repeated').accepted < counts('one').accepted);
        }
        const a = c.states.find(s => s.characterId === c.groups[0][0]), b = c.states.find(s => s.characterId === c.groups[1][0]);
        const scores = Object.fromEntries(Object.entries(memories).map(([name, memory]) => [name, Preference.create({ memory, timestamp }).score(b, [a])]));
        assert(scores.neutral > scores.one && scores.one > scores.repeated, 'ordinary recruitment preference must read the same memory');
        const neutralMonitor = monitorReplay(c, memories.neutral), hostileMonitor = monitorReplay(c, memories.repeated);
        assert.deepStrictEqual([...neutralMonitor.keys()], [...hostileMonitor.keys()], 'same encounters and principals are compared');
        const changedForecasts = [...neutralMonitor].filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(hostileMonitor.get(key))).length;
        assert(changedForecasts > 0, 'memory must reach the real worker encounter monitor');
        const firstDifference = runs.one.victimInitiates.decisions.findIndex((v, index) =>
            JSON.stringify(v) !== JSON.stringify(runs.neutral.victimInitiates.decisions[index]));
        assert(firstDifference >= 0);
        report.cases.push({ name: c.name, rememberedBy: b.name, opponent: a.name, scores, changedForecasts,
            distributions: Object.fromEntries(Object.entries(runs).map(([name, value]) => [name, {
                victimInitiates: value.victimInitiates.counts, aggressorInitiates: value.forward.counts }])),
            example: { seed: firstDifference, before: runs.neutral.victimInitiates.decisions[firstDifference], after: runs.one.victimInitiates.decisions[firstDifference] } });
        if (c.name === 'party') {
            const principal = b, opponent = a;
            for (const id of c.groups[1].slice(1)) {
                const member = c.states.find(s => s.characterId === id);
                const involved = c.events.some(e => e.sourceId === id);
                const reactions = Object.fromEntries(Object.entries(memories).map(([name, memory]) => [name,
                    Array.from({ length: 2000 }, (_, i) => reaction(member, principal, opponent, memory, Persona.generate, seeded(`support:${i}`), timestamp))]));
                if (!involved) {
                    assert.deepStrictEqual(reactions.neutral, reactions.repeated, 'a bystander must not inherit its party mate\'s feud');
                    assert.deepStrictEqual(memories.neutral.assess({ id }, { id: opponent.characterId }, {}, timestamp).personal,
                        memories.repeated.assess({ id }, { id: opponent.characterId }, {}, timestamp).personal);
                } else {
                    assert(reactions.repeated.filter(r => r === 'support').length > reactions.neutral.filter(r => r === 'support').length,
                        'a defending supporter remembers the instigator at the next encounter');
                }
            }
        }
    }
    assert.strictEqual(JSON.stringify(fixture), original, 'saved evidence remains immutable');
    return report;
}

// Running this test never opens the live database, even if the working config
// points at a server. A new accidental repository call must fail immediately.
const Database = invoke('Database');
Database.execute = () => { throw new Error('reencounter test must not access SQL'); };
const report = run();
if (process.argv.includes('--report')) console.log(JSON.stringify(report, null, 2));
else console.log('Cold reencounters: real episode fixtures, paired seeds, monitor decisions, party preferences, bystanders and main/worker assessment parity passed');
