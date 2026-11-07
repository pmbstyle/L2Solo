'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
const world = require('./fixtures/native_stock_world')();
require('../src/Global');
const DB = invoke('Database'), Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Owner = invoke('GameServer/Bot/Population/ColdSimulationOwner');
const Agreement = require('../src/GameServer/Bot/Population/PartyAgreement');
const Route = require('../src/GameServer/Bot/Population/CraftMaterialPartyRoute');
const Kernel = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const point = { locX: 145224, locY: 120001, locZ: -4500 }, wallet = 10000, fee = 1001;
let timestamp = Date.now();
async function seed(index) {
    const account = `bot_material_trip_${index}`;
    await DB.createAccount(account, 'fixture');
    const id = Number((await DB.createCharacter(account, { name: `MaterialTrip${index}`, classId: index ? 16 : 8,
        race: 0, sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...point })).insertId);
    await DB.execute(['UPDATE characters SET level=65,hp=1000,mp=1000 WHERE id=?', [id]]);
    await DB.setItem(id, { selfId: 57, name: 'Adena', amount: wallet, slot: 0 });
    return Life.upsertState({ characterId: id, accountName: account, name: `MaterialTrip${index}`,
        level: 65, exp: 0, sp: 0, phase: 'cold', activity: 'hunting', spotId: 'old-source', loc: point,
        adena: wallet, inventory: Life.inventorySummaryFromItems(await DB.fetchItems(id)),
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 },
        timing: { nextResolveAt: timestamp, lastResolvedAt: timestamp - 1000 },
        stats: { classId: index ? 16 : 8, role: index ? 'healer' : 'dps',
            ...(index ? {} : { equipmentPlan: { status: 'active', target: { selfId: 148, slot: 7 } } }) } }, 'material_trip_fixture');
}
async function partyRow(id) { return (await DB.execute(['SELECT * FROM bot_background_parties WHERE partyId=?', [id]]))[0]; }
async function image() {
    return Promise.all([
        DB.execute(['SELECT * FROM bot_life_state ORDER BY characterId', []]),
        DB.execute(['SELECT * FROM bot_background_parties ORDER BY partyId', []]),
        DB.execute(['SELECT * FROM characters ORDER BY id', []]),
        DB.execute(['SELECT * FROM items ORDER BY id', []])
    ]);
}
async function proposals(party, route, at) {
    const members = party.memberIds.map(id => Life.cachedState(id));
    const messages = [];
    const kernel = new Kernel.ColdSimulationKernel({ now: () => at,
        resolveSolo: () => { throw Error('no solo combat in a trip'); },
        resolveParty: () => { throw Error('no party combat in a trip'); },
        partyRoute: () => route,
        emit: (type, payload) => messages.push({ type, payload }) });
    for (const member of members) {
        const current = Life.cachedState(member.characterId);
        kernel.upsert({ state: current });
        kernel.inFlight.set(member.characterId, { state: current, startedAt: at, partyId: party.partyId });
    }
    kernel.partyRuns.set(party.partyId, { party, members, startedAt: at });
    await kernel.resolvePartyStep(party.partyId);
    const rows = messages.find(message => message.type === 'proposal_batch')?.payload.proposals;
    assert(rows, JSON.stringify(messages));
    return { entries: rows.map(proposal => ({ revision: proposal.revision, nextState: proposal.nextState,
        options: proposal.options, atomicGroup: proposal.atomicGroup, proposal })) };
}
async function commit(prepared, at) {
    const results = await Owner.commitBatch(prepared.entries, { timestamp: at });
    assert(results.every(row => row.ok), JSON.stringify(results));
    assert(results[0].partyRow, 'material transitions persist their party row in the native transaction');
    return Parties.acceptRow(results[0].partyRow);
}
const trip = (members, spotId, extra = {}) => ({ needed: true, mode: 'party', spotId, regionName: spotId,
    reason: 'party_spot_replan', travelMs: 1000, destinations: Object.fromEntries(members.map((member, i) =>
        [member.characterId, { ...point, locX: point.locX + 100 + i * 20 }])), ...extra });
async function main() {
    DB.init(); invoke('GameServer/DataCache').init(); await Life.init(); await Parties.init();
    const states = [await seed(0), await seed(1)];
    const objective = { materialParty: true, status: 'open', priority: 'required', reason: 'craft_material',
        strategy: 'craft', spotId: 'old-source', npcId: 620, itemId: 4108, targetId: 148, amount: 12, requiredTotal: 12,
        helpDeal: { payerId: states[0].characterId, itemId: 4108, count: 12, fee } };
    states[0] = await Life.upsertState({ ...states[0], stats: { ...states[0].stats, partyRequest: objective } }, 'material_trip_need');
    const prepared = Parties.prepareCommit({ partyId: 'material-trip', leaderId: states[0].characterId,
        memberIds: states.map(state => state.characterId), status: 'active', spotId: 'old-source', startedAt: timestamp,
        nextResolveAt: timestamp, cohesion: 1, stats: { objective,
            agreement: Agreement.propose(states[0], states, objective) } });
    const assigned = states.map(state => Life.preparePartyAssignment(state, prepared.row.partyId, state.stats.role,
        prepared.row.leaderId, timestamp, 'old-source'));
    const formed = await DB.commitBackgroundPartyMembership({ party: prepared.row, members: assigned });
    assert(formed.ok);
    formed.lifeRows.forEach(row => Life.acceptNewerLifecycleRow(row));
    let party = Parties.acceptRow(formed.partyRow);
    const sources = [{ characterId: states[0].characterId, itemId: 4108, targetId: 148,
        spotId: 'new-source', npcId: 626, sourceKind: 'drop' }];
    const route = trip(states, 'new-source', { materialSources: sources });

    // A party-only change must reject the entire native transition, even when
    // every member revision is still current. No postcommit repair is enough.
    const stale = await proposals(party, route, timestamp);
    await DB.execute(["UPDATE bot_background_parties SET revision=revision+1,statsJson=json_set(statsJson,'$.concurrentMarker',1) WHERE partyId=?", [party.partyId]]);
    const before = await image();
    const rejected = await Owner.commitBatch(stale.entries, { timestamp });
    assert(rejected.every(row => !row.ok && row.detail === 'party_revision_stale'), JSON.stringify(rejected));
    assert.deepEqual(await image(), before, 'stale party context cannot commit even one member destination');
    party = Parties.acceptRow(await partyRow(party.partyId));

    party = await commit(await proposals(party, route, ++timestamp), timestamp);
    assert.equal(party.spotId, 'new-source');
    assert.equal(party.stats.agreement.materialNeeds[0].npcId, 626);
    assert.equal(party.stats.agreement.materialNeeds[0].collected, 0);
    assert.equal(party.stats.agreement.materialNeeds[0].quota, 12);
    assert.equal(party.stats.concurrentMarker, 1);
    assert(party.memberIds.every(id => Life.cachedState(id).stats.travel.spotId === 'new-source'));
    timestamp = party.stats.travel.arrivalAt;
    party = await commit(await proposals(party, null, timestamp), timestamp);
    assert.equal(party.stats.travel, null);
    assert(party.memberIds.every(id => Life.cachedState(id).spotId === 'new-source'));

    party = await commit(await proposals(party, trip(states, 'safe-field', { materialEvacuation: true }), ++timestamp), timestamp);
    timestamp = party.stats.travel.arrivalAt;
    const arrival = await proposals(party, null, timestamp);
    await DB.execute(["CREATE TRIGGER reject_material_arrival BEFORE UPDATE ON bot_background_parties WHEN NEW.status='dissolved' BEGIN SELECT RAISE(ABORT,'material arrival rollback'); END", []]);
    const beforeFailure = await image();
    await assert.rejects(Owner.commitBatch(arrival.entries, { timestamp }), /material arrival rollback/);
    assert.deepEqual(await image(), beforeFailure, 'SQL failure rolls back member release, party dissolution and helper refund together');
    await DB.execute(['DROP TRIGGER reject_material_arrival', []]);
    party = await commit(arrival, timestamp);
    assert.equal(party.status, 'dissolved');
    assert.equal(party.stats.agreement.help.status, 'cancelled');
    assert.equal(party.stats.agreement.help.refunded, fee);
    assert.equal(party.stats.agreement.help.remaining, 0);
    assert.equal(Life.cachedState(states[0].characterId).adena, wallet, 'the full unused escrow returns to its native payer');
    const request = Life.cachedState(states[0].characterId).stats.partyRequest;
    assert.equal(request.itemId, 4108);
    assert.equal(request.status, 'deferred');
    assert.equal(request.deferReason, Route.REASON);
    assert.equal(await Life.clearParty(party.partyId, Route.REASON), 0);
    assert.deepEqual(Life.cachedState(states[0].characterId).stats.partyRequest, request, 'postcommit cleanup preserves the owner need');

    console.log('PASS native material travel CAS, atomic contract/coordinates, evacuation rollback/refund, retained requests');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => world.close());
