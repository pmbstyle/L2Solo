const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const Conflict = require('../src/GameServer/Bot/Population/ColdPartyConflict');
const Wait = require('../src/GameServer/Bot/Population/ColdCompetitionWait');
const { ColdCompetitionActions, WAIT_MS } = require('../src/GameServer/Bot/Population/ColdCompetitionActions');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-party-conflict-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now();
const range = (start, count) => Array.from({ length: count }, (_, i) => start + i);
const state = id => Life.cachedState(id);
const base = { life: Life, owner: Owner, parties: Party, memory: Memory, now: () => at,
    participantAllowed: () => true, contestContextAllowed: () => true, onState: () => {},
    personaFor: () => ({ traits: { empathy: 0, assertiveness: 1, commitment: 1, sociability: 1, caution: 0 } }),
    waitMs: WAIT_MS, cooldownMs: 600000, rng: () => 0.2 };
async function createParty(ids, name = `party-${ids[0]}`) {
    const prepared = Party.prepareCommit({ partyId: name, leaderId: ids[0], memberIds: ids,
        spotId: 'test', status: 'active', startedAt: at, nextResolveAt: at + 45000, stats: { objective: { npcId: 10 } } });
    const assigned = ids.map(id => Life.preparePartyAssignment(state(id), name, 'dps', ids[0], at + 45000));
    assert((await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned })).ok);
    Life.acceptPartyAssignments(assigned);
    return Party.acceptCommit(prepared);
}
function event(a, b) {
    const participant = id => {
        const party = Party.find(state(id).party?.partyId);
        return { id, revision: state(id).simulation.revision, memoryRevision: Memory.snapshot(id).revision,
            partyId: party?.partyId, partyUpdatedAt: party?.updatedAt, size: party?.memberIds.length || 1 };
    };
    return { key: `competition:${a}:${b}`, at, pressure: 3, spotId: 'test', npcId: 10, action: 'contest',
        actor: participant(a), peer: participant(b) };
}
const apply = (a, b, overrides = {}) => Conflict.apply({ ...base, event: event(a, b), ...overrides });
async function run() {
    Database.init();
    const stats = { equipmentPlan: { status: 'active', next: { npcId: 10, spotId: 'test' } } };
    for (const id of range(1, 52)) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_conflict_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `bot_conflict_${id}`, `Conflict${id}`]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            nextResolveAt,lastResolvedAt,updatedAt,statsJson) VALUES (?,?,?,'cold','hunting','test',100,100,100,100,20,?,?,?,?)`,
        [id, `bot_conflict_${id}`, `Conflict${id}`, at + 60000, at - 30000, at, JSON.stringify(stats)]]);
    }
    await Life.init();
    await Party.init();
    await Memory.ensureMany(range(1, 52));
    await createParty([1, 2, 3]);
    const firstEvent = event(1, 4);
    const first = await apply(1, 4);
    assert(first.ok, JSON.stringify(first));
    assert.strictEqual(first.matchup, 'party_vs_solo');
    assert.deepStrictEqual(first.affectedIds, [4]);
    assert.strictEqual(first.memoryEvents, 3);
    assert.strictEqual(state(4).timing.nextResolveAt, at + 60000 + WAIT_MS);
    assert.strictEqual(Party.find('party-1').nextResolveAt, at + 45000);
    assert.strictEqual(Memory.snapshot(4).relations.length, 3, 'target remembers the three actual aggressors');
    assert.strictEqual(Memory.snapshot(2).relations.length, 0, 'aggressors do not invent reciprocal offenses');
    assert.strictEqual((await Conflict.apply({ ...base, event: firstEvent })).ok, false, 'duplicate delivery cannot repeat the episode');

    await createParty([6, 7, 8]);
    const soloParty = await apply(5, 6);
    assert(soloParty.ok, JSON.stringify(soloParty));
    assert.strictEqual(soloParty.matchup, 'solo_vs_party');
    assert.deepStrictEqual(soloParty.affectedIds, [6, 7, 8]);
    const pausedParty = Party.find('party-6'), pausedMembers = [6, 7, 8].map(state);
    assert.strictEqual(pausedParty.nextResolveAt, at + 45000 + WAIT_MS);
    assert(pausedMembers.every(s => s.timing.nextResolveAt === pausedParty.nextResolveAt));
    assert.strictEqual(Wait.consumeParty(pausedParty, pausedMembers, 75000, at + 30000).elapsedMs, 60000,
        'shared loss is deducted once, not once per member');
    const resumed = Wait.consumeParty(pausedParty, pausedMembers, 75000, at + 30000);
    assert.strictEqual(resumed.party.stats.coldCompetition.wait, null);
    assert(resumed.members.every(s => s.stats.coldCompetition.wait === null));
    assert.strictEqual(Wait.consumeParty(resumed.party, resumed.members, 60000, at + 90000).elapsedMs, 60000);
    assert.strictEqual(Wait.consume({ ...pausedMembers[0], activity: 'hunting' }, 75000, at + 30000).elapsedMs, 60000,
        'a departed member retains its lost time');
    const Resolver = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
    const blocked = Resolver.resolve({ party: pausedParty, members: pausedMembers, timestamp: at + 5000 });
    assert.strictEqual(blocked.debug.fights, 0);
    assert(blocked.memberResults.every(r => r.result.materialize.exp === 0));
    const consumedOnly = Resolver.resolve({ party: pausedParty, members: pausedMembers, elapsedMs: WAIT_MS, timestamp: at + WAIT_MS });
    assert.strictEqual(consumedOnly.debug.fights, 0, 'zero farming time cannot become the normal minimum of one fight');
    assert.strictEqual(consumedOnly.partyPatch.stats.coldCompetition.wait, null);
    assert(consumedOnly.memberResults.every(r => r.result.patch.stats.coldCompetition.wait === null));
    const resting = Wait.consumeParty(pausedParty, pausedMembers.map(s => ({ ...s, activity: 'resting' })), 75000, at + 30000);
    assert.strictEqual(resting.elapsedMs, 75000, 'a resource dispute cannot reduce recovery');

    await createParty(range(9, 9));
    await createParty(range(18, 9));
    const full = await apply(9, 18);
    assert(full.ok, JSON.stringify(full));
    assert.strictEqual(full.matchup, 'party_vs_party');
    assert.strictEqual(full.participants.length, 18);
    assert.strictEqual(full.memoryEvents, 17, '9v9 attribution is linear, not 81 relationships');
    assert.strictEqual(Memory.snapshot(18).relations.length, 9);
    assert.strictEqual(Memory.snapshot(19).relations.length, 1);

    await createParty([27, 28]);
    const calm = await apply(28, 29, { rng: () => 0, personaFor: () => ({ traits: { empathy: 1, assertiveness: 0 } }) });
    assert(calm.ok && calm.deescalated, JSON.stringify(calm));
    assert.strictEqual(calm.memoryEvents, 0);
    assert.strictEqual(Party.find('party-27').nextResolveAt, at + 45000);
    assert(!state(29).stats.coldCompetition.wait);
    assert.strictEqual(Memory.snapshot(29).relations.length, 0);
    const rotated = event(27, 30);
    rotated.at = at + 120001;
    assert.strictEqual((await Conflict.apply({ ...base, now: () => rotated.at, event: rotated })).reason, 'conflict_cooldown',
        'changing the instigator cannot evade the durable group cooldown');

    await createParty([31, 32]);
    const bystander = await apply(31, 33, { rng: () => 0.95 });
    assert(bystander.ok, JSON.stringify(bystander));
    assert.strictEqual(bystander.outcome, 'held_ground');
    assert.strictEqual(bystander.participants.find(p => p.id === 32).role, 'stand_aside');
    assert.strictEqual(bystander.memoryEvents, 1);
    assert.deepStrictEqual(Memory.snapshot(33).relations.map(r => r.targetId), [31]);

    await createParty([34, 35]);
    assert.strictEqual((await apply(34, 36, { participantAllowed: id => id !== 35 })).ok, false, 'a hot handoff on a nonprincipal member fences the group');
    assert.strictEqual((await apply(34, 36, { contestContextAllowed: s => s.characterId !== 35 })).ok, false, 'every member must physically occupy the spot');
    assert.strictEqual((await apply(34, 36, { memory: { ...Memory, snapshot: id => id === 35 ? null : Memory.snapshot(id) } })).ok, false);
    assert.strictEqual((await apply(34, 36, { event: { ...event(34, 36), actor: { ...event(34, 36).actor, size: 1 } } })).reason, 'party_changed');
    const partial = await apply(34, 36, { owner: { ...Owner, claimBatch: (states, opts) => Owner.claimBatch(states.slice(0, 2), opts) } });
    assert.strictEqual(partial.reason, 'claim_rejected');
    assert([34, 35, 36].every(id => !state(id).simulation.leaseId), 'partial grants are released');
    const race = await apply(34, 36, { owner: { ...Owner, commitAndReleaseBatch: async (entries, opts) => {
        await Database.execute(['UPDATE bot_background_parties SET updatedAt=updatedAt+1 WHERE partyId=?', ['party-34']]);
        return Owner.commitAndReleaseBatch(entries, opts);
    } } });
    assert.strictEqual(race.reason, 'commit_rejected');
    const rows = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN (34,35,36)', []]);
    assert(rows.every(r => !JSON.parse(r.statsJson).coldCompetition), 'party metadata race aborts every physical outcome');
    assert.strictEqual((await Repository.load(36)).relations.length, 0);

    await createParty([37, 38]);
    await assert.rejects(() => apply(37, 39, { owner: { ...Owner, commitAndReleaseBatch: (entries, opts) => {
        entries.find(e => e.proposal.result.memoryEvents.length).proposal.result.memoryEvents[0].key = '';
        return Owner.commitAndReleaseBatch(entries, opts);
    } } }), /memory/i);
    const rolledParty = await Database.execute(['SELECT statsJson,nextResolveAt FROM bot_background_parties WHERE partyId=?', ['party-37']]);
    assert(!JSON.parse(rolledParty[0].statsJson).coldCompetition);
    assert.strictEqual(rolledParty[0].nextResolveAt, at + 45000);
    const rolledStates = await Database.execute(['SELECT statsJson FROM bot_life_state WHERE characterId IN (37,38,39)', []]);
    assert(rolledStates.every(r => !JSON.parse(r.statsJson).coldCompetition), 'memory failure rolls back life states and party row together');

    await createParty([40, 41]);
    const actions = new ColdCompetitionActions({ ...base, conflictsEnabled: () => true });
    const routed = await actions.apply(event(40, 42));
    assert(routed.ok, JSON.stringify(routed));
    assert.strictEqual(routed.matchup, 'party_vs_solo', 'real action dispatch reaches group execution');
    assert.strictEqual(routed.pvp, false);

    await createParty([43, 44]);
    const staleMember = await apply(43, 45, { owner: { ...Owner, commitAndReleaseBatch: async (entries, opts) => {
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=44', []]);
        return Owner.commitAndReleaseBatch(entries, opts);
    } } });
    assert.strictEqual(staleMember.reason, 'commit_rejected', 'a nonprincipal member CAS rejects the whole group');
    assert.strictEqual((await Repository.load(45)).relations.length, 0);
    assert(!Party.find('party-43').stats.coldCompetition);
    await createParty([46, 47]);
    const rosterRace = await apply(46, 48, { owner: { ...Owner, commitAndReleaseBatch: async (entries, opts) => {
        await Database.execute(['UPDATE bot_background_parties SET memberIdsJson=? WHERE partyId=?', ['[46,52]', 'party-46']]);
        return Owner.commitAndReleaseBatch(entries, opts);
    } } });
    assert.strictEqual(rosterRace.reason, 'commit_rejected', 'full roster identity is checked even without a version increment');
    assert.strictEqual((await Repository.load(48)).relations.length, 0);
    await createParty([49, 50]);
    const memoryRace = await apply(49, 51, { owner: { ...Owner, claimBatch: async (...args) => {
        const result = await Owner.claimBatch(...args);
        Memory.accept({ ...Memory.snapshot(50), revision: Memory.snapshot(50).revision + 1 });
        return result;
    } } });
    assert.strictEqual(memoryRace.reason, 'contest_changed_during_claim');
    assert([49, 50, 51].every(id => !state(id).simulation.leaseId));
    await Database.close();
    Database.init();
    const persisted = await Database.execute(['SELECT statsJson,nextResolveAt FROM bot_background_parties WHERE partyId=?', ['party-6']]);
    assert.strictEqual(persisted[0].nextResolveAt, pausedParty.nextResolveAt);
    assert.strictEqual(JSON.parse(persisted[0].statsJson).coldCompetition.wait.until, at + WAIT_MS);
    assert.strictEqual(JSON.parse(persisted[0].statsJson).coldCompetition.conflictUntil, at + 600000);
    assert.strictEqual((await Repository.load(18)).relations.length, 9);
    console.log('Cold party conflicts: all matchups, 9v9 bounds, individual roles, shared time, CAS rollback and reopen passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
