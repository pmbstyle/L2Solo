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
    simulation: { revision: 2 } }));
let writes = 0, announcements = 0, queries = 0;
const spot = { id: 'goal-spot', name: 'Goal spot', center: { locX: 1, locY: 1, locZ: 1 } };

(async () => {
    let clock = timestamp;
    stub(Date, 'now', () => clock);
    stub(Config, 'enabled', true); stub(Config, 'backgroundPartyEnabled', true);
    stub(Config, 'partyMinSize', 2); stub(Config, 'partyMaxSize', 5);
    stub(Config, 'maxPlayingPopulation', 40);
    stub(Population, 'playerActivityProfile', () => ({ protected: true }));
    stub(Population, 'realPlayerSessions', () => []);
    stub(Database, 'isReady', () => false); stub(Database, 'stats', () => ({ pending: 0 }));
    stub(Metrics, 'currentEventLoopLag', () => 0);
    stub(Coordinator, 'snapshot', () => ({ ready: true, snapshotsLoaded: true, queue: {} }));
    // A player is online (protected): forming runs its one path, the roster's goal awaits the worker.
    stub(Life, 'cachedState', id => members.find(member => member.characterId === Number(id)));
    stub(Parties, 'admitted', () => []); stub(Parties, 'counts', () => ({ active: 0 }));
    stub(Profiles, 'findById', () => spot);
    // The formation announcement commits with the party in one transaction.
    stub(Database, 'commitBackgroundPartyMembership', async ({ party, event }) => {
        writes++; if (event) announcements++;
        return { ok: true, partyRow: party, lifeRows: [] };
    });
    stub(Life, 'assignParty', async member => member);
    stub(Economy, 'forState', () => { throw Error('cold main economic calculation forbidden'); });
    // This fixture supplies a final admitted roster without a real atlas.
    // Keep economic admission separate from worker waits and lifecycle CAS.
    const Income = require('../src/GameServer/Bot/Population/PartyProgressComparison');
    stub(Income, 'compare', () => Income.evaluate({ solo: null, party: { income: 1000 }, cash: 5000 }));
    // The worker's forming verdict (asked before the party is built): this fixture's roster joins.
    const joins = (party, selected) => party.stats?.forming && { ok: true, sources: Calculation.sources(selected),
        joint: { formingAccepted: selected.map(member => member.characterId) } };
    stub(Coordinator, 'requestPartyGoals', async (party, selected, options) => {
        queries++;
        const started = Date.now();
        await new Promise(resolve => setTimeout(resolve, 120));
        clock += 120;
        options.onWorkerWait?.(Date.now() - started);
        return joins(party, selected) || { ok: true, sources: Calculation.sources(selected), joint: Policy.joint(party, selected,
            { context: { network: { activity: { activity: 'hunting', spotId: 'goal-spot', npcId: 123, nodeKey: '0:goal' } } } }) };
    });
    Population.partyFormationRunning = false;
    const formation = Population.formBackgroundParties(members);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(writes, 0, 'no party exists before the worker result');
    assert.equal(announcements, 0, 'no formation announcement before worker result');
    const formed = await formation;
    assert.equal(formed.length, 1, JSON.stringify({ queries, writes, announcements }));
    assert.equal(announcements, 1);
    const count = writes;
    Coordinator.requestPartyGoals = async () => ({ ok: false, reason: 'worker_not_ready' });
    assert.deepEqual(await Population.formBackgroundParties(members), []);
    assert.equal(writes, count); assert.equal(announcements, 1, 'unavailable worker causes no fallback or announcement');
    Coordinator.requestPartyGoals = async (party, selected) => joins(party, selected) || { ok: false, reason: 'party_goal_busy' };
    const busyFormed = await Population.formBackgroundParties(members);
    assert.equal(busyFormed.length, 1, 'a busy worker after the verdict does not fail formation');
    assert.equal(busyFormed[0].stats.objective.spotId, 'goal-spot', 'formation keeps its own objective');
    assert.equal(busyFormed[0].stats.memberGoals.length, 2);
    assert.equal(announcements, 2);
    // A player online: recruiting may use up the pass's small budget; the pass still tries
    // its one group, so forming is not starved while a player plays.
    const recruit = Population.recruitBackgroundMembers;
    Population.recruitBackgroundMembers = async (states, options) => { clock = options.deadlineAt; return new Set(); };
    try {
        const starvedFormed = await Population.formBackgroundParties(members);
        assert.equal(starvedFormed.length, 1, 'a pass whose recruiting used its budget still forms its one party');
    } finally {
        Population.recruitBackgroundMembers = recruit;
    }
    assert.equal(announcements, 3);

    const materialMembers = members.map((member, index) => ({ ...member, level: 65,
        stats: { ...member.stats, equipmentPlan: { target: { selfId: 5726 + index } },
            partyRequest: { ...member.stats.partyRequest, materialParty: true, reason: 'craft_material',
                itemId: 4097 + index, targetId: 5726 + index, requiredTotal: 12, amount: 12 } } }));
    Life.cachedState = id => materialMembers.find(member => member.characterId === Number(id));
    stub(Income, 'prepare', () => { throw Error('main must never forecast a cold material roster'); });
    Coordinator.requestPartyGoals = async (party, selected) => {
        return joins(party, selected) || { ok: true, sources: Calculation.sources(selected), joint: { objective: party.stats.objective,
            memberGoals: selected.map(Policy.declaration) } };
    };
    const materialFormed = await Population.formBackgroundParties(materialMembers);
    assert.equal(materialFormed.length, 1, 'worker-admitted material roster commits without main economic computation');
    const writesBeforeBusy = writes;
    Coordinator.requestPartyGoals = async () => ({ ok: false, reason: 'party_goal_busy' });
    // Moved members: the verdict on the formed ones is held, a new one is asked.
    const movedMembers = materialMembers.map(member => ({ ...member, updatedAt: Number(member.updatedAt || 0) + 1 }));
    Life.cachedState = id => movedMembers.find(member => member.characterId === Number(id));
    assert.deepEqual(await Population.formBackgroundParties(movedMembers), []);
    assert.equal(writes, writesBeforeBusy, 'a busy worker defers the forming verdict: no main admission');
    console.log('PASS all three cold group readers: no main network, delayed formation, budget, lifecycle CAS, stale rejection');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    for (const undo of restore.reverse()) undo();
});
