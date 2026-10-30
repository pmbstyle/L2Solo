const assert = require('assert');
require('../src/Global');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Service = invoke('GameServer/Bot/Population/PopulationService');
const Executor = invoke('GameServer/Bot/Goals/GoalExecutor');
const Spots = invoke('GameServer/Bot/AI/SpotService');
const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const now = Date.now();
const objective = { status: 'open', priority: 'required', clanGoalKey: 'clan:1:gear', clanId: 1,
    clanOperation: 'equipment', minPartySize: 3, maxPartySize: 9 };
const token = { partyId: 'clan-party', characterId: 3, objective, until: now + 900000 };
let party = { partyId: token.partyId, status: 'active', leaderId: 1, memberIds: [1, 2], spotId: 'test',
    stats: { objective, marketAbsences: { 3: token } } };
const leader = { characterId: 1, name: 'Leader', level: 40, loc: { locX: 100, locY: 200, locZ: -100 },
    party: { partyId: party.partyId }, stats: {} };
const returning = { characterId: 3, name: 'Returning', phase: 'cold', level: 40, activity: 'shopping',
    loc: { locX: 1000, locY: 2000, locZ: -100 }, party: { partyId: null },
    stats: { partyMarketReturn: token, marketReturn: { loc: leader.loc, spotId: 'test' } } };
Parties.find = () => party;
Life.cachedState = id => id === 1 ? leader : null;
Spots.findById = () => ({ id: 'test', name: 'Test' });
Risk.backoffForStates = () => { throw new Error('must not apply solo bans to a clan rendezvous'); };
(async () => {
    const travel = Executor.finishMarketVisit(returning, now);
    assert.deepStrictEqual(travel.stats.travel.to, leader.loc);
    assert.strictEqual(travel.stats.travel.arrivalActivity, 'party_wait');
    assert.strictEqual(lifecycleKind(returning), 'command', 'shopping must execute economy, not clan waiting');
    const arrived = { ...returning, activity: 'party_wait', stats: { partyMarketReturn: token } };
    assert.strictEqual(lifecycleKind(arrived), 'command', 'arrival must attempt membership before any solo resolver');
    Life.statesForParty = async () => [leader, { ...leader, characterId: 2 }];
    Parties.createOrUpdate = async value => (party = value);
    const assigned = [];
    Life.assignParty = async (state, partyId) => { assigned.push({ state, partyId }); return state; };
    const result = await Service.resolveColdState(arrived);
    assert.strictEqual(result.reason, 'returned_to_clan_party');
    assert.deepStrictEqual(party.memberIds, [1, 2, 3]);
    assert.deepStrictEqual(party.stats.marketAbsences, {});
    assert.strictEqual(assigned.find(x => x.state.characterId === 3).state.stats.partyMarketReturn, null);
    party.status = 'dissolved';
    let saved;
    Life.upsertState = async state => (saved = state);
    await Service.resolveColdState(arrived);
    assert.strictEqual(saved.activity, 'party_wait');
    assert.strictEqual(saved.stats.partyRequest.clanGoalKey, objective.clanGoalKey);
    assert.strictEqual(saved.stats.partyMarketReturn, null);
    const warToken = { ...token, objective: {}, warOperationId: 'active-war', supplyItemId: 1463 };
    const warArrival = { ...arrived, stats: { partyMarketReturn: warToken } };
    party = { ...party, status: 'active', memberIds: [1, 2, 4, 5, 6, 7, 8, 9], stats: {
        warOperation: { id: 'active-war', status: 'returning', expiresAt: now - 1 }, marketAbsences: { 3: warToken } } };
    Life.statesForParty = async () => party.memberIds.map(id => ({ ...leader, characterId: id }));
    const returned = await Service.resolveColdState(warArrival);
    assert.strictEqual(returned.reason, 'returned_to_clan_party');
    assert.strictEqual(party.memberIds.length, 9, 'military return uses the nine-member limit, not the ordinary limit of five');
    assert.deepStrictEqual(party.stats.marketAbsences, {});
    assert.strictEqual(assigned.at(-1).state.stats.partyRequest, null, 'a military ticket cannot create a clan equipment assignment');
    for (const operation of [null, { id: 'different-war' }]) {
        party = { ...party, stats: { ...party.stats, warOperation: operation } };
        const ended = await Service.resolveColdState(warArrival);
        assert.strictEqual(ended.reason, 'war_supply_operation_ended');
        assert.strictEqual(saved.activity, 'hunting');
        assert.strictEqual(saved.stats.partyMarketReturn, null);
        assert.strictEqual(saved.stats.partyRequest, null);
    }
    party = { ...party, status: 'hot', stats: { warOperation: { id: 'active-war' } } };
    const held = await Service.resolveColdState(warArrival);
    assert.strictEqual(held.reason, 'party_return_retry', 'an existing hot military party keeps its supply return pending');
    assert.strictEqual(held.state.stats.partyMarketReturn.warOperationId, 'active-war');
    party.status = 'active';
    const shopping = { ...returning, stats: { ...returning.stats, partyMarketReturn: warToken, townVisit: { completed: false } } };
    for (const marketResult of [{ purchased: true }, { purchased: false, reason: 'war_supply_only' }]) {
        const home = await Service.finishColdMarketStep(shopping, null, null, null, { state: shopping }, { ...marketResult, state: shopping }, null);
        assert.strictEqual(home.activity, 'traveling', 'a military supply visit returns instead of continuing gear purchases or town errands');
        assert.deepStrictEqual(home.stats.travel.to, leader.loc);
        assert.strictEqual(home.stats.travel.arrivalActivity, 'party_wait');
        assert.strictEqual(home.stats.partyMarketReturn.warOperationId, 'active-war');
    }
    assert.strictEqual(Service.finishColdMarketStep(shopping, null, null, null, { state: shopping }, { state: shopping, pending: true }, null), shopping,
        'a supply deal already in progress retains ownership until it completes');
    console.log('Clan market return: live rendezvous, solo risk isolation, same-party return and dissolved-party waiting passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
