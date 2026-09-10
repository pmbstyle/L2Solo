const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path');
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Party = invoke('GameServer/Bot/Population/BackgroundPartyResolver');
const Memory = invoke('GameServer/Social/InteractionMemoryRuntime');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-cold-revival-'));
options.default.Database.path = path.join(dir, 'test.sqlite');
const realNow = Date.now; let at = realNow(); Date.now = () => at;
const states = () => [1, 2].map(id => Life.cachedState(id));
let party;
function resolve(members = states()) { return Party.resolve({ party, members, spot: { id: 'test' }, timestamp: at,
    episodeId: `revive:${at}`, assessRelationship: Memory.assess.bind(Memory) }); }
async function commit(resolution, reject = false) {
    const { grants } = await Owner.claimBatch(states(), { timestamp: at, allowParty: true, allowLifecycle: true });
    const entries = await Promise.all(resolution.memberResults.map(async ({ state, result }) => {
        const projection = await Life.prepareResolve(state, result, { timestamp: at, persist: false, projectClassProgression: true });
        return { token: grants.find(g => g.characterId === state.characterId), nextState: projection,
            options: { allowParty: true, allowLifecycle: true }, atomicGroup: { id: `revive:${at}`, memberIds: [1, 2] },
            proposal: { baseState: state, result } };
    }));
    if (reject) entries[0].token = { ...entries[0].token, leaseId: 'stale' };
    const results = await Owner.commitAndReleaseBatch(entries, { timestamp: at });
    await Owner.releaseBatch(grants, { timestamp: at });
    return results;
}
async function run() {
    invoke('GameServer/DataCache').init(); DB.init();
    for (const id of [1, 2]) {
        await DB.execute(['INSERT INTO accounts(username,password) VALUES (?,?)', [`bot_revive_${id}`, 'test']]);
        await DB.execute([`INSERT INTO characters(id,username,name,classId,race,level,hp,maxHp,mp,maxMp,sex,face,hair,hairColor,locX,locY,locZ)
            VALUES (?,?,?,0,0,20,?,1000,500,500,0,0,0,0,50000,15000,-5000)`, [id, `bot_revive_${id}`, `Revive${id}`, id === 1 ? 0 : 1000]]);
        const stats = { deaths: id === 1 ? 1 : 0, coldPvp: { recoverUntil: id === 1 ? at + 90000 : 0 },
            coldCombat: { version: 1, classId: 0, skills: id === 2
                ? [{ selfId: 1016, level: 1, spell: true, passive: false, power: 0, mp: 50, hitTime: 4000, reuse: 10000 }] : [] } };
        await DB.execute([`INSERT INTO bot_life_state(characterId,accountName,characterName,phase,activity,spotId,hp,maxHp,mp,maxMp,level,
            locX,locY,locZ,nextResolveAt,lastResolvedAt,updatedAt,statsJson)
            VALUES (?,?,?,'cold',?,'test',?,1000,500,500,20,50000,15000,-5000,?,?,?,?)`,
            [id, `bot_revive_${id}`, `Revive${id}`, id === 1 ? 'dead' : 'grouped', id === 1 ? 0 : 1000, at, at - 1000, at, JSON.stringify(stats)]]);
    }
    await Life.init(); await Parties.init(); await Memory.ensureMany([1, 2]);
    const prepared = Parties.prepareCommit({ partyId: 'revival-party', leaderId: 2, memberIds: [1, 2], status: 'active', spotId: 'test', startedAt: at, stats: {} });
    const assigned = states().map(s => Life.preparePartyAssignment(s, 'revival-party', 'dps', 2, at));
    assert((await DB.commitBackgroundPartyMembership({ party: prepared.row, members: assigned })).ok);
    Life.acceptPartyAssignments(assigned); party = Parties.acceptCommit(prepared);
    const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
    const messages = [];
    const kernel = new ColdSimulationKernel({ now: () => at, resolveSolo: () => { throw Error('party must remain together'); }, resolveParty: input => Party.resolve(input),
        emit: (type, payload) => messages.push({ type, payload }) });
    const roster = states(), expired = { ...party, stats: { ...party.stats, sessionExpiresAt: at - 1 } };
    roster.forEach(s => kernel.upsert({ state: s, context: s.characterId === 2
        ? { isPartyLeader: true, party: expired, partyMembers: roster, spot: { id: 'test' } } : {} }));
    kernel.tick();
    const claim = messages.find(m => m.type === 'claim_request'); assert(claim);
    kernel.onClaimAck({ grants: claim.payload.candidates.map(c => ({ ok: true, characterId: c.characterId,
        ownerId: 'cold_simulation_owner', revision: c.expectedRevision + 1, leaseId: `revival-${c.characterId}`,
        leaseUntil: at + 30000, purpose: c.purpose })) });
    await kernel.resolveChain;
    const batch = messages.find(m => m.type === 'proposal_batch'); assert(batch, JSON.stringify(messages));
    assert(batch.payload.proposals.every(p => p.atomicGroup?.memberIds.length === 2), 'the real worker groups revival and MP writes even without gratitude');
    assert(batch.payload.proposals.some(p => p.result.debug.reason === 'party_resurrected'), 'rescue precedes an expired social party review');
    assert.strictEqual(messages.filter(m => m.type === 'proposal_batch').length, 1, 'one worker result completes the entire rescue');
    const input = JSON.stringify(states()), revived = resolve();
    for (const patch of [
        s => ({ ...s, vitals: { ...s.vitals, mp: 0 } }),
        s => ({ ...s, loc: { ...s.loc, locX: s.loc.locX + 5000 } }),
        s => ({ ...s, stats: { ...s.stats, coldCombat: { ...s.stats.coldCombat, skills: [] } } })
    ]) assert.notStrictEqual(resolve(states().map(s => s.characterId === 2 ? patch(s) : s)).debug.reason,
        'party_resurrected', 'a rescue requires a nearby living provider with learned skill and real MP');
    const fighting = states().map(s => ({ ...s, stats: { ...s.stats, pvpEncounter: { key: 'active' } } }));
    assert(resolve(fighting).memberResults.every(e => !e.result.patch.vitals), 'active PvP pauses the party before revival can run');
    assert.strictEqual(require('../src/GameServer/Bot/Population/ColdPartyRevival').resolve({ party, members: fighting,
        timestamp: at, episodeId: 'fighting' }), null);
    const hot = states().map(s => ({ ...s, phase: 'hot' }));
    assert.strictEqual(require('../src/GameServer/Bot/Population/ColdPartyRevival').resolve({ party, members: hot,
        timestamp: at, episodeId: 'hot' }), null, 'hot actors cannot receive a cold rescue');
    assert.strictEqual(revived.debug.reason, 'party_resurrected');
    assert(revived.atomic && revived.nextResolveAt === at + 15000);
    assert.strictEqual(JSON.stringify(states()), input, 'forecast cannot spend mana or revive');
    assert((await commit(revived, true)).every(r => !r.ok));
    assert.strictEqual(Life.cachedState(2).vitals.mp, 500, 'rejected action cannot spend mana');
    assert.strictEqual(Life.cachedState(1).vitals.hp, 0, 'rejected action cannot revive');
    assert.strictEqual((await Repository.load(1)).relations.length, 0, 'rejected action cannot leave gratitude');
    const accepted = await commit(resolve()); assert(accepted.every(r => r.ok), JSON.stringify(accepted));
    assert.strictEqual(Life.cachedState(2).vitals.mp, 450);
    assert.strictEqual(Life.cachedState(1).vitals.hp, 1);
    assert(states().every(s => !Object.hasOwn(s.stats, 'coldRevival')), 'the outcome creates no intermediate cast state');
    assert.strictEqual(Life.cachedState(1).stats.coldPvp.recoverUntil, 0);
    assert((await Repository.load(1)).relations.some(r => r.targetId === 2 && r.lastHelpAt.resurrected === at));
    assert.notStrictEqual(resolve().debug.reason, 'party_resurrected');
    const memory = await Repository.load(1);
    await DB.close(); DB.init();
    assert.deepStrictEqual(await Repository.load(1), memory);
    const rows = await DB.execute(['SELECT id,hp,mp FROM characters WHERE id IN (1,2) ORDER BY id', []]);
    assert.strictEqual(rows[0].hp, 1); assert.strictEqual(rows[1].mp, 450, 'one committed outcome survives SQLite reopen');
    console.log('Cold resurrection: one atomic outcome, actual skill/MP, recovery pause, rejected ownership and persisted gratitude passed');
}
run().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    Date.now = realNow; await DB.close(); fs.rmSync(dir, { recursive: true, force: true });
});
