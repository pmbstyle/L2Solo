const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
// U26 (user, 2026-10-05): can-I-win is a chance with one roll per decision. A fixed
// middle roll (0.49) makes each such decision the author's threshold (willing iff
// chance >= 0.5, i.e. ratio >= threshold); the chance itself is tested in test_visible_strength.
require('../src/GameServer/Bot/AI/TendencyRoll').roll = () => 0.49;
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const { ColdCompetitionActions, WAIT_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionActions');
const { PARTY_AVOID_ROUNDS } = require('../src/GameServer/Bot/Population/ColdCompetitionRetreat');
const PartyRisk = require('../src/GameServer/Bot/Population/PartySpotRiskPolicy');
const Risk = require('../src/GameServer/Bot/Population/SpotRiskPolicy');
const Wait = require('../src/GameServer/Bot/Population/ColdCompetitionWait');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-retreat-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now(), state = id => Life.cachedState(id);
const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);
const oldEpisode = { key: 'old-pvp', at: at - 700000, outcome: 'pvp_fighting', role: 'attack', endedAt: at - 600000, conflictUntil: at + 60000 };
const base = { life: Life, owner: Owner, parties: Party, memory: Memory, now: () => at,
    participantAllowed: () => true, contestContextAllowed: () => true };
// An avoid raises contest_lost on the unit: its spot marked, its earning spot woken.
const raised = s => (s.stats.spotMarks || []).length > 0;
async function createParty(ids) {
    const p = Party.prepareCommit({ partyId: `p${ids[0]}`, leaderId: ids[0], memberIds: ids,
        spotId: 'test', status: 'active', startedAt: at, nextResolveAt: at + 45000, stats: { objective: ids[0] <= 22 ? null : { npcId: 10 }, ...(ids[0] <= 22 ? { coldCompetition: oldEpisode } : {}) } });
    const assigned = ids.map(id => Life.preparePartyAssignment(state(id), p.row.partyId, 'dps', ids[0], at + 45000));
    const formed = await Database.commitBackgroundPartyMembership({ party: p.row, members: assigned });
    assert(formed.ok);
    Life.acceptPartyAssignments(assigned, formed.lifeRows); Party.acceptRow(formed.partyRow);
}
function event(a, b, action = 'avoid') {
    const participant = id => {
        const party = Party.find(state(id).party?.partyId);
        return { id, revision: state(id).simulation.revision, memoryRevision: Memory.snapshot(id).revision,
            partyId: party?.partyId, partyRevision: party?.revision, size: party?.memberIds.length || 1 };
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
            assert.strictEqual(episode.conflictUntil, undefined, 'no conflict window carries into a new episode');
        }
        assert.deepStrictEqual(result.affectedIds, actorIds);
        assert.strictEqual(result.memoryEvents, 0);
        assert.strictEqual(state(b).timing.nextResolveAt, peerDue);
        assert(peerIds.every(id => !raised(state(id))), 'opponent keeps hunting, its plan untouched');
        for (const id of actorIds) {
            const s = state(id);
            assert(!s.stats.travel && s.spotId === 'test', 'main starts no trip: the worker routes the unit');
            assert(raised(s), 'the avoid raises the member\'s occupation');
            assert.strictEqual(s.timing.nextResolveAt, at, 'the unit steps now');
            assert(Risk.isMarked(s.stats, 'test'), 'each member lost the contest: the spot is its mark (contest_lost)');
            assert.strictEqual(s.stats.coldCompetition.avoid, undefined, 'a solo bot keeps no competition avoid');
            assert(Risk.excludedSpotIdsForStates([s]).has('test'), 'the worker\'s route excludes the spot');
            const later = { ...s, stats: { ...s.stats, stepCount: Risk.stepCount(s) + 1000 } };
            assert(Risk.excludedSpotIdsForStates([later]).has('test'), 'no clock ends the mark');
            const decided = { ...s, stats: { ...s.stats, earning: { spotId: 'elsewhere', at: at + 1 } } };
            assert(!Risk.excludedSpotIdsForStates([decided]).has('test'), 'the next earning answer retires it, no death backoff');
            assert.strictEqual(Memory.snapshot(id).relations.length, 0);
        }
        if (actorIds.length > 1) {
            const party = Party.find(`p${a}`);
            assert.strictEqual(party.stats.coldCompetition.outcome, 'avoid');
            assert.strictEqual(party.stats.coldCompetition.endedAt, undefined);
            assert.strictEqual(party.stats.coldCompetition.conflictUntil, undefined);
            assert(party.spotId === 'test' && !party.stats.travel, 'the party\'s next run routes it');
            assert.strictEqual(party.nextResolveAt, at, 'the party runs now');
            assert(PartyRisk.excludedSpotIds(party).has('test'), 'the party avoids the spot');
            const later = { ...party, stats: { ...party.stats, partySpotRisk: { ...party.stats.partySpotRisk,
                partyId: party.partyId, rounds: PartyRisk.rounds(party) + PARTY_AVOID_ROUNDS } } };
            assert(!PartyRisk.excludedSpotIds(later).has('test'), 'the party forgets it after ten of its rounds');
        }
        assert.strictEqual((await actions.apply(forecast)).ok, false, 'delivery cannot replay a departure');
    }
    for (const [a, b, actorIds, peerIds] of [[13, 15, [13, 14], [15]], [16, 17, [16], [17, 18]], [19, 21, [19, 20], [21, 22]]]) {
        if (actorIds.length > 1) await createParty(actorIds);
        if (peerIds.length > 1) await createParty(peerIds);
        const prior = Party.find(`p${a}`)?.nextResolveAt || state(a).timing.nextResolveAt, peerDue = state(b).timing.nextResolveAt;
        const result = await actions.apply(event(a, b, 'yield'));
        assert(result.ok, JSON.stringify(result));
        for (const partyId of [`p${a}`, `p${b}`].filter(id => Party.find(id))) {
            const [saved] = await Database.execute(['SELECT revision FROM bot_background_parties WHERE partyId=?', [partyId]]);
            assert.strictEqual(Party.find(partyId).revision, Number(saved.revision), 'each side caches its own committed party row');
        }
        for (const id of [...actorIds, ...peerIds]) {
            assert.strictEqual(state(id).stats.coldCompetition.outcome, 'yield');
            assert.strictEqual(state(id).stats.coldCompetition.endedAt, undefined);
            assert.strictEqual(state(id).stats.coldCompetition.conflictUntil, undefined);
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
    const fresh = event(23, 25);
    const race = new ColdCompetitionActions({ ...base, owner: { ...Owner, commitBatch: async (entries, opts) => {
        await Database.execute(['UPDATE bot_background_parties SET revision=revision+1 WHERE partyId=?', ['p23']]);
        return Owner.commitBatch(entries, opts);
    } } });
    assert.strictEqual((await race.apply(fresh)).reason, 'commit_rejected');
    assert([23, 24, 25].every(id => !Risk.isMarked(state(id).stats, 'test')), 'membership race aborts every avoid');
    // The scheduler report is developer diagnostics (off by default since c656911d):
    // the departure itself must happen with it off, and is counted when it is on.
    const Diagnostics = invoke('GameServer/Bot/Population/PopulationConfig');
    for (const [a, b, diagnostics] of [[28, 29, false], [30, 31, true]]) {
        Diagnostics.developerDiagnostics = diagnostics;
        const scheduler = new ColdCompetitionActions(base);
        scheduler.submit({ at, recent: [event(a, b)] }); await scheduler.running;
        assert.strictEqual(state(a).stats.coldCompetition.outcome, 'avoid', 'avoid is executed even with PvP disabled');
        assert(Risk.isMarked(state(a).stats, 'test'));
        if (diagnostics) assert.strictEqual(scheduler.snapshot().avoids, 1, 'the executed avoid is counted');
        else assert.deepStrictEqual(scheduler.snapshot(), { enabled: false });
    }
    Diagnostics.developerDiagnostics = false;
    await Database.close(); Database.init();
    const persisted = await Database.execute(['SELECT mindJson, activity FROM bot_life_state WHERE characterId=9', []]);
    assert.strictEqual(persisted[0].activity, 'hunting');
    const saved = JSON.parse(persisted[0].mindJson);
    assert(saved.spotMarks.some(mark => mark.spotId === 'test' && mark.reason === 'contest_lost'), 'the mark persists in the mind');
    const parties = await Database.execute(['SELECT spotId, statsJson FROM bot_background_parties WHERE partyId=?', ['p9']]);
    assert.strictEqual(JSON.parse(parties[0].statsJson).coldCompetition.avoid.spotId, 'test',
        'the party\'s avoid and its members persist together');
    assert.strictEqual((await invoke('GameServer/Social/InteractionMemoryRepository').load(9)).relations.length, 0);
    console.log('Cold voluntary retreat: all matchups, avoid raised for the worker route, party yield, CAS races, no blame and SQLite reopen passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});
