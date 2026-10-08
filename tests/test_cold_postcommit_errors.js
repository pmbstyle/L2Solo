process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // Fixture inspects optional developer counters.
const assert = require('node:assert/strict');
require('../src/Global');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Events = invoke('GameServer/Bot/Population/BotLifeEvents');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const Metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
const Chat = invoke('GameServer/Bot/Population/BotGlobalChat');
const Consumption = invoke('GameServer/Bot/Economy/ConsumptionDiagnostics');
let consumptionRows = [];
const originalConsumptionPublish = Consumption.publish;
const Protocol = invoke('GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const originals = [];
function stub(object, key, value) { originals.push(() => { object[key] = value; }); object[key] = value; }
const state = { characterId: 1, phase: 'cold', activity: 'shopping', updatedAt: 100,
    simulation: { ownerId: 'legacy_main', revision: 0, leaseId: null, leaseUntil: 0 },
    timing: { activityStartedAt: 80, nextResolveAt: 100, lastResolvedAt: 50, lastHotAt: 0 } };
const messages = [], logs = [];
let partyWrites = 0, resolves = 0, announcements = 0;
stub(Life, 'cachedState', () => state);
stub(Life, 'settleWrites', async () => {});
stub(Life, 'reviewTrainingAfterCommit', async value => value);
stub(Life, 'enqueueEquipmentGoalAdvanceForState', async () => {});
stub(invoke('GameServer/Bot/Economy/BotAfkMarketService'), 'executePlan', async value => ({ state: value }));
stub(Events, 'recordMany', async () => {});
stub(Parties, 'createOrUpdate', async () => { partyWrites++; });
stub(Metrics, 'recordBackgroundResolve', () => { resolves++; });
stub(Metrics, 'recordPartyResolve', () => {});
stub(Metrics, 'recordCombat', () => {});
stub(Metrics, 'recordResolveDuration', () => {});
stub(Chat, 'maybeAnnounce', () => { announcements++; });
stub(utils, 'infoWarn', (...args) => logs.push(require('node:util').format(...args.slice(1))));
async function run() {
    const coordinator = new ColdSimulationCoordinator();
    coordinator.worker = { postMessage: message => messages.push(message) };
    coordinator.workerEpoch = 'postcommit:test';
    coordinator.contextIndex = () => ({});
    coordinator.contextFor = () => ({});
    coordinator.population = { executeWorkerLifecycleCommand: async () => ({ ok: true, state }) };
    coordinator.economyDecisions.decided = () => { throw Error('review_probe'); };
    const cp = Protocol.safetyCheckpoint(state); delete cp.simulationLeaseUntil;
    await coordinator.onMessage(Protocol.envelope('command_request', coordinator.workerEpoch, { requests: [{
        characterId: 1, kind: 'lifecycle', commandId: 'command:1:1', commandCheckpoint: cp,
        state, context: {}, precomputedResult: { patch: {}, events: [], materialize: {}, nextResolveAt: 1000 }
    }] }, 'message:1'), coordinator.worker, coordinator.workerEpoch);
    await coordinator.commandTail;
    const ack = messages.find(message => message.type === 'command_ack').payload.results[0];
    assert.equal(ack.ok, true, 'post-commit failure cannot reject an applied command');
    assert.equal(ack.reason, 'command_applied');
    assert.equal(ack.retryAfterMs, undefined);
    assert.equal(logs.filter(line => line.includes('postcommit improvement failed')).length, 1);
    Consumption.publish = (...args) => consumptionRows.push(args);
    const entry = { nextState: state, proposal: { token: { revision: 4 }, commandId: 'consume-command', sequence: 9, result: { events: [], consumptionDiagnostics: [[1539, 5, 3, 1]] }, economyPlan: { sell: [], withdraw: [], buyAds: [], travel: null },
        partyResolution: { party: { partyId: 2, status: 'active', memberIds: [1] } } } };
    logs.length = 0;
    await coordinator.afterCommit(entry);
    assert.equal(partyWrites, 1); assert.equal(resolves, 1); assert.equal(announcements, 1);
    assert.deepEqual(consumptionRows[0], [1, [[1539, 5, 3, 1]], { source: 'cold_commit', commandId: 'consume-command', revision: 4, sequence: 9 }]);
    assert.equal(logs.filter(line => line.includes('postcommit improvement failed')).length, 1);
    coordinator.economyDecisions.decided = () => null;
    stub(Events, 'recordMany', () => { throw Error('journal_probe'); });
    logs.length = 0;
    await coordinator.afterCommit(entry);
    assert.equal(partyWrites, 2); assert.equal(resolves, 2); assert.equal(announcements, 2);
    assert.equal(logs.filter(line => line.includes('postcommit journal failed')).length, 1);
    assert.equal(coordinator.counters.afterCommitStepErrors.journal, 1);
    stub(Events, 'recordMany', async () => {});
    coordinator.population.applyWorkerPartyRequirements = () => { throw Error('party_plan_probe'); };
    logs.length = 0;
    await coordinator.afterCommit(entry);
    assert.equal(resolves, 3); assert.equal(announcements, 3);
    assert.equal(logs.filter(line => line.includes('postcommit partyPlans failed')).length, 1);
    assert.equal(coordinator.counters.afterCommitStepErrors.partyPlans, 1);
    const ClanEvents = invoke('GameServer/Clan/ClanReviewEvents');
    stub(ClanEvents, 'committedMember', () => { throw Error('clan_event_probe'); });
    logs.length = 0;
    await coordinator.afterCommit(entry);
    assert.equal(resolves, 4); assert.equal(announcements, 4);
    assert.equal(coordinator.counters.afterCommitStepErrors.clanEvents, 1);
    assert.equal(logs.filter(line => line.includes('postcommit clanEvents failed')).length, 1);
    invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics = false;
    Consumption.publish = () => { throw Error('consumption publisher called off'); };
    await coordinator.afterCommit(entry);
    console.log('Applied commands and independent post-commit steps survive synchronous failures');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    Consumption.publish = originalConsumptionPublish;
    for (const restore of originals.reverse()) restore();
});
