const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Memory = require('../src/GameServer/Social/InteractionMemory');
const P = require('../src/GameServer/Social/InteractionMemoryPolicy');
const { ColdCompetitionActions, WAIT_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionActions');
const Wait = require('../src/GameServer/Bot/Population/ColdCompetitionWait');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-competition-actions-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
let now = Date.now();
async function run() {
    Database.init();
    const stats = { equipmentPlan: { status: 'active', strategy: 'direct_drop', next: { npcId: 10, spotId: 'test' } } };
    for (const id of Array.from({ length: 18 }, (_, index) => index + 1)) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_actions_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_actions_${id}`, `Action${id}`]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            nextResolveAt,lastResolvedAt,updatedAt,statsJson) VALUES (?,?,?,'cold','hunting','test',100,100,100,100,20,?,?,?,?)`,
        [id, `bot_actions_${id}`, `Action${id}`, now + 60000, now - 30000, now, JSON.stringify(stats)]]);
    }
    await Life.init();
    const memory = new Memory();
    [1, 2, 3, 4, 5, 6, 7, 8].forEach(id => memory.accept(P.empty(id)));
    const actions = new ColdCompetitionActions({ life: Life, owner: Owner, memory, now: () => now,
        formParty: async members => {
            const prepared = Party.prepareCommit({ partyId: 'competition-party', leaderId: 3, memberIds: [3, 4],
                spotId: 'test', status: 'active', startedAt: now, nextResolveAt: now + 45000, stats: { objective: { npcId: 10 } } });
            const assigned = members.map(s => Life.preparePartyAssignment(s, 'competition-party', 'dps', 3, now + 45000));
            const result = await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
            if (!result.ok) return null;
            Life.acceptPartyAssignments(assigned);
            return Party.acceptCommit(prepared);
        } });
    const event = (a, b, action = 'yield') => ({ key: `episode:${a}:${b}`, at: now, pressure: 2, spotId: 'test', npcId: 10, action, accepted: true,
        actor: { id: a, revision: Life.cachedState(a).simulation.revision, memoryRevision: 0 },
        peer: { id: b, revision: Life.cachedState(b).simulation.revision, memoryRevision: 0 } });
    const yieldEvent = event(1, 2);
    const before = Life.cachedState(1);
    const yielded = await actions.apply(yieldEvent);
    assert(yielded.ok, JSON.stringify(yielded));
    assert.strictEqual(Life.cachedState(1).timing.nextResolveAt, before.timing.nextResolveAt + WAIT_MS);
    assert.strictEqual((await actions.apply(yieldEvent)).ok, false, 'duplicate delivery cannot apply another pause');
    const paused = Life.cachedState(1);
    assert(Wait.consume(paused, 30000, now + 5000).waiting);
    const Resolver = invoke('GameServer/Bot/Population/BackgroundResolver');
    const idle = Resolver.resolveSolo({ state: paused, timestamp: now + 5000 });
    assert.strictEqual(idle.materialize.exp, 0);
    assert.strictEqual(idle.debug.reason, 'competition_yield');
    const missingSpot = Resolver.resolveSolo({ state: paused, timestamp: now + 30000, spot: null });
    assert.strictEqual(missingSpot.patch.stats.coldCompetition.wait, null, 'lifecycle early returns cannot strand a paused hunter');
    const resumed = Wait.consume(paused, 75000, now + 30000);
    assert.strictEqual(resumed.elapsedMs, 60000);
    assert.strictEqual(resumed.state.stats.coldCompetition.wait, null);
    assert.strictEqual(Wait.consume(resumed.state, 60000, now + 90000).elapsedMs, 60000, 'idle debt is deducted once');
    const partyEvent = event(3, 4, 'offer_party');
    assert((await actions.apply(partyEvent)).ok);
    assert.strictEqual((await actions.apply(partyEvent)).ok, false);
    assert.strictEqual(Life.cachedState(3).party.partyId, 'competition-party');
    now += 120001;
    const Recruitment = require('../src/GameServer/Bot/Population/ColdCompetitionRecruitment');
    const Composition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
    const commit = async (party, members, lifeEvent) => {
        const prepared = Party.prepareCommit(party);
        const assigned = members.map(s => Life.preparePartyAssignment(s, party.partyId, 'dps', party.leaderId, party.nextResolveAt));
        const result = await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned, event: lifeEvent });
        if (!result.ok) return { party: null, failed: members, reason: result.reason };
        Life.acceptPartyAssignments(assigned);
        return { party: Party.acceptCommit(prepared), failed: [] };
    };
    const recruitOptions = { parties: Party, life: Life, memory, composition: Composition,
        limitsFor: () => ({ maxSize: 5, minSize: 2, levelRange: 4 }), clanReserved: () => false, commit };
    const recruitEvent = (solo, member) => ({ ...event(solo, member, 'offer_party'),
        peer: { ...event(solo, member).peer, partyId: 'competition-party',
            partyUpdatedAt: Party.find('competition-party').updatedAt, size: Party.find('competition-party').memberIds.length } });
    const join = recruitEvent(7, 3);
    const joinStates = [Life.cachedState(7), Life.cachedState(3)];
    assert.strictEqual((await Recruitment.recruit({ ...recruitOptions, participants: joinStates, event: join,
        participantAllowed: id => id !== 4 })).rejected, 'party_member_busy', 'a fenced retained member blocks the entire invitation');
    assert.strictEqual((await Recruitment.recruit({ ...recruitOptions, participants: joinStates, event: join,
        limitsFor: () => ({ maxSize: 2, minSize: 2 }) })).rejected, 'party_full');
    assert.strictEqual((await Recruitment.recruit({ ...recruitOptions, participants: joinStates, event: join,
        memory: { assess: () => ({ ready: true, disposition: 'hostile' }) } })).rejected, 'party_hostility');
    const joining = new ColdCompetitionActions({ life: Life, owner: Owner, memory, now: () => now,
        formParty: (participants, event, options) => Recruitment.recruit({ ...recruitOptions, ...options, participants, event, timestamp: now }) });
    const joined = await joining.apply(join);
    assert.strictEqual(joined.recruited, 1, JSON.stringify(joined));
    assert.deepStrictEqual(Party.find('competition-party').memberIds, [3, 4, 7]);
    assert.strictEqual(Life.cachedState(7).party.partyId, 'competition-party');
    assert.strictEqual(Life.cachedState(3).stats.coldCompetition.key, join.key);
    assert.strictEqual((await joining.apply(join)).ok, false, 'repeated invitation cannot duplicate membership');
    const beforeRace = Party.find('competition-party');
    const raceJoin = recruitEvent(8, 4);
    const raceResult = await Recruitment.recruit({ ...recruitOptions, participants: [Life.cachedState(8), Life.cachedState(4)], event: raceJoin,
        commit: async (...args) => {
            await Database.execute(['UPDATE bot_life_state SET updatedAt=updatedAt+1 WHERE characterId=7', []]);
            return commit(...args);
        } });
    assert.strictEqual(raceResult.rejected, 'membership_conflict', 'a concurrent retained-member change aborts recruitment');
    assert.deepStrictEqual(Party.find('competition-party').memberIds, beforeRace.memberIds);
    assert(!Life.cachedState(8).party?.partyId);
    const raced = new ColdCompetitionActions({ life: Life, memory, now: () => now, owner: { ...Owner,
        commitAndReleaseBatch: async (entries, options) => {
            await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=6', []]);
            return Owner.commitAndReleaseBatch(entries, options);
        } } });
    assert.strictEqual((await raced.apply(event(5, 6))).ok, false);
    const failedRows = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN (5,6)', []]);
    assert(failedRows.every(r => !JSON.parse(r.statsJson).coldCompetition), 'one stale participant aborts the entire yield episode');
    const persisted = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=1', []]);
    assert.strictEqual(JSON.parse(persisted[0].statsJson).coldCompetition.key, yieldEvent.key);
    [11, 12].forEach(id => memory.accept(P.empty(id)));
    const queuedActions = new ColdCompetitionActions({ life: Life, owner: Owner, memory, now: () => now,
        formParty: async () => ({ rejected: 'party_capacity' }) });
    const queueEvent = event(11, 12, 'offer_party');
    const originalTiming = Life.cachedState(11).timing.nextResolveAt;
    assert.strictEqual((await queuedActions.apply(queueEvent)).queued, true);
    assert.strictEqual(Life.cachedState(11).timing.nextResolveAt, originalTiming, 'capacity waiting does not pause farming');
    assert.strictEqual(Life.cachedState(12).stats.partyRequest.reason, 'shared_target');
    assert.strictEqual((await queuedActions.apply(queueEvent)).ok, false, 'repeated invitation cannot reset queue age');
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const Spots = invoke('GameServer/Bot/Population/SpotProfiles');
    const originalFind = Spots.findById;
    let socialParty;
    try {
        Spots.findById = id => id === 'test' ? { id: 'test' } : originalFind.call(Spots, id);
        socialParty = await Population.formCompetitionParty([Life.cachedState(9), Life.cachedState(10)], { spotId: 'test', npcId: 10 });
        assert(socialParty?.partyId, 'real population formation must create a social party');
        assert.strictEqual(socialParty.stats.capacityPool, undefined);
        const dueReview = await Party.createOrUpdate({ ...socialParty,
            stats: { ...socialParty.stats, sessionExpiresAt: Date.now() - 1 } });
        const reviewed = await Population.resolveBackgroundParty(dueReview);
        assert.strictEqual(reviewed.ok, true, JSON.stringify(reviewed));
        assert.strictEqual(reviewed.party.status, 'active', 'legacy runtime must review rather than expire a new productive goal');
        assert(reviewed.party.stats.sessionReview.nextAt > Date.now());
    } finally { Spots.findById = originalFind; }
    const runtimeMemory = invoke('GameServer/Social/InteractionMemoryRuntime');
    await runtimeMemory.ensureMany([13, 14, 15, 16, 17, 18]);
    const contestNow = Date.now();
    const conflictOptions = { life: Life, owner: Owner, memory: runtimeMemory, now: () => contestNow,
        conflictsEnabled: () => true, contestContextAllowed: () => true };
    const conflicts = new ColdCompetitionActions(conflictOptions);
    const contestEvent = (a, b) => ({ ...event(a, b, 'contest'), at: contestNow, pvpIntent: true,
        actor: { id: a, revision: Life.cachedState(a).simulation.revision, memoryRevision: runtimeMemory.snapshot(a).revision },
        peer: { id: b, revision: Life.cachedState(b).simulation.revision, memoryRevision: runtimeMemory.snapshot(b).revision } });
    const dispute = contestEvent(13, 14);
    assert.strictEqual((await new ColdCompetitionActions({ ...conflictOptions, conflictsEnabled: () => false }).apply(dispute)).reason, 'forecast_only');
    assert.strictEqual((await new ColdCompetitionActions({ ...conflictOptions, contestContextAllowed: () => false }).apply(dispute)).reason, 'contest_context_changed');
    const contested = await conflicts.apply(dispute);
    assert(contested.ok, JSON.stringify(contested));
    assert.strictEqual(contested.pvp, false, 'a PvP intention is not an executed attack');
    assert.strictEqual(runtimeMemory.snapshot(13).relations.length, 0, 'the aggressor must not invent an offense by the victim');
    const resentment = runtimeMemory.assess({ id: 14 }, { id: 13 }, {}, contestNow);
    assert.strictEqual(resentment.personal.hostility, 3);
    assert.strictEqual(resentment.disposition, 'wary', 'one dispute does not immediately create an enemy');
    assert.strictEqual(Life.cachedState(13).stats.coldCompetition.wait, undefined);
    const victim = Life.cachedState(14);
    const blockedHunt = Resolver.resolveSolo({ state: victim, timestamp: contestNow + 5000 });
    assert.strictEqual(blockedHunt.debug.reason, 'competition_contest');
    assert.strictEqual(blockedHunt.materialize.exp, 0);
    assert.strictEqual(Wait.consume(victim, 30000, contestNow + 30000).elapsedMs, 15000);
    assert.strictEqual((await conflicts.apply(dispute)).ok, false, 'delivery cannot repeat the loss or the memory');
    const later = new ColdCompetitionActions({ ...conflictOptions, now: () => contestNow + 120001 });
    const laterEvent = { ...contestEvent(13, 15), key: 'later-opponent', at: contestNow + 120001 };
    assert.strictEqual((await later.apply(laterEvent)).reason, 'conflict_cooldown', 'durable conflict budget covers different opponents');
    const contestedRace = new ColdCompetitionActions({ ...conflictOptions, owner: { ...Owner,
        commitAndReleaseBatch: async (entries, options) => {
            await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=16', []]);
            return Owner.commitAndReleaseBatch(entries, options);
        } } });
    assert.strictEqual((await contestedRace.apply(contestEvent(15, 16))).ok, false);
    const rollback = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN (15,16)', []]);
    assert(rollback.every(row => !JSON.parse(row.statsJson).coldCompetition), 'both physical outcomes abort on one stale lease');
    assert.strictEqual((await invoke('GameServer/Social/InteractionMemoryRepository').load(16)).relations.length, 0, 'rejected outcome must not write resentment');
    const memoryRace = new ColdCompetitionActions({ ...conflictOptions, owner: { ...Owner,
        claimBatch: async (...args) => {
            const claims = await Owner.claimBatch(...args);
            await runtimeMemory.recordBatch([{ key: 'concurrent-help', sourceId: 18, targetId: 17, type: 'helped_in_combat', at: contestNow }]);
            return claims;
        } } });
    assert.strictEqual((await memoryRace.apply(contestEvent(17, 18))).reason, 'contest_changed_during_claim');
    assert.strictEqual(runtimeMemory.assess({ id: 18 }, { id: 17 }, {}, contestNow).personal.hostility, 0);
    await assert.rejects(conflicts.apply({ ...contestEvent(17, 18), key: 'invalid/key' }), /interaction memory: invalid key/);
    const memoryRollback = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN (17,18)', []]);
    assert(memoryRollback.every(row => !JSON.parse(row.statsJson).coldCompetition), 'memory failure rolls back both life-state writes');
    await Database.close(); Database.init();
    const reopenedMemory = await invoke('GameServer/Social/InteractionMemoryRepository').load(14);
    assert.strictEqual(reopenedMemory.relations[0].hostility, 3, 'resentment survives SQLite close and reopen');
    assert.strictEqual(reopenedMemory.recent.filter(e => e.type === 'mob_contested').length, 1);
    const reopenedVictim = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=14', []]);
    assert.strictEqual(JSON.parse(reopenedVictim[0].statsJson).coldCompetition.wait.until, contested.waitUntil);
    assert.strictEqual(JSON.parse(reopenedVictim[0].statsJson).coldCompetition.conflictUntil, contestNow + 600000);
    const queuedRows = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN (11,12)', []]);
    assert(queuedRows.every(r => JSON.parse(r.statsJson).partyRequest.requestedAt === now), 'both ordinary requests survive restart');
    const socialRows = await Database.execute(['SELECT statsJson FROM bot_background_parties WHERE partyId=?', [socialParty.partyId]]);
    assert.strictEqual(JSON.parse(socialRows[0].statsJson).capacityPool, undefined, 'new parties have no privileged origin pool');
    const reopened = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId=1', []]);
    assert.strictEqual(JSON.parse(reopened[0].statsJson).coldCompetition.wait.until, yielded.waitUntil);
    const replay = await Database.claimColdSimulationLease({ characterId: 1, expectedRevision: yieldEvent.actor.revision,
        ownerId: 'cold_simulation_owner', leaseId: 'replay-after-restart', timestamp: now, leaseUntil: now + 30000 });
    assert.strictEqual(replay.ok, false, 'SQLite after reopen must reject the original delivered revision');
    const scheduled = [], scheduler = new ColdCompetitionActions({ now: () => now });
    scheduler.apply = async e => { scheduled.push(e.action); return { ok: true }; };
    scheduler.submit({ at: now, recent: [yieldEvent, { ...yieldEvent, key: 'second-yield' }, partyEvent].map(e => ({ ...e, at: now })) });
    await scheduler.running;
    assert.deepStrictEqual(scheduled, ['offer_party', 'yield'], 'accepted invitations cannot be starved by yield traffic');
    assert.strictEqual(scheduler.report.budgetSkipped, 1);
    const conflictScheduler = new ColdCompetitionActions({ now: () => now, conflictsEnabled: () => true });
    const selectedActions = [];
    conflictScheduler.apply = async e => { selectedActions.push(e.action); return { ok: true }; };
    conflictScheduler.submit({ at: now, recent: [yieldEvent, dispute, partyEvent].map(e => ({ ...e, at: now })) });
    await conflictScheduler.running;
    assert.deepStrictEqual(selectedActions, ['offer_party', 'contest']);
    assert.strictEqual(conflictScheduler.snapshot().contests, 1);
    assert.strictEqual(conflictScheduler.snapshot().mode, 'resource_conflicts');
    console.log('Cold competition native SQLite yield, atomic party, duplicate delivery and reopen checks passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
