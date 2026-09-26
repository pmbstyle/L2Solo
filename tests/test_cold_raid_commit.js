const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
require('../src/Global');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Raid = require('../src/GameServer/Bot/Population/ColdRaidEncounter');
const Authority = require('../src/GameServer/Bot/Population/ColdRaidAuthority');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-raid-commit-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const at = Date.now();
const spot = { id: 'raid:10484', raidBoss: true, raidBossTemplateId: 10484, raidInstanceId: 'spawn-one' };
const state = id => Life.cachedState(id);
async function createParty(ids) {
    const prepared = Parties.prepareCommit({ partyId: `raid-${ids[0]}`, leaderId: ids[0], memberIds: ids,
        spotId: spot.id, status: 'active', startedAt: at, nextResolveAt: at + 45000,
        stats: { objective: { sourceKind: 'raid', npcId: 10484, sourceLevel: 40 },
            raidEncounter: { status: 'active' }, raidPreparation: { ready: true } } });
    const assigned = ids.map(id => Life.preparePartyAssignment(state(id), prepared.row.partyId, 'dps', ids[0], at + 45000));
    assert((await Database.commitBackgroundPartyMembership({ party: prepared.row, members: assigned })).ok);
    Life.acceptPartyAssignments(assigned);
    return Parties.acceptCommit(prepared);
}
async function proposed(party, id, snapshot) {
    const members = party.memberIds.map(state);
    const { grants } = await Owner.claimBatch(members, { allowParty: true, allowLifecycle: true });
    assert.equal(grants.length, 9);
    const atomicGroup = { id, memberIds: party.memberIds,
        partyChanges: [{ partyId: party.partyId, memberIds: party.memberIds, expectedUpdatedAt: party.updatedAt,
            updatedAt: Math.max(Date.now(), party.updatedAt + 1), nextResolveAt: null, status: 'dissolved',
            statsJson: JSON.stringify({ ...party.stats, raidEncounter: snapshot }) }],
        raidCommit: { key: snapshot.key, expectedRevision: 0, revision: 1, snapshot,
            worldDefeat: { npcId: 10484, respawnTime: at + 100000 } } };
    const entries = members.map(member => ({ token: grants.find(g => g.characterId === member.characterId), atomicGroup,
        options: { allowParty: true, allowLifecycle: true }, proposal: { baseState: member },
        nextState: { ...member, exp: member.exp + 100, adena: member.adena + 10,
            inventory: { ...member.inventory, 57: { selfId: 57, amount: 10 } } } }));
    return { entries, grants };
}
async function durable() {
    return {
        lives: await Database.execute(['SELECT characterId,exp,adena,hp FROM bot_life_state ORDER BY characterId', []]),
        characters: await Database.execute(['SELECT id,exp,hp FROM characters ORDER BY id', []]),
        inventory: await Database.execute(['SELECT * FROM items ORDER BY id', []]),
        parties: await Database.execute(['SELECT * FROM bot_background_parties ORDER BY partyId', []]),
        raids: await Database.execute(['SELECT * FROM bot_raid_encounters', []]),
        spawns: await Database.execute(['SELECT * FROM raid_boss_state', []])
    };
}
async function run() {
    Database.init(); invoke('GameServer/DataCache').init();
    for (let id = 1; id <= 18; id++) {
        await Database.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`raid_${id}`, 'test']]);
        await Database.execute([`INSERT INTO characters(id,username,name,classId,race,maxHp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,100,100,0,0,0,0,0,0,0)`, [id, `raid_${id}`, `Raid${id}`]]);
        await Database.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            nextResolveAt,lastResolvedAt,updatedAt,statsJson) VALUES (?,?,?,'cold','hunting',?,100,100,100,100,40,?,?,?,'{}')`,
        [id, `raid_${id}`, `Raid${id}`, spot.id, at + 60000, at - 30000, at]]);
    }
    await Life.init(); await Parties.init();
    const a = await createParty(Array.from({ length: 9 }, (_, i) => i + 1));
    const b = await createParty(Array.from({ length: 9 }, (_, i) => i + 10));
    Raid.record(a, Raid.begin(a, spot, 10484, at), { encounter: { hp: 600, mob: { maxHp: 1000 } } }, at + 1);
    const win = id => Raid.stage({ key: 'raid:10484', id, memberIds: a.memberIds }, () =>
        Raid.record(a, Raid.begin(a, spot, 10484, at + 2), { won: true }, at + 3));
    const initial = await durable();
    const staged = await win('rejected');
    assert.equal(staged.snapshot.hp, 0);
    assert.equal(Raid.begin(b, spot, 10484, at + 4).hp, 600, 'another clan never sees an uncommitted kill');
    await assert.rejects(win('competing'), /raid_step_pending/);
    const failed = await proposed(a, 'rejected', staged.snapshot);
    failed.entries[8].token = { ...failed.entries[8].token, revision: failed.entries[8].token.revision - 1 };
    const rejected = await Owner.commitAndReleaseBatch(failed.entries);
    assert(rejected.every(row => !row.ok));
    for (const row of rejected.slice(0, 8)) Raid.acknowledge('rejected', row.characterId, row.ok);
    await assert.rejects(win('still-pending'), /raid_step_pending/, 'paged ACKs retain the boss fence');
    Raid.acknowledge('rejected', rejected[8].characterId, false);
    assert.equal(Raid.begin(b, spot, 10484, at + 5).hp, 600);
    assert.deepEqual(await durable(), initial, 'one stale member rolls back party, inventory, rewards and boss');
    await Owner.releaseBatch(failed.grants);

    const crashStage = await win('sql-failure');
    const crash = await proposed(a, 'sql-failure', crashStage.snapshot);
    await Database.execute([`CREATE TRIGGER reject_raid_party BEFORE UPDATE ON bot_background_parties
        BEGIN SELECT RAISE(ABORT, 'synthetic raid party write failure'); END`, []]);
    await assert.rejects(Owner.commitAndReleaseBatch(crash.entries), /synthetic raid party write failure/);
    assert.deepEqual(await durable(), initial, 'SQL failure after physical writes rolls back the entire transaction');
    await Database.execute(['DROP TRIGGER reject_raid_party', []]);
    Raid.abort('sql-failure'); await Owner.releaseBatch(crash.grants);

    const success = await win('winner');
    const first = await proposed(a, 'winner', success.snapshot);
    const second = await proposed(b, 'competitor', { ...success.snapshot, winnerPartyId: b.partyId });
    const results = await Owner.commitAndReleaseBatch([...first.entries, ...second.entries]);
    const accepted = results.filter(row => row.ok), refused = results.filter(row => !row.ok);
    assert.equal(accepted.length, 9); assert.equal(refused.length, 9);
    assert(refused.every(row => row.detail === 'raid_revision_changed'));
    assert(accepted.every(row => row.raidRow.revision === 1 && row.raidPartyRow.status === 'dissolved'));
    for (const row of accepted.slice(0, 8)) Raid.acknowledge('winner', row.characterId, true);
    assert.equal(Raid.begin(b, spot, 10484, at + 6).hp, 600, 'publish only after all member confirmations');
    Raid.acknowledge('winner', accepted[8].characterId, true);
    assert.equal(Raid.begin(b, spot, 10484, at + 7).status, 'defeated');
    Raid.acknowledge('winner', accepted[8].characterId, true);
    const committed = await durable();
    assert(committed.lives.slice(0, 9).every(row => row.exp === initial.lives[0].exp + 100 && row.adena === 10));
    assert.equal(committed.raids.length, 1); assert.equal(committed.spawns[0].hp, 0);
    assert((await Owner.commitAndReleaseBatch(first.entries)).every(row => !row.ok));
    assert.deepEqual(await durable(), committed, 'replayed proposals cannot grant rewards twice');
    await Owner.releaseBatch(second.grants);
    await Database.close(); Database.init(); await Authority.init(); Raid.resetForTests();
    assert.equal(Raid.begin(b, { ...spot, raidAuthority: Authority.get('raid:10484').snapshot }, 10484).status, 'defeated',
        'shared authority survives a process-local reset and database reopen');

    // Exercise the actual worker proposal and rejection path, not just the store API.
    Raid.resetForTests();
    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => at + 100, emit: (type, data) => messages.push({ type, data }),
        resolveSolo: () => ({}), projectResolve: member => member,
        resolveParty: ({ party, members, spot }) => {
            const snapshot = Raid.record(party, Raid.begin(party, spot, 10484), { won: true });
            return { partyPatch: { stats: { raidEncounter: snapshot } }, nextResolveAt: at + 200,
                memberResults: members.map(state => ({ state, result: { events: [] } })), events: [] };
        } });
    const members = a.memberIds.map(state);
    kernel.partyRuns.set(a.partyId, { party: a, members, spot: { ...spot, raidAuthorityRevision: 0 },
        grants: new Map(members.map(member => [member.characterId, { leaseId: 'kernel', revision: 1, characterId: member.characterId }])) });
    await kernel.resolvePartyGrant(a.partyId);
    const proposals = messages.filter(message => message.type === 'proposal_batch').flatMap(message => message.data.proposals);
    assert.equal(proposals.length, 9, JSON.stringify(messages));
    assert(proposals.every(p => p.raidStepId === 'raid:kernel' && p.atomicGroup.partyChanges.length === 1
        && p.atomicGroup.raidCommit.expectedRevision === 0));
    assert.equal(Raid.begin(b, spot, 10484).status, 'active');
    kernel.onCommitAck({ results: proposals.map(p => ({ characterId: p.characterId, raidStepId: p.raidStepId, ok: false })) });
    assert.equal(Raid.begin(b, spot, 10484).status, 'active');
    const afterReject = await win('after-kernel-rejection'); Raid.abort('after-kernel-rejection');
    assert.equal(afterReject.snapshot.status, 'defeated');
    await win('oversized');
    for (const id of a.memberIds) kernel.dirty.set(id, { characterId: id, priority: 'P1', enqueuedAt: at,
        raidStepId: 'oversized', atomicGroup: { id: 'oversized', memberIds: a.memberIds, padding: 'x'.repeat(300000) } });
    kernel.flush(null, true);
    assert.equal(kernel.dirty.size, 0);
    await win('after-oversized'); Raid.abort('after-oversized');

    const Index = invoke('GameServer/World/RaidEntityIndex');
    const originalBoss = Index.bossByTemplateId;
    try {
        Index.bossByTemplateId = () => ({ raidInstanceId: 'spawn-current', fetchSelfId: () => 10484,
            spawnDefinition: { npc: { template: { raidBoss: true } }, spawn: { respawn: 3600 } },
            state: { fetchDead: () => false } });
        assert.equal(Authority.prepare({ key: 'raid:10484', snapshot: { raidInstanceId: 'spawn-old', status: 'defeated' } }), false,
            'main process rejects work against an earlier boss generation');
        const valid = { key: 'raid:10484', snapshot: { raidInstanceId: 'spawn-current', status: 'defeated', defeatedAt: at } };
        assert.equal(Authority.prepare(valid), true);
        assert.equal(valid.worldDefeat.respawnTime, at + 5 * 60 * 60 * 1000,
            'atomic cold victory persists the same five real hours as hot combat');
        Index.bossByTemplateId = () => ({ raidInstanceId: 'spawn-current', isDead: () => true });
        assert.equal(Authority.prepare(valid), false, 'a live player kill fences pending cold rewards');
    } finally { Index.bossByTemplateId = originalBoss; }
    const durableRevision = Authority.get('raid:10484');
    Authority.accept({ raidKey: 'raid:10484', revision: 0, snapshotJson: '{}' });
    assert.equal(Authority.get('raid:10484'), durableRevision, 'late cache deliveries cannot rewind shared authority');

    const Resolver = require('../src/GameServer/Bot/Population/BackgroundPartyResolver');
    const originalResolve = Resolver.resolve;
    const originalPrepare = Life.prepareResolve;
    let projections = 0;
    try {
        Resolver.resolve = ({ party, members, spot, timestamp }) => {
            const snapshot = Raid.record(party, Raid.begin(party, spot, 10485, timestamp), { won: true }, timestamp);
            return { partyPatch: { status: 'dissolved', stats: { raidEncounter: snapshot, partyBreakReason: 'raid_defeated' } },
                nextResolveAt: null, events: [], debug: {}, memberResults: members.map(state => ({ state, result: {
                    patch: {}, materialize: { exp: 100, adena: 10, items: [] }, events: [], nextResolveAt: timestamp + 30000
                } })) };
        };
        Life.prepareResolve = function (state, result, options) {
            assert.equal(options.projectClassProgression, true, 'fallback must not write class progression before the transaction');
            assert.equal(options.persist, false); projections++;
            return originalPrepare.call(this, state, result, options);
        };
        const outcome = await require('../src/GameServer/Bot/Population/ColdRaidLegacyCommit').resolve({
            party: b, members: b.memberIds.map(state), spot: { ...spot, id: 'raid:10485', raidBossTemplateId: 10485 },
            targetNpcId: 10485, elapsedMs: 60000
        });
        assert.equal(outcome.ok, true); assert.equal(projections, 9);
        assert.equal(outcome.party.status, 'dissolved');
        assert(b.memberIds.every(id => !state(id).party?.partyId && state(id).adena === 10));
        const [legacyBoss] = await Database.execute(['SELECT revision FROM bot_raid_encounters WHERE raidKey=?', ['raid:10485']]);
        assert.equal(legacyBoss.revision, 1);
    } finally { Resolver.resolve = originalResolve; Life.prepareResolve = originalPrepare; }
    console.log('Cold raid commit: 9-member atomicity, SQL rollback, ACK fencing, clan competition, replay and durable reload passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
    Raid.resetForTests(); await Database.close(); fs.rmSync(dir, { recursive: true, force: true });
});
