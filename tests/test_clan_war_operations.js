const assert = require('assert');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Policy = require('../src/GameServer/Clan/ClanWarPolicy');
const Config = require('../src/GameServer/Clan/ClanWarConfig');
const View = require('../src/GameServer/Clan/ClanWarView');
const Movement = require('../src/GameServer/Bot/Population/ClanWarMovement');
const { beginHuntingTrip } = require('../src/GameServer/Bot/Population/HuntingTravel');
const { ColdSimulationKernel, finishPartyRouteTravelState, partyTransitionProposals, nextDueAt } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const originalHeight = Geodata.getHeight;
Geodata.getHeight = (_x, _y, z) => z;
const at = Date.now(), home = { locX: 145224, locY: 120001, locZ: -4500 };
const target = { ...home, locX: home.locX + 3500 };
const spot = { id: '24_20:antharas_lair', name: 'War ground', center: home, minLevel: 35, maxLevel: 45, avgLevel: 40 };
const wars = new View();
const row = { fromClanId: 10, toClanId: 20, active: 1, revision: 1 };
wars.accept(row); wars.accept({ ...row, fromClanId: 20, toClanId: 10, revision: 2 });
const op = { id: 'war-operation', clanId: 10, enemyClanId: 20, status: 'assembling',
    targetSpotId: spot.id, targetLoc: target, homeSpotId: spot.id, homeLoc: home, expiresAt: at + 900000 };
const party = { partyId: 'war-party', revision: 7, leaderId: 1, memberIds: [1, 2, 3], status: 'active', spotId: spot.id,
    startedAt: at, nextResolveAt: at, stats: { warOperation: op } };
const members = [1, 2, 3].map(characterId => ({ characterId, name: `WarMember${characterId}`, level: 40,
    accountName: 'bot_war_operation', phase: 'cold', activity: 'grouped', spotId: spot.id,
    loc: { ...home }, party: { partyId: party.partyId, leaderId: 1 }, simulation: { revision: 1 },
    vitals: { hp: 1000, maxHp: 1000, mp: 500, maxMp: 500 }, timing: { nextResolveAt: at },
    inventory: {}, stats: { clanId: 10, role: characterId === 3 ? 'healer' : 'dps' } }));
try {
    const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
    const afterDeadline = op.expiresAt + 1;
    assert(!Lifecycle.sessionExpired(party, afterDeadline), 'ordinary rotation must wait for the military return to finish');
    const dueParty = { ...party, nextResolveAt: afterDeadline + 1000 };
    assert.equal(nextDueAt(members[0], afterDeadline, {}, false, {
        leaderParty: () => dueParty, partyMembers: () => members
    }), dueParty.nextResolveAt, 'an expired operation must not trap the worker on a past session deadline');
    const Admission = require('../src/GameServer/Bot/Population/PartyAdmission').PartyAdmission;
    const admission = new Admission(), budget = { maxBackgroundParties: 2 };
    assert.equal(admission.reserveWar([{}, {}], budget, 10, at), null, 'war cannot exceed the shared party cap');
    assert.equal(admission.reserve([{}], budget, { now: at + 1 }), null, 'ordinary formation cannot consume the next slot promised to a ready war party');
    const release = admission.reserveWar([{}], budget, 10, at + 1);
    assert.equal(typeof release, 'function'); assert.equal(admission.pending, 1);
    release(); assert.equal(admission.pending, 0);
    admission.reserveWar([{}, {}], budget, 20, at + 2);
    const expired = admission.reserve([{}], budget, { now: at + 60003 });
    assert.equal(typeof expired, 'function', 'abandoned demand expires without blocking ordinary formation'); expired();
    assert(Policy.available(members[0], at));
    const Validation = require('../src/GameServer/Bot/Population/ColdCompetitionValidation');
    const oldMarket = { ...members[0], stats: { ...members[0].stats, marketReturn: { spotId: 'previous-farm' } } };
    const participant = { id: 1, partyId: party.partyId };
    const warEvent = { action: 'clan_war', spotId: spot.id };
    const validation = { party, at, memory: { revision: () => 1 }, participantAllowed: () => true, contestContextAllowed: () => true };
    assert.equal(Validation.member(oldMarket, 1, participant, warEvent, validation), null,
        'a present military member old shopping anchor is not a live errand');
    for (const current of [
        { ...oldMarket, stats: { ...oldMarket.stats, clanId: 20 } },
        { ...oldMarket, stats: { ...oldMarket.stats, tradeMeeting: { id: 'purchase' } } },
        { ...oldMarket, stats: { ...oldMarket.stats, partyMarketReturn: { warOperationId: op.id } } },
        { ...oldMarket, stats: { ...oldMarket.stats, warehouseErrand: {} } },
    ]) assert.equal(Validation.member(current, 1, participant, warEvent, validation).detail, 'member_market_return',
        'a different clan or active errand cannot use the stale military anchor exception');
    const supplyOnly = { ...oldMarket, stats: { ...oldMarket.stats, marketReturn: null, partyMarketReturn: { warOperationId: op.id } } };
    assert.equal(Validation.member(supplyOnly, 1, participant, warEvent, validation).detail, 'member_market_return',
        'the live supply ticket remains a blocker even after the ordinary return anchor clears');
    assert.equal(Validation.member(oldMarket, 1, participant, warEvent,
        { ...validation, party: { ...party, stats: {} } }).detail, 'member_market_return',
    'ordinary parties do not acquire the military exception');
    assert(!Policy.available({ ...members[0], stats: { ...members[0].stats, partyMarketReturn: {
        partyId: 'another-war-party', warOperationId: 'another-operation', until: at + 60000 } } }, at),
    'a member returning from supplies cannot be stolen by a different war roster');
    assert(!Policy.available({ ...members[0], stats: { ...members[0].stats, tradeMeeting: {} } }, at));
    assert(!Policy.available({ ...members[0], phase: 'hot' }, at));
    const role = s => s.stats.role;
    assert.equal(Policy.roster(members, role).length, 3);
    assert.equal(Policy.roster(members.filter(s => role(s) !== 'healer'), role).length, 0);
    assert.equal(Policy.roster(members.map(s => role(s) === 'healer' ? { ...s, level: 75 } : s), role).length, 0,
        'a low-level assault cannot borrow a healer from an unrelated level band');
    const planned = Movement.route({ leader: members[0], party, members, spot, timestamp: at, spots: [spot], wars });
    assert(planned.active && planned.route?.needed, 'a raid within the same sector still moves to the witnessed farm location');
    assert.equal(planned.route.cause, 'clan_war_attack');
    const travelling = members.map(s => beginHuntingTrip(s, planned.route, at));
    assert(travelling.every(s => s.activity === 'traveling'));
    assert(travelling.every(s => s.stats.travel.arrivalAt > at), 'an order cannot teleport immediately to its target');
    assert(travelling.every(s => s.loc.locX === home.locX));
    assert.equal(finishPartyRouteTravelState(travelling[0], at), null, 'early arrival is refused');
    const arrivalAt = Math.max(...travelling.map(s => s.stats.travel.arrivalAt));
    const arrived = travelling.map(s => finishPartyRouteTravelState(s, arrivalAt));
    assert(arrived.every(s => s.activity === 'grouped' && s.spotId === spot.id));
    assert(arrived.every(s => Math.hypot(s.loc.locX - target.locX, s.loc.locY - target.locY) < 900));
    const held = Movement.route({ leader: arrived[0], party, members: arrived, spot, timestamp: arrivalAt, spots: [spot], wars });
    assert(held.active && !held.route, 'an assembled raid holds the witnessed location rather than rerouting for gear');
    const proposals = partyTransitionProposals({ party, members }, travelling, { ...party,
        stats: { ...party.stats, travel: travelling[0].stats.travel } }, at, at);
    assert(proposals.every(p => p.atomicGroup.partyChanges?.[0].expectedPartyRevision === 7),
        'each movement is fenced against an operation withdrawal or party change');
    wars.accept({ ...row, active: 0, revision: 3 });
    const returning = Movement.route({ leader: arrived[0], party, members: arrived, spot, timestamp: arrivalAt, spots: [spot], wars });
    assert(returning.route?.needed && returning.route.cause === 'clan_war_return');
    assert.equal(Policy.operationOutcome(op, members, wars.between(10, 20), at), 'war_ended');
    assert.equal(Policy.operationOutcome(op, [members[0], members[1], { ...members[2], vitals: { hp: 0 } }], { mutual: true }, at), 'losses');
    assert.equal(Policy.operationOutcome(op, members, { mutual: true }, op.expiresAt), 'time_limit');
    assert(!Policy.accepts({ traits: { caution: 1, assertiveness: 0 }, ownMembers: 3, enemyMembers: 9, hostility: 90 }));
    assert.equal(Config.hostilityThreshold, 25);
    assert.equal(Config.minHarmEpisodes, 3);
    assert.equal(Policy.threshold(), 25, 'the policy fallback uses the configured default base');
    const aggressive = { caution: 0, assertiveness: 1 }, cautious = { caution: 1, assertiveness: 0 };
    assert.equal(Policy.threshold(aggressive, Config.hostilityThreshold), 20);
    assert.equal(Policy.threshold(cautious, Config.hostilityThreshold), 30);
    const evidence = [1, 2, 3].map(id => ({ episode: `threshold-${id}`, category: 'harm', weight: 1, at }));
    const grievance = (hostility, traits, episodes = evidence) => Policy.grievance({ at, halfLife: 86400000,
        hostility, trust: 0, fear: 0, familiarity: 0, evidence: episodes }, traits, at, Config);
    for (const [traits, boundary] of [[aggressive, 20], [{}, 25], [cautious, 30]]) {
        assert(grievance(boundary, traits).ready, 'three distinct harm episodes admit a declaration at the leader threshold');
        assert(!grievance(boundary - 0.01, traits).ready, 'hostility below the leader threshold still refuses');
        assert(!grievance(100, traits, evidence.slice(0, 2)).ready, 'even maximal hostility cannot replace the third episode');
        assert(!grievance(100, traits, evidence.map(e => ({ ...e, episode: 'same-fight' }))).ready,
            'multiple reports of one fight cannot impersonate three episodes');
    }
    const sourceConfig = options.default.ClanWars;
    try {
        options.default.ClanWars = { ...sourceConfig, hostilityThreshold: 25 };
        assert.equal(Config.reload().hostilityThreshold, 25, 'configuration no longer clamps the new base back to thirty');
    } finally { options.default.ClanWars = sourceConfig; Config.reload(); }
    assert.equal(Policy.threshold({}, 70), 70, 'a configured threshold is not silently clamped back to the default personality band');
    const Runtime = invoke('GameServer/Clan/ClanWarRuntime');
    const NativeMove = invoke('GameServer/Bot/AI/BotClanWarOperation');
    const Travel = invoke('GameServer/Bot/AI/BotSpotTravel'), Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
    const Spots = invoke('GameServer/Bot/AI/SpotService'), Restrictions = invoke('GameServer/Effects/EffectRestrictions');
    const oldStart = Travel.start, oldStop = Tactics.stop, oldSpot = Spots.findById, oldCanUse = Restrictions.canUseBasicAction;
    let nativeLocation = home; const destinations = [];
    const actor = { fetchClanId: () => 10, fetchLocX: () => nativeLocation.locX,
        fetchLocY: () => nativeLocation.locY, fetchLocZ: () => nativeLocation.locZ, state: { fetchCasts: () => false } };
    const session = { actor };
    try {
        Runtime.view.replace([row, { ...row, fromClanId: 20, toClanId: 10, revision: 2 }]);
        Travel.start = (_session, _actor, _spot, destination) => { destinations.push(destination); return true; };
        Tactics.stop = () => {}; Spots.findById = () => spot; Restrictions.canUseBasicAction = () => true;
        assert(NativeMove.tick(session, actor, party, at));
        assert.deepEqual(destinations[0], target, 'visible parties travel through the native spot-travel owner');
        nativeLocation = target;
        assert(NativeMove.tick(session, actor, party, at)); assert.equal(session.lastDecision.action, 'clan_war_hold');
        Runtime.view.accept({ ...row, active: 0, revision: 3 });
        assert(NativeMove.tick(session, actor, party, at)); assert.deepEqual(destinations[1], home);
        session.pvpDefense = {};
        assert(!NativeMove.tick(session, actor, party, at), 'an operation cannot replace an active native PvP action');
    } finally {
        Travel.start = oldStart; Tactics.stop = oldStop; Spots.findById = oldSpot; Restrictions.canUseBasicAction = oldCanUse;
        Runtime.view.replace([]);
    }
    console.log('Clan war operations: coherent roster, busy-member exclusion, witnessed same-sector travel, delayed arrival, holding, CAS fences, losses and physical return passed');
} finally { Geodata.getHeight = originalHeight; }

async function workerReturn() {
    const now = op.expiresAt + 1, messages = [];
    const expired = { ...party, stats: { ...party.stats, sessionExpiresAt: at - 1 } };
    const there = members.map(s => ({ ...s, loc: { ...target } }));
    const kernel = new ColdSimulationKernel({ now: () => now,
        equipmentBridgeReason: () => { throw Error('equipment review must wait for military return'); },
        resolveSolo: () => { throw Error('war party cannot split into solo hunters'); },
        resolveParty: () => { throw Error('expired order must return before farming'); },
        partyRoute: () => ({ needed: true, mode: 'party', spotId: spot.id, to: home,
            destinations: Object.fromEntries(members.map(s => [s.characterId, home])), travelMs: 25000,
            cause: 'clan_war_return' }),
        emit: (type, payload) => messages.push({ type, payload }) });
    for (const state of there) {
        kernel.upsert({ state });
        kernel.inFlight.set(state.characterId, { state, startedAt: now, partyId: party.partyId });
    }
    kernel.partyRuns.set(party.partyId, { party: expired, members: there, spot, startedAt: now });
    await kernel.resolvePartyStep(party.partyId);
    const batch = messages.find(m => m.type === 'proposal_batch');
    assert(batch, JSON.stringify(messages));
    assert(batch.payload.proposals.every(p => p.nextState.activity === 'traveling'
        && p.nextState.stats.travel.arrivalAt > now && p.nextState.loc.locX === target.locX),
    'expired orders keep the roster together and propose delayed physical return');
    assert.equal(batch.payload.proposals.find(p => p.partyResolution).partyResolution.party.status, 'active');
    console.log('Clan war worker: expired orders return before ordinary rotation and equipment reviews passed');
}
workerReturn().catch(error => { console.error(error); process.exitCode = 1; });
