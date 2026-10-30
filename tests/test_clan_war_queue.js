const assert = require('assert');
require('../src/Global');
const { ClanWarDirector } = require('../src/GameServer/Clan/ClanWarDirector');
const { PartyAdmission } = require('../src/GameServer/Bot/Population/PartyAdmission');
const View = require('../src/GameServer/Clan/ClanWarView');
const Config = require('../src/GameServer/Clan/ClanWarConfig');
const AT = 1800000000000;

async function fixture(count = 2, membersPerClan = 3) {
    const admission = new PartyAdmission(), view = new View(), states = new Map(), clans = new Map(), parties = [];
    const counters = { writes: 0, reads: 0, forms: 0, reviews: 0 };
    const f = { admission, view, states, clans, parties, counters, allowed: false, failFormation: false, now: AT,
        config: { maxBackgroundParties: 2 } };
    for (let n = 0; n < count; n++) {
        const id = 10 + n, enemy = 10 + (n ^ 1), members = [];
        for (let m = 0; m < membersPerClan; m++) {
            const characterId = id * 100 + m;
            members.push({ id: characterId });
            states.set(characterId, { characterId, accountName: 'bot_queue', name: `QueueFighter${characterId}`, phase: 'cold',
                activity: 'hunting', level: 60, spotId: 'home', loc: { locX: 1, locY: 2, locZ: 3 },
                vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, stats: { clanId: id, classId: m ? 0 : 15 } });
        }
        clans.set(id, { id, members, leaderId: members[0].id });
        view.accept({ fromClanId: id, toClanId: enemy, active: 1, revision: n + 1, declaredAt: AT });
    }
    const director = new ClanWarDirector({
        database: { fetchClanWarPlans: async () => [], execute: async () => { counters.reads++; return [...clans.keys()].map(clanId => ({ clanId })); },
            saveClanWarPlan: async (clanId, revision) => { counters.writes++; return { ok: true, row: { revision: revision + 1 } }; } },
        life: { cachedState: id => states.get(id), subscribePublications: listener => {
            for (const characterId of states.keys()) listener({ characterId }); return () => {};
        } },
        parties: { active: () => parties, admitted: () => parties },
        clans: { all: () => [...clans.values()], findById: id => clans.get(id), membershipRevision: () => 1 },
        war: { view, refresh: async () => {} },
        updateDemand: ids => admission.syncWarRequests(ids), canWork: () => f.allowed, now: () => f.now,
        form: async (members, operation) => {
            counters.forms++;
            const release = admission.reserveWar(parties, f.config, operation.clanId, f.now);
            if (!release) return null;
            try {
                if (f.failFormation) return null;
                const party = { partyId: `party-${operation.clanId}`, status: 'active', memberIds: members.map(s => s.characterId),
                    stats: { warOperation: operation } };
                parties.push(party);
                for (const state of members) state.partyId = party.partyId;
                return party;
            } finally { release(); }
        }
    });
    await director.start();
    for (const [id] of clans) director.plans.set(id, { revision: 0, nextReviewAt: AT + 3600000,
        intel: [{ enemyClanId: 10 + ((id - 10) ^ 1), spotId: 'enemy-farm', loc: { locX: 10, locY: 20, locZ: 3 }, at: AT, observerId: id * 100 }] });
    director.review = async () => { counters.reviews++; };
    director.maintain = async () => {};
    f.director = director;
    f.pulse = async (time = f.now + 5000) => { f.now = time; await director.pulse(time); };
    f.ordinary = () => admission.reserve(parties, f.config, { now: f.now });
    return f;
}
async function run() {
    const f = await fixture();
    f.parties.push({ stats: {}, memberIds: [] }, { stats: {}, memberIds: [] });
    await f.pulse();
    const queuedAt = f.director.inspect().assembly.queue[0].queuedAt;
    for (let n = 0; n < 60; n++) await f.pulse();
    assert.equal(f.counters.forms, 0, 'load admission forbids heavy formation');
    assert.equal(f.counters.reads, 1, 'cached waiting does not read SQLite after startup');
    assert.equal(f.counters.writes, 0, 'waiting does not persist repeated campaign plans');
    assert.equal(f.director.inspect().assembly.queue[0].queuedAt, queuedAt, 'ready priority survives five minutes of delayed reviews');
    f.parties.pop();
    assert.equal(f.ordinary(), null, 'ordinary recruitment cannot reclaim the promised free slot after one minute');
    f.allowed = true;
    f.director.review = async () => { f.counters.reviews++; f.allowed = false; };
    await f.pulse();
    assert.equal(f.counters.forms, 1, 'the army is attempted before diplomacy can consume admission');
    assert.equal(f.parties.filter(p => p.stats.warOperation).length, 1);
    assert.equal(f.parties.at(-1).stats.warOperation.clanId, 10, 'FIFO chooses the oldest clan');
    assert.equal(f.director.inspect().assembly.queue.length, 1, 'only one formation attempt per five-second tick');
    f.parties.shift(); f.allowed = true;
    await f.pulse();
    assert.equal(f.parties.filter(p => p.stats.warOperation).length, 2, 'the second clan uses the next naturally free slot');
    assert.equal(f.admission.pending, 0);
    f.director.stop();

    const full = await fixture(); full.allowed = true;
    full.parties.push(...[1, 2].map(() => ({ memberIds: [], stats: { objective: { priority: 'required' } } })));
    await full.pulse();
    assert.equal(full.counters.forms, 1, 'a full budget permits only one cheap admission attempt, not one per clan');
    assert.equal(full.counters.writes, 0); assert.equal(full.parties.length, 2, 'required parties are never evicted');
    assert.equal(full.director.inspect().assembly.queue.length, 2);
    assert(!full.admission.canReclaim(full.parties, full.config), 'waiting armies cannot cause futile reclamation for an ordinary request');
    full.parties.pop(); assert.equal(full.ordinary(), null); full.director.stop();
    full.parties.push({ memberIds: [], stats: {} });
    assert(full.admission.canReclaim(full.parties, full.config), 'normal required-party reclamation resumes when military demand is gone');

    const retry = await fixture(); retry.allowed = true; retry.failFormation = true;
    await retry.pulse();
    assert.deepEqual([...retry.admission.warWaiters.keys()], [10, 11], 'a refused native formation retains the original FIFO');
    retry.states.get(1000).vitals.hp = 0;
    retry.allowed = false; await retry.pulse();
    assert.deepEqual([...retry.admission.warWaiters.keys()], [11], 'losing the healer releases demand even while workers are busy');
    retry.view.accept({ fromClanId: 11, toClanId: 10, active: 0, revision: 3, declaredAt: AT });
    await retry.pulse();
    assert.equal(retry.admission.warWaiters.size, 0, 'war withdrawal releases both demands without SQL admission');
    const release = retry.ordinary(); assert.equal(typeof release, 'function'); release(); retry.director.stop();

    const stale = await fixture(); await stale.pulse();
    await stale.pulse(AT + Config.intelTtlMs + 1);
    assert.equal(stale.admission.warWaiters.size, 0, 'expired sightings cannot reserve slots'); stale.director.stop();

    const disabled = await fixture(); await disabled.pulse();
    const wasEnabled = Config.enabled;
    try { Config.enabled = false; await disabled.pulse(); assert.equal(disabled.admission.warWaiters.size, 0); }
    finally { Config.enabled = wasEnabled; disabled.director.stop(); }
    const stopped = await fixture(); await stopped.pulse(); stopped.director.stop();
    assert.equal(stopped.admission.warWaiters.size, 0, 'shutdown releases managed demand');

    const stopping = await fixture(); stopping.allowed = true;
    let finish;
    stopping.director.form = () => new Promise(resolve => { finish = resolve; });
    const pending = stopping.pulse(); stopping.director.stop(); finish(null); await pending;
    assert.equal(stopping.admission.warWaiters.size, 0, 'an async formation result cannot restore priority after shutdown');

    const many = await fixture(40, 40);
    let peak = 0, total = 0;
    for (let n = 0; n < 120; n++) {
        await many.pulse();
        const metrics = many.director.inspect().assembly;
        assert(metrics.checks <= 8, 'each tick checks at most four waiting and four other clans');
        assert(metrics.queue.length <= Config.maxActiveOperations);
        peak = Math.max(peak, metrics.refreshMs); total += metrics.refreshMs;
    }
    assert.equal(many.counters.reads, 1); assert.equal(many.counters.writes, 0); assert.equal(many.counters.forms, 0);
    // Existing operations can consume global military capacity between ticks.
    many.parties.push(...Array.from({ length: 4 }, (_, n) => ({ stats: { warOperation: { clanId: 100 + n } } })));
    await many.pulse(); assert.equal(many.admission.warWaiters.size, 0); many.director.stop();

    const a = new PartyAdmission(), cap = { maxBackgroundParties: 1 };
    a.syncWarRequests([10]); const inFlight = a.reserveWar([], cap, 10, AT);
    assert(inFlight); a.syncWarRequests([11]);
    assert.equal(a.reserveWar([], cap, 11, AT + 1), null, 'persistent priority still counts in-flight native commits');
    inFlight(); a.syncWarRequests([]);
    assert.equal(a.warWaiters.size, 0);
    console.log(`Military queue: five-second retry, durable ready priority, FIFO, shared cap, load admission, cancellation and bounded cached work passed (40 clans / 1600 members: mean ${(total / 120).toFixed(3)} ms, peak ${peak.toFixed(3)} ms)`);
}
run().catch(error => { console.error(error); process.exitCode = 1; });
