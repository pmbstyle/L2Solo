'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Population = invoke('GameServer/Bot/Population/PopulationService');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const Database = invoke('Database');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Profiles = invoke('GameServer/Bot/Population/SpotProfiles');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Policy = require('../src/GameServer/Bot/Population/PartyGoalPolicy');
const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
const Formation = require('../src/GameServer/Bot/Population/RequiredPartyFormation');
const Goal = invoke('GameServer/Bot/Goals/GoalService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Events = invoke('GameServer/Bot/Population/BotLifeEvents');
const restore = [];
function stub(target, name, value) {
    const old = target[name]; restore.push(() => { target[name] = old; }); target[name] = value;
}
const timestamp = Date.now();
const members = [901, 902].map(characterId => ({ characterId, name: `GoalPopulation${characterId}`,
    level: 40, phase: 'cold', activity: 'party_wait', updatedAt: timestamp,
    party: { partyId: null, role: 'dps', leaderId: null }, inventory: {}, adena: 10000,
    stats: { classId: 0, role: 'dps', partyRequest: { status: 'open', priority: 'required',
        requestedAt: timestamp - 1000, spotId: 'goal-spot', npcId: 123 } },
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 }, timing: {},
    simulation: { ownerId: 'legacy_main', revision: 2 } }));
let writes = 0, announcements = 0, queries = 0, membershipWrites = 0;
const spot = { id: 'goal-spot', name: 'Goal spot', center: { locX: 1, locY: 1, locZ: 1 } };

(async () => {
    stub(Config, 'enabled', true); stub(Config, 'backgroundPartyEnabled', true);
    stub(Config, 'partyMinSize', 2); stub(Config, 'partyMaxSize', 5);
    stub(Config, 'maxBackgroundParties', 10); stub(Config, 'protectedPartyFormationMainBudgetMs', 50);
    stub(Population, 'playerActivityProfile', () => ({ protected: true }));
    stub(Population, 'realPlayerSessions', () => []);
    stub(Database, 'isReady', () => false); stub(Database, 'stats', () => ({ pending: 0 }));
    stub(Metrics, 'currentEventLoopLag', () => 0);
    stub(Coordinator, 'snapshot', () => ({ ready: true, snapshotsLoaded: true, queue: {} }));
    // Selection/hydration are covered by protected-party and atomic DB tests;
    // here the input is the final complete roster whose goal awaits the worker.
    stub(Formation, 'proposalFromStates', () => ({ candidates: members,
        spotId: spot.id, minSize: 2, maxSize: 5, levelRange: 4 }));
    stub(Parties, 'admitted', () => []); stub(Parties, 'counts', () => ({ active: 0 }));
    stub(Profiles, 'findById', () => spot);
    stub(Parties, 'createOrUpdate', async party => { writes++; return party; });
    stub(Life, 'assignParty', async member => member);
    stub(Events, 'record', async () => { announcements++; });
    stub(Economy, 'forState', () => { throw Error('cold main economic calculation forbidden'); });
    // This fixture supplies a final admitted roster without a real atlas.
    // Keep economic admission separate from worker waits and lifecycle CAS.
    const Income = require('../src/GameServer/Bot/Population/PartyIncomeComparison');
    stub(Income, 'compare', () => Income.evaluate({ solo: null, party: { income: 1000 }, cash: 5000 }));
    stub(Coordinator, 'requestPartyGoals', async (party, selected, options) => {
        queries++;
        const started = Date.now();
        await new Promise(resolve => setTimeout(resolve, 120));
        options.onWorkerWait?.(Date.now() - started);
        return { ok: true, sources: Calculation.sources(selected), joint: Policy.joint(party, selected,
            { context: { network: { activity: { activity: 'hunting', spotId: 'goal-spot', npcId: 123, nodeKey: '0:goal' } } } }) };
    });
    Population.nextProtectedPartyFormationAt = 0; Population.partyFormationRunning = false;
    const formation = Population.formProtectedRequiredParty(Date.now(), members);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(writes, 0, 'no party exists before the worker result');
    assert.equal(announcements, 0, 'no formation announcement before worker result');
    const formed = await formation;
    assert.equal(formed.length, 1, JSON.stringify({ queries, writes, announcements,
        failures: Population.protectedPartyFormationFailures }));
    assert.equal(queries, 1); assert.equal(announcements, 1);
    assert.equal(Population.protectedPartyFormationFailures, 0, 'worker wait does not consume main budget');
    const count = writes;
    Coordinator.requestPartyGoals = async () => ({ ok: false, reason: 'worker_not_ready' });
    Population.nextProtectedPartyFormationAt = 0;
    assert.deepEqual(await Population.formProtectedRequiredParty(Date.now(), members), []);
    assert.equal(writes, count); assert.equal(announcements, 1, 'unavailable worker causes no fallback or announcement');
    Coordinator.requestPartyGoals = async () => ({ ok: false, reason: 'party_goal_busy' });
    Population.nextProtectedPartyFormationAt = 0;
    const busyFormed = await Population.formProtectedRequiredParty(Date.now(), members);
    assert.equal(busyFormed.length, 1, 'a busy worker does not fail formation');
    assert.equal(busyFormed[0].stats.objective.spotId, 'goal-spot', 'formation keeps its own objective');
    assert.equal(busyFormed[0].stats.memberGoals.length, 2);
    assert.equal(announcements, 2);

    const active = { ...formed[0], status: 'active', updatedAt: timestamp,
        startedAt: timestamp - 600000, stats: { ...formed[0].stats, fightsWon: 10, lastProgressAt: timestamp,
            sessionReview: { at: timestamp - 600000, nextAt: timestamp - 1, wins: 9 } } };
    const grouped = members.map(member => ({ ...member, activity: 'grouped', party: { partyId: active.partyId, leaderId: active.leaderId },
        stats: { ...member.stats, partyRequest: null } }));
    stub(Life, 'statesForParty', async () => grouped); stub(Life, 'cachedState', id => grouped.find(member => member.characterId === Number(id)));
    stub(Parties, 'find', () => active);
    stub(Life, 'acceptPartyAssignments', prepared => prepared.map(entry => entry.snapshot));
    stub(Database, 'commitBackgroundPartyMembership', async request => {
        membershipWrites++; assert.equal(request.expectedPartyUpdatedAt, active.updatedAt);
        assert(request.review); return { ok: true, lifeRows: [] };
    });
    Coordinator.requestPartyGoals = async (party, selected) => { queries++;
        return { ok: true, sources: Calculation.sources(selected), joint: Policy.joint(party, selected) }; };
    const reviewed = await Population.resolveBackgroundParty(active);
    assert.equal(reviewed.ok, true, reviewed.reason); assert.equal(membershipWrites, 1); assert.equal(queries, 2);
    stub(Goal, 'snapshot', () => ({ current: { nextReviewAt: timestamp + 3600000 } }));
    stub(Market, 'reconcile', async () => null);
    stub(Parties, 'commitGoals', async (party, selected, joint) => { writes++; assert.equal(joint.memberGoals.length, 2); return party; });
    await Population.reconcileWorkerPartyGoals(active, timestamp);
    assert.equal(queries, 3, 'active postcommit review requests the real group result');
    Coordinator.requestPartyGoals = async (party, selected) => ({ ok: true,
        sources: Calculation.sources(selected).map(source => ({ ...source, revision: source.revision + 1 })), joint: { memberGoals: [] } });
    const beforeStale = writes;
    await Population.reconcileWorkerPartyGoals(active, timestamp);
    assert.equal(writes, beforeStale, 'wrong source result cannot write party goals');
    const incomeParty = { ...active, memberIds: [901, 902, 903], leaderId: 901,
        stats: { objective: { spotId: spot.id }, agreement: { memberIds: [901, 902, 903] } } };
    const incomeMembers = [...grouped, { ...grouped[1], characterId: 903 }];
    Life.cachedState = id => incomeMembers.find(member => member.characterId === Number(id));
    Parties.find = () => incomeParty;
    let incomeSource = 'table_party', incomeFee = 0, incomeDepartures = 0, retainedParty;
    Coordinator.requestPartyGoals = async (party, selected) => ({ ok: true,
        sources: Calculation.sources(selected), joint: { memberGoals: selected.map(Policy.declaration),
            lastIncomeReviewAt: timestamp, incomeReviews: [{ characterId: 901, accept: false,
                reason: 'solo_preferred', partySource: incomeSource, soloIncome: 1000, partyIncome: 200, fee: incomeFee }] } });
    Parties.commitGoals = async party => party;
    stub(Life, 'leaveParty', async (member, reason, options) => {
        assert.equal(reason, 'better_solo_income'); assert.equal(options.ownerHandoff, true);
        assert.equal(member.stats.partyIncomeDecision.partyIncome, 200);
        incomeDepartures++; return { ...member, party: { partyId: null } };
    });
    Parties.createOrUpdate = async party => { retainedParty = party; return party; };
    await Population.reconcileWorkerPartyGoals(incomeParty, timestamp);
    assert.equal(incomeDepartures, 0, 'a table forecast alone cannot eject an existing member');
    incomeSource = 'own_party'; incomeFee = 100;
    await Population.reconcileWorkerPartyGoals(incomeParty, timestamp);
    assert.equal(incomeDepartures, 0, 'an unsettled helper fee prevents an income departure');
    incomeFee = 0; incomeParty.stats.pveEncounter = { status: 'active' };
    await Population.reconcileWorkerPartyGoals(incomeParty, timestamp);
    assert.equal(incomeDepartures, 0, 'income review cannot interrupt combat');
    delete incomeParty.stats.pveEncounter;
    const soloExit = await Population.reconcileWorkerPartyGoals(incomeParty, timestamp);
    assert.equal(incomeDepartures, 1, 'a measured personal loss detaches one member at a safe boundary');
    assert.equal(soloExit.departed.characterId, 901);
    assert.deepEqual(retainedParty.memberIds, [902, 903]);
    assert.deepEqual(retainedParty.stats.agreement.memberIds, [902, 903]);
    assert(retainedParty.memberIds.includes(retainedParty.leaderId), 'the retained party has an attached leader');
    console.log('PASS all three cold group readers: no main network, delayed formation, budget, lifecycle CAS, stale rejection');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    for (const undo of restore.reverse()) undo();
});
