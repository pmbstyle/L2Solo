const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Assembly = require('../src/GameServer/Bot/Population/PartyHuntingAssembly');
const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
const Requests = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const Duty = require('../src/GameServer/Bot/Population/ClanPartyDuty');
const at = Date.now(), minute = 60000;
const spot = { id: '24_20:antharas_lair' };
const objective = { status: 'open', priority: 'required', objectiveKey: 'drop:test', spotId: spot.id, npcId: 621 };
const party = { partyId: 'scattered', leaderId: 1, memberIds: [1, 2, 3], spotId: spot.id,
    status: 'active', startedAt: at - 10 * minute, stats: { objective } };
const here = { locX: 145224, locY: 120001, locZ: -4500 }, far = { locX: 48000, locY: 120001, locZ: -4500 };
const members = [1, 2, 3].map(id => ({ characterId: id, name: `Hunter${id}`, phase: 'cold', activity: 'grouped',
    level: 55, party: { partyId: party.partyId, leaderId: 1 }, spotId: spot.id, loc: id === 3 ? far : { ...here },
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 }, timing: {}, inventory: {},
    stats: { classId: 1, role: 'dps', equipmentPlan: { status: 'active', strategy: 'direct_drop', requiresParty: true,
        target: { selfId: 91 }, next: { spotId: spot.id, npcId: 621 } } } }));
const resolve = (roster, timestamp, p = party) => Resolver.resolve({ party: p, members: roster, spot, timestamp,
    rng: () => { throw Error('remote combat'); } });

// A member on its way: the party steps at its arrival, no poll before it, nobody leaves.
const arrivalAt = at + 3 * minute;
const onTheWay = members.map(s => s.characterId === 3 ? { ...s, activity: 'traveling',
    stats: { ...s.stats, travel: { reason: 'party_spot_replan', spotId: spot.id, arrivalAt } } } : s);
const waiting = resolve(onTheWay, at);
assert.strictEqual(waiting.debug.reason, 'party_assembling');
assert.strictEqual(waiting.nextResolveAt, arrivalAt, 'the assembly steps at its member\'s known end');
assert(waiting.memberResults.every(entry => entry.result.nextResolveAt === arrivalAt && entry.result.materialize.exp === 0));
assert.strictEqual(waiting.assemblyAbsent, undefined);
assert.strictEqual(waiting.partyPatch.stats.assemblyAt, arrivalAt);

// Nothing brings the far member (no trip, off the ground): it alone leaves, the party goes on.
const timestamp = arrivalAt;
const stranded = resolve(members, timestamp, { ...party, stats: { ...party.stats, assemblyAt: arrivalAt } });
assert.deepStrictEqual(stranded.assemblyAbsent, [3]);
assert.notStrictEqual(stranded.partyPatch.status, 'dissolved');
const review = Lifecycle.release(party, members, new Map(stranded.assemblyAbsent.map(id => [id, Assembly.REASON])), timestamp,
    { partyMinSize: 2 });
assert.notStrictEqual(review.party.status, 'dissolved', 'the gathered members keep their party');
assert.deepStrictEqual(review.party.memberIds, [1, 2]);
const leaver = review.states.find(s => s.characterId === 3);
assert(!leaver.party.partyId && leaver.activity === 'hunting' && leaver.timing.nextResolveAt === timestamp + 30000);
assert.deepStrictEqual(leaver.vitals, members[0].vitals);
// The assembly gave up on it: its request is closed, held until its next build.
assert(Requests.closed(leaver));
assert.strictEqual(leaver.stats.partyRequest.lastReason, Assembly.REASON);
assert.strictEqual(Requests.partyObjectiveForState(leaver), null);
assert.strictEqual(Duty.waiting({ ...leaver, stats: { ...leaver.stats,
    clanPartyObjective: { ...objective, clanGoalKey: 'clan-goal' } } }), false);
assert.deepStrictEqual(Composition.selectMembers([leaver], { timestamp, minSize: 1 }), []);
// Its next build asks again (no clock reopens it).
assert.strictEqual(Requests.partyRequestForPlan(leaver, members[0].stats.equipmentPlan,
    timestamp + 1, { economy: { worth: () => 0 } }).status, 'open');
// Of two, one stranded: under the minimum the party dissolves (party_min_size).
const pair = { ...party, memberIds: [1, 3] };
const pairReview = Lifecycle.release(pair, [members[0], members[2]], new Map([[3, Assembly.REASON]]), timestamp, { partyMinSize: 2 });
assert.strictEqual(pairReview.party.status, 'dissolved');

// A raid roster starts only whole: a member nothing brings ends it.
const raidParty = { ...party, stats: { objective: { ...objective, sourceKind: 'raid', raidBoss: true } } };
const raidSpot = { ...spot, raidBoss: true };
const raidRoster = Array.from({ length: 9 }, (_, n) => ({ ...members[0], characterId: 10 + n,
    loc: n === 8 ? far : { ...here }, stats: { role: n === 0 ? 'healer' : n === 1 ? 'buffer' : n === 2 ? 'tank' : 'dps' } }));
const raidEnd = Resolver.resolve({ party: { ...raidParty, memberIds: raidRoster.map(s => s.characterId) },
    members: raidRoster, spot: raidSpot, timestamp, rng: () => 0.5 });
assert.strictEqual(raidEnd.debug.reason, 'party_assembling');
assert.strictEqual(raidEnd.partyPatch.status, 'dissolved');
assert.strictEqual(raidEnd.partyPatch.stats.partyBreakReason, Assembly.REASON);

// A gathered party fights and clears the wait.
const syntheticSpot = { id: 'assembled', name: 'test', avgLevel: 20, density: 3, npcSelfIds: [],
    mob: { hp: 1, damage: 1 }, rewards: { exp: 100, sp: 10, adenaMin: 1, adenaMax: 1 } };
const gathered = members.map(s => ({ ...s, loc: { ...here } }));
const fight = Resolver.resolve({ party: { ...party, spotId: syntheticSpot.id, stats: { ...party.stats, assemblyAt: arrivalAt } },
    members: gathered, spot: syntheticSpot, timestamp, elapsedMs: 45000, rng: () => 0.5 });
assert.strictEqual(fight.partyPatch.stats.assemblyAt, null);
assert(fight.debug.wins > 0);
console.log('Party assembly on known ends: wait at the arrival, the absent member leaves, raid rosters whole, checks passed');

// A published clan wait steps again only when a writer changes its row: no
// 30 s step while it waits, at once on the change, its wait lived, not hunted.
(async () => {
    const Life = invoke('GameServer/Bot/Population/BotLifeState');
    const { ColdSimulationKernel, lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
    const { stepElapsedMs } = require('../src/GameServer/Bot/Population/ColdSoloWindow');
    const clanObjective = { ...objective, clanGoalKey: 'clan-goal', clanId: 7 };
    const solo = { ...members[0], characterId: 31, activity: 'hunting', party: { partyId: null },
        timing: { lastResolvedAt: at - minute }, simulation: { revision: 1 },
        stats: { ...members[0].stats, clanPartyObjective: clanObjective } };
    assert.strictEqual(lifecycleKind(solo), 'resolver');
    const hold = Duty.hold(solo, at);
    const waiting = { ...await Life.prepareResolve(solo, hold, { timestamp: at, persist: false, projectClassProgression: true }),
        simulation: { revision: 1 } };
    assert.strictEqual(lifecycleKind(waiting), 'event_driven', 'the published wait waits for its party');
    let now = at + 10 * minute;
    const kernel = new ColdSimulationKernel({ now: () => now, resolveSolo: () => null });
    kernel.upsert({ state: waiting });
    kernel.dueCandidates(at + 10 * minute, 4);
    assert(!kernel.busy(31), 'no step while the clan wait holds');
    kernel.upsert({ state: { ...waiting, stats: { ...waiting.stats, lastReason: 'clan_review' }, simulation: { revision: 2 } } });
    kernel.dueCandidates(at + 10 * minute, 4);
    assert(!kernel.busy(31), 'a write that keeps the wait wakes nothing');
    const clearedStats = { ...waiting.stats };
    delete clearedStats.clanPartyObjective;
    const cleared = { ...waiting, stats: clearedStats, simulation: { revision: 3 } };
    now = at + 10000;
    kernel.upsert({ state: cleared });
    kernel.dueCandidates(now, 4);
    assert(kernel.busy(31), 'the objective\'s end wakes it at once (its command starts), not at the hold\'s retry');
    assert.strictEqual(stepElapsedMs(cleared, at + 10 * minute), 1000, 'ten minutes waiting are not hunted');
    // The hold has no due of its own: a command holding the waiter (its clan hall
    // visit) runs at once, and the write that ends it leaves the bot held, no step.
    const behind = { ...waiting, stats: { ...waiting.stats, clanHallVisit: { hallId: 1 } }, simulation: { revision: 5 } };
    assert.strictEqual(lifecycleKind(behind), 'command');
    const commanded = new ColdSimulationKernel({ now: () => at, resolveSolo: () => null });
    commanded.upsert({ state: behind });
    commanded.dueCandidates(at, 4);
    assert(commanded.busy(31), 'a command holding the waiter runs at once, not at a retry');
    const resumed = new ColdSimulationKernel({ now: () => at + 10 * minute, resolveSolo: () => null });
    resumed.upsert({ state: { ...behind, stats: waiting.stats, simulation: { revision: 6 } } });
    resumed.dueCandidates(at + 10 * minute, 4);
    assert(!resumed.busy(31), 'the command\'s end leaves it held: no timed step');
    const assigned = { ...waiting, party: { partyId: 'clan-party', leaderId: 32 }, simulation: { revision: 4 } };
    assert.strictEqual(lifecycleKind(assigned), 'party_member', 'its party takes it over');

    // A waiter whose plan has an errand of its own (its clan craft still owes C
    // crystals; a crystal exchange it holds the inputs for) waits like any other:
    // while the wait holds it takes no step and its row is not written, and the
    // wait's end sends it back to its hunt, where the errand is its next step.
    // Stepped by the real solo resolver, every command applied as main applies it.
    const Solo = invoke('GameServer/Bot/Population/BackgroundResolver');
    const kit = Object.fromEntries(invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 2, level: 40 }).items
        .filter(item => item.slot !== 9).map(item => [item.selfId, { selfId: item.selfId, amount: 1, equipped: true,
            equippedCount: 1, equippedSlots: [item.slot], slot: item.slot }]));
    // A level 55 gladiator in its level 40 kit (the projection reads the level from the
    // experience and the class from the level).
    const grown = { ...waiting, level: 55, exp: Number(invoke('GameServer/DataCache').experience[54]), inventory: kit,
        stats: { ...waiting.stats, classId: 2 } };
    const errands = {
        'owes its clan craft C crystals': { ...grown, clanId: 7, stats: { ...grown.stats, clanId: 7,
            equipmentPlan: { status: 'active', strategy: 'craft', target: { selfId: 608, slot: 9 },
                materials: [{ selfId: 1459, amount: 35 }], clanGoal: { clanId: 7, beneficiaryId: 31, goalKey: 'clan-goal' } } } },
        'holds a crystal exchange ready': { ...grown, inventory: { ...kit, 1458: { selfId: 1458, amount: 10, stackable: true } },
            stats: { ...grown.stats, equipmentPlan: { status: 'active', strategy: 'luxury_exchange', target: { selfId: 608, slot: 9 },
                exchange: { kind: 'luxury_exchange', materials: [{ selfId: 1458, amount: 10 }] },
                materials: [{ selfId: 1458, amount: 10 }] } } }
    };
    assert(invoke('GameServer/Bot/Economy/ClanCrystalSupply').requirement(errands['owes its clan craft C crystals']),
        'the fixture owes the crystals');
    assert(invoke('GameServer/Bot/Economy/BotCrystallization').ready(errands['holds a crystal exchange ready']),
        'the fixture holds the exchange\'s inputs');
    const project = async (state, result, timestamp) => ({ ...await Life.prepareResolve(state, result,
        { timestamp, persist: false, projectClassProgression: true }),
        simulation: { revision: state.simulation.revision + 1 }, updatedAt: timestamp });
    for (const [errand, held] of Object.entries(errands)) {
        let clock = at + minute, row = held, writes = 0;
        const requests = [];
        const stepped = new ColdSimulationKernel({ now: () => clock, resolveSolo: Solo.resolveSolo,
            emit: (type, payload) => { if (type === 'command_request') requests.push(...payload.requests); } });
        stepped.upsert({ state: held });
        for (let turn = 0; turn < 5; turn++, clock += 40) {
            const steps = stepped.dueCandidates(clock, 4);
            await stepped.resolveChain;
            writes += steps.length;
            for (const request of requests.splice(0)) {
                writes += 1;
                row = await project(request.state, request.precomputedResult, clock);
                assert(stepped.completeCommand({ characterId: 31, commandId: request.commandId,
                    commandCheckpoint: request.commandCheckpoint, ok: true, state: row }));
            }
        }
        assert.strictEqual(writes, 0, `a held waiter that ${errand} takes no step and writes no row`);
        assert(!stepped.busy(31) && !stepped.needsNormalSchedule(31), `no step is coming for a waiter that ${errand}`);
        // The clan's call as its planner writes it (party_wait, not published yet): the
        // worker's own step publishes the wait, once; main has nothing to carry out.
        const called = { ...held, stats: { ...held.stats } };
        delete called.stats.eventWait;
        assert.strictEqual(lifecycleKind(called), 'resolver', `the worker publishes the wait of a member that ${errand}`);
        const published = await project(called, Solo.resolveSolo({ state: called, spot: null, timestamp: clock }), clock);
        assert.strictEqual(published.stats.eventWait, 'clan_party_assembly');
        assert.strictEqual(lifecycleKind(published), 'event_driven', 'published once, it waits');
        // Forming's no ends the wait: the waiter steps at once, back to its hunt, and
        // the errand is that hunt's next step.
        const refused = { ...row, stats: { ...row.stats, partyRequest: { ...row.stats.partyRequest, status: 'closed' } },
            simulation: { revision: row.simulation.revision + 1 } };
        stepped.upsert({ state: refused });
        assert.strictEqual(stepped.dueCandidates(clock, 4).length, 1, 'the wait\'s end steps it at once');
        const hunting = await project(refused, Solo.resolveSolo({ state: refused, spot: null, timestamp: clock }), clock);
        assert.strictEqual(hunting.activity, 'hunting', 'released, it hunts again');
        assert.strictEqual(lifecycleKind(hunting), 'command', `back at its hunt, a bot that ${errand} takes its errand up`);
    }
    console.log('Clan party wait: event-driven hold, wake on the objective\'s end, lived wait checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
