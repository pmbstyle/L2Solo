'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Policy = require('../src/GameServer/Bot/Population/PartyGoalPolicy');
const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const timestamp = Date.now();
const members = [701, 702].map(characterId => ({ characterId, phase: 'cold', updatedAt: timestamp,
    level: 20, activity: 'hunting', adena: 10000, inventory: {},
    spotId: 'execution-ground', stats: { classId: 0 }, timing: {},
    simulation: { ownerId: 'legacy_main', revision: 2, leaseId: null },
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } }));
const party = { partyId: 'goal-calculation', memberIds: [701, 702], leaderId: 701, stats: {} };

(async () => {
    const deps = { timestamp, spots: [], nodes: [], routeRows: [], workshop: { known: true } };
    const contexts = members.map(member => Economy.forState(member, deps));
    const before = Policy.joint(party, members, { context: Policy.groupContext(party, members, deps) });
    assert.equal(Calculation.sameSource(members[0], structuredClone(members[0])), true, 'equal identity is the same source');
    assert.equal(Calculation.sameSource(members[0], { ...members[0], updatedAt: Number(members[0].updatedAt || 0) + 1 }), false);
    assert.equal(Calculation.sameSource(members[0], { ...members[0], simulation: { ...members[0].simulation, leaseId: 'other' } }), false);
    let preparations = 0;
    const groupsBefore = Economy.size().groups;
    const after = await Calculation.calculate(party, members, async member => {
        preparations++; return contexts[members.indexOf(member)];
    }, timestamp);
    assert.deepEqual(after, before, 'prepared inputs retain the actual native group decision');
    assert.equal(preparations, 2, 'each member prepared once');
    assert.equal(Economy.size().groups, groupsBefore, 'a query retains no extra group member graphs');
    let cancelledPreparations = 0;
    await assert.rejects(Calculation.calculate(party, members, async member => {
        cancelledPreparations++; return contexts[members.indexOf(member)];
    }, timestamp, () => cancelledPreparations === 0), /party_goal_expired/);
    assert.equal(cancelledPreparations, 1, 'expiration stops before the next member preparation');
    assert.throws(() => Policy.groupContext(party, members, { memberContexts: [...contexts].reverse() }),
        /party_member_context_mismatch/, 'wrong member order is rejected');
    assert.throws(() => Policy.groupContext(party, members, { memberContexts: [contexts[0]] }), /mismatch/);
    assert.throws(() => Policy.groupContext(party, [structuredClone(members[0]), members[1]],
        { memberContexts: contexts }), /mismatch/, 'old source identity is rejected');
    const payload = { party, members, escrows: [0, 0], timestamp, replyBy: timestamp + 5000 };
    const check = value => Protocol.validateEnvelope(Protocol.envelope('party_goal_request', 'probe', value), 'main');
    assert(check(payload).ok);
    assert(!check({ ...payload, members: [members[0], members[0]] }).ok);
    assert(!check({ ...payload, escrows: [0] }).ok);
    assert(!check({ ...payload, replyBy: timestamp - 1 }).ok);
    assert(!check({ ...payload, party: { ...party, leaderId: 999 } }).ok);
    assert(!check({ ...payload, party: { ...party, padding: 'x'.repeat(256 * 1024) } }).ok);
    const protectedParty = { ...party, stats: { objective: { clanGoalKey: 'clan-probe', spotId: 'protected' } } };
    assert.deepEqual((await Calculation.calculate(protectedParty, members,
        async member => contexts[members.indexOf(member)], timestamp)).objective, protectedParty.stats.objective);

    const escrow = Market.buyOrderEscrow;
    const coordinator = new ColdSimulationCoordinator();
    try {
        Market.buyOrderEscrow = () => 0;
        coordinator.worker = {}; coordinator.workerEpoch = 'probe'; coordinator.ready = coordinator.snapshotsLoaded = true;
        coordinator.post = (type, input, msgId) => {
            assert.equal(type, 'party_goal_request');
            setImmediate(() => coordinator.waiters.get(msgId)?.resolve({ ok: true, joint: after,
                sources: Calculation.sources(input.members) }));
            return msgId;
        };
        assert((await coordinator.requestPartyGoals(party, members)).ok);
        coordinator.post = () => null;
        assert.equal((await coordinator.requestPartyGoals(party, members)).reason, 'party_goal_send_failed');
        assert.equal(coordinator.waiters.size, 0); assert.equal(coordinator.partyGoalRequests, 0);
        coordinator.post = (type, input, msgId) => msgId;
        const pending = [coordinator.requestPartyGoals(party, members, { timeoutMs: 50 }),
            coordinator.requestPartyGoals(party, members, { timeoutMs: 50 })];
        assert.equal((await coordinator.requestPartyGoals(party, members)).reason, 'party_goal_busy');
        assert((await Promise.all(pending)).every(result => result.reason === 'party_goal_timeout'));
        assert.equal(coordinator.waiters.size, 0); assert.equal(coordinator.partyGoalRequests, 0);
        coordinator.post = (type, input, msgId) => {
            setImmediate(() => {
                coordinator.workerEpoch = 'restarted';
                coordinator.waiters.get(msgId)?.resolve({ ok: true, joint: after, sources: Calculation.sources(members) });
            });
            return msgId;
        };
        assert.equal((await coordinator.requestPartyGoals(party, members)).reason, 'party_goal_stale_worker');
    } finally { Market.buyOrderEscrow = escrow; }
    Economy.reset();
    console.log('PASS native prepared group parity, protection, source identity, protocol limits, admission, timeout and restart');
})().catch(error => { console.error(error); process.exitCode = 1; });
