const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const { ColdCompetitionActions, WAIT_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionActions');
const { AVOID_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionRetreat');
const Risk = require('../src/GameServer/Bot/Population/SpotRiskPolicy');
const Wait = require('../src/GameServer/Bot/Population/ColdCompetitionWait');
const Kernel = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-retreat-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now(), state = id => Life.cachedState(id);
const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);
const oldEpisode = { key: 'old-pvp', at: at - 700000, outcome: 'pvp_fighting', role: 'attack', endedAt: at - 600000, conflictUntil: at + 60000 };
const destination = { locX: 3000, locY: 1000, locZ: 0 };
const base = { life: Life, owner: Owner, parties: Party, memory: Memory, now: () => at,
    participantAllowed: () => true, contestContextAllowed: () => true,
    retreatRoute: (members, party) => {
        assert(Risk.excludedSpotIdsForStates(members, at).has('test'));
        return { needed: true, mode: party ? 'party' : 'solo', spotId: 'other', regionName: 'Other field',
            reason: 'competition_avoid', cause: 'competition_avoid', travelMs: 30000, to: destination };
    } };
async function createParty(ids) {
    const p = Party.prepareCommit({ partyId: `p${ids[0]}`, leaderId: ids[0], memberIds: ids,
        spotId: 'test', status: 'active', startedAt: at, nextResolveAt: at + 45000, stats: { objective: ids[0] <= 22 ? null : { npcId: 10 }, ...(ids[0] <= 22 ? { coldCompetition: oldEpisode } : {}) } });
    const assigned = ids.map(id => Life.preparePartyAssignment(state(id), p.row.partyId, 'dps', ids[0], at + 45000));
    assert((await Database.commitBackgroundPartyMembership({ party: p.row, members: assigned })).ok);
    Life.acceptPartyAssignments(assigned); Party.acceptCommit(p);
}
function event(a, b, action = 'avoid') {
    const participant = id => {
        const party = Party.find(state(id).party?.partyId);
        return { id, revision: state(id).simulation.revision, memoryRevision: Memory.snapshot(id).revision,
            partyId: party?.partyId, partyUpdatedAt: party?.updatedAt, size: party?.memberIds.length || 1 };
    };
    return { key: `retreat:${a}:${b}`, at, pressure: 3, spotId: 'test', npcId: 10, action, actor: participant(a), peer: participant(b) };
}
async function run() {
    Database.init();
    const stats = { equipmentPlan: { status: 'active', next: { npcId: 10, spotId: 'test' } } };
    for (const id of range(1, 40)) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`retreat${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `retreat${id}`, `Retreat${id}`]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            nextResolveAt,lastResolvedAt,updatedAt,statsJson) VALUES (?,?,?,'cold','hunting','test',100,100,100,100,20,?,?,?,?)`,
        [id, `retreat${id}`, `Retreat${id}`, at + 60000, at - 30000, at, JSON.stringify(id <= 22 ? { ...stats, coldCompetition: oldEpisode } : stats)]]);
    }
    await Life.init(); await Party.init(); await Memory.ensureMany(range(1, 40));
    const actions = new ColdCompetitionActions(base);
    for (const [a, b, actorIds, peerIds] of [[1, 2, [1], [2]], [3, 5, [3, 4], [5]],
        [6, 7, [6], [7, 8]], [9, 11, [9, 10], [11, 12]]]) {
        if (actorIds.length > 1) await createParty(actorIds);
        if (peerIds.length > 1) await createParty(peerIds);
        for (const id of [...actorIds.slice(1), ...peerIds.slice(1)]) {
            await Database.execute(['UPDATE bot_life_state SET activity=? WHERE characterId=?', ['resting', id]]);
            Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
        }
        const forecast = event(a, b), peerDue = state(b).timing.nextResolveAt;
        const result = await actions.apply(forecast);
        assert(result.ok, JSON.stringify(result));
        for (const id of [...actorIds, ...peerIds]) {
            const episode = state(id).stats.coldCompetition;
            assert.strictEqual(episode.outcome, 'avoid');
            assert.strictEqual(episode.endedAt, undefined);
            assert.strictEqual(episode.role, undefined);
            assert.strictEqual(episode.conflictUntil, oldEpisode.conflictUntil);
        }
        assert.deepStrictEqual(result.affectedIds, actorIds);
        assert.strictEqual(result.memoryEvents, 0);
        assert.strictEqual(state(b).timing.nextResolveAt, peerDue);
        assert(peerIds.every(id => state(id).activity !== 'traveling'), 'opponent keeps hunting');
        for (const id of actorIds) {
            const s = state(id);
            assert.strictEqual(s.activity, 'traveling');
            assert.strictEqual(s.loc.locX, 0, 'departure does not teleport to the new spot');
            assert.strictEqual(s.stats.travel.arrivalAt, at + 30000);
            assert.strictEqual(s.stats.coldCompetition.avoid.until, at + AVOID_MS);
            const progress = Resolver.resolveSolo({ state: s, timestamp: at + 15000 });
            assert.strictEqual(progress.materialize.exp, 0, 'travel time cannot produce catch-up kills');
            assert.strictEqual(progress.patch.loc.locX, 0, 'ordinary gatekeeper transit remains at origin until arrival');
            const arrived = actorIds.length > 1 ? Kernel.finishPartyRouteTravelState(s, at + 30000)
                : Resolver.resolveSolo({ state: s, timestamp: at + 30000 }).patch;
            assert.strictEqual(arrived.spotId, 'other');
            assert.deepStrictEqual(arrived.loc, destination);
            assert(Risk.excludedSpotIdsForStates([s], at + 30000).has('test'));
            assert(!Risk.excludedSpotIdsForStates([s], at + AVOID_MS).has('test'), 'social avoidance expires without escalating death backoff');
            assert.strictEqual(Memory.snapshot(id).relations.length, 0);
        }
        if (actorIds.length > 1) {
            const party = Party.find(`p${a}`);
            assert.strictEqual(party.stats.coldCompetition.outcome, 'avoid');
            assert.strictEqual(party.stats.coldCompetition.endedAt, undefined);
            assert.strictEqual(party.stats.coldCompetition.conflictUntil, oldEpisode.conflictUntil);
            assert.strictEqual(party.spotId, 'other');
            assert.strictEqual(party.stats.travel.arrivalAt, at + 30000);
        }
        assert.strictEqual((await actions.apply(forecast)).ok, false, 'delivery cannot replay a departure');
    }
    for (const [a, b, actorIds, peerIds] of [[13, 15, [13, 14], [15]], [16, 17, [16], [17, 18]], [19, 21, [19, 20], [21, 22]]]) {
        if (actorIds.length > 1) await createParty(actorIds);
        if (peerIds.length > 1) await createParty(peerIds);
        const prior = Party.find(`p${a}`)?.nextResolveAt || state(a).timing.nextResolveAt, peerDue = state(b).timing.nextResolveAt;
        const result = await actions.apply(event(a, b, 'yield'));
        assert(result.ok, JSON.stringify(result));
        for (const id of [...actorIds, ...peerIds]) {
            assert.strictEqual(state(id).stats.coldCompetition.outcome, 'yield');
            assert.strictEqual(state(id).stats.coldCompetition.endedAt, undefined);
            assert.strictEqual(state(id).stats.coldCompetition.conflictUntil, oldEpisode.conflictUntil);
        }
        assert.deepStrictEqual(result.affectedIds, actorIds);
        assert(actorIds.every(id => state(id).timing.nextResolveAt === prior + WAIT_MS));
        assert.strictEqual(state(b).timing.nextResolveAt, peerDue);
        const party = Party.find(`p${a}`);
        const resumed = party ? Wait.consumeParty(party, actorIds.map(state), 75000, at + 30000)
            : Wait.consume(state(a), 75000, at + 30000);
        assert.strictEqual(resumed.elapsedMs, 60000, 'one pause is charged once, regardless of party size');
        if (party) {
            const blocked = invoke('GameServer/Bot/Population/BackgroundPartyResolver').resolve({ party, members: actorIds.map(state), timestamp: at + 5000 });
            assert.strictEqual(blocked.debug.reason, 'competition_yield');
            assert(blocked.memberResults.every(r => r.result.materialize.exp === 0));
        }
    }
    await createParty([23, 24]);
    const pending = event(23, 25);
    assert.strictEqual((await new ColdCompetitionActions({ ...base, participantAllowed: id => id !== 24 }).apply(pending)).ok, false);
    assert.strictEqual((await new ColdCompetitionActions({ ...base, contestContextAllowed: s => s.characterId !== 24 }).apply(pending)).ok, false);
    assert.strictEqual((await new ColdCompetitionActions({ ...base, retreatRoute: () => null }).apply(pending)).reason, 'no_retreat_route');
    const partial = new ColdCompetitionActions({ ...base, owner: { ...Owner,
        claimBatch: (states, opts) => Owner.claimBatch(states.slice(0, 1), opts) } });
    assert.strictEqual((await partial.apply(pending)).reason, 'claim_rejected');
    assert(!state(23).simulation.leaseId);
    const fresh = event(23, 25);
    const race = new ColdCompetitionActions({ ...base, owner: { ...Owner, commitAndReleaseBatch: async (entries, opts) => {
        await Database.execute(['UPDATE bot_background_parties SET updatedAt=updatedAt+1 WHERE partyId=?', ['p23']]);
        return Owner.commitAndReleaseBatch(entries, opts);
    } } });
    assert.strictEqual((await race.apply(fresh)).reason, 'commit_rejected');
    assert([23, 24, 25].every(id => !state(id).stats.travel && !state(id).simulation.leaseId), 'membership race aborts every departure and releases leases');
    const memoryRace = new ColdCompetitionActions({ ...base, owner: { ...Owner, claimBatch: async (...args) => {
        const claims = await Owner.claimBatch(...args);
        await Memory.recordBatch([{ key: 'retreat-help-race', sourceId: 26, targetId: 27, type: 'healed', at }]);
        return claims;
    } } });
    assert.strictEqual((await memoryRace.apply(event(26, 27))).reason, 'retreat_changed_during_claim');
    assert(!state(26).stats.travel && !state(26).simulation.leaseId);
    const scheduler = new ColdCompetitionActions(base);
    scheduler.submit({ at, recent: [event(28, 29)] }); await scheduler.running;
    assert.strictEqual(scheduler.snapshot().avoids, 1, 'avoid is executed even with PvP disabled');
    await Database.close(); Database.init();
    const persisted = await Database.execute(['SELECT statsJson, activity FROM bot_life_state WHERE characterId=9', []]);
    assert.strictEqual(persisted[0].activity, 'traveling');
    const saved = JSON.parse(persisted[0].statsJson);
    assert.strictEqual(saved.travel.spotId, 'other');
    assert.strictEqual(saved.coldCompetition.avoid.until, at + AVOID_MS);
    const parties = await Database.execute(['SELECT spotId, statsJson FROM bot_background_parties WHERE partyId=?', ['p9']]);
    assert.strictEqual(parties[0].spotId, 'other', 'party routing authority and members persist together');
    assert.strictEqual(JSON.parse(parties[0].statsJson).travel.arrivalAt, saved.travel.arrivalAt);
    assert.strictEqual((await invoke('GameServer/Social/InteractionMemoryRepository').load(9)).relations.length, 0);
    console.log('Cold voluntary retreat: all matchups, paid travel, party yield, CAS races, no blame and SQLite reopen passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});
