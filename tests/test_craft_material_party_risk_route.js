'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
invoke('GameServer/DataCache').init();
const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty');
const Route = require('../src/GameServer/Bot/Population/CraftMaterialPartyRoute');
const Risk = require('../src/GameServer/Bot/Population/PartySpotRiskPolicy');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Routes = invoke('GameServer/Bot/AI/LevelingRoutes'), Spots = invoke('GameServer/Bot/Population/SpotProfiles');
const Service = invoke('GameServer/Bot/AI/SpotService'), Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const Rewards = require('../src/GameServer/Bot/Population/ColdKillRewards');
const Request = require('../src/GameServer/Bot/Population/PartyRequestPlanner');
const BotRoute = require('../src/GameServer/Bot/Population/BotRoute');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const at = Date.now(), point = { locX: 145224, locY: 120001, locZ: -4500 };
const profiles = ['danger', 'only-one-input', 'unsafe-source', 'common-source', 'cash-field'].map(id => ({
    id, name: id, capacity: 5, center: point, npcSelfIds: [626, 627], minLevel: 60, maxLevel: 65, avgLevel: 62, density: 10 }));
const byId = new Map(profiles.map(spot => [spot.id, spot]));
const members = [1, 2, 3].map(characterId => ({ characterId, name: `Material${characterId}`, level: 65,
    phase: 'cold', activity: 'grouped', spotId: 'danger', loc: { ...point },
    inventory: characterId <= 2 ? { [characterId === 1 ? 4108 : 4104]: { amount: characterId } } : {}, adena: 100000,
    party: { partyId: 'material-risk', leaderId: 1, role: characterId === 3 ? 'healer' : characterId === 2 ? 'spoiler' : 'dps' },
    vitals: { hp: 2000, maxHp: 2000, mp: 1000, maxMp: 1000 },
    simulation: { revision: 1 },
    timing: { lastResolvedAt: at - 10000, nextResolveAt: at },
    stats: { classId: characterId === 3 ? 16 : characterId === 2 ? 54 : 8,
        role: characterId === 3 ? 'healer' : characterId === 2 ? 'spoiler' : 'dps',
        equipmentPlan: { status: 'active', target: { selfId: characterId === 1 ? 148 : 146 } },
        spotBackoffs: [{ spotId: 'personal-only', untilStep: 60 }] } }));
const objective = { materialParty: true, status: 'open', priority: 'required', strategy: 'craft', reason: 'craft_material',
    itemId: 4108, targetId: 148, spotId: 'danger', npcId: 620, attempts: 2, objectiveKey: 'craft-material:danger' };
const needs = [1, 2].map(characterId => ({ characterId, itemId: characterId === 1 ? 4108 : 4104,
    targetId: characterId === 1 ? 148 : 146, spotId: 'danger', npcId: 620, sourceKind: 'drop',
    requiredTotal: 12, quota: 10, collected: characterId, helpDeal: { fee: 100, paid: 20 } }));
let party = { partyId: 'material-risk', leaderId: 1, memberIds: [1, 2, 3], status: 'active', spotId: 'danger',
    nextResolveAt: at, stats: { objective, agreement: { mode: 'need', materialNeeds: needs, materialCursor: 7 },
        memberGoals: needs, fightsWon: 0 } };
const evidence = Risk.record(party, { debug: { fights: 3, wins: 0, spotId: 'danger' }, partyPatch: { stats: { deaths: 2 } } }, at);
party = { ...party, stats: { ...party.stats, ...evidence.partyPatch.stats } };
assert(Risk.excludedSpotIds(party, at).has('danger'), 'native risk evidence excludes the original camp');
const options = { timestamp: at, excludedSpotIds: Risk.excludedSpotIds(party, at) };
const saved = [], replace = (object, key, value) => { saved.push(() => { object[key] = value; }); object[key] = value; };
let checks = 0, spoiler = true, physicalSpotId = 'danger';
const source = (id, npcId, kind = 'drop') => ({ spot: byId.get(id), kind, npcLevel: 60,
    reward: { selfId: npcId }, sourceCount: 1, totalCount: 1 });
let sourceIndex = new Map([
    [4108, ['danger', 'only-one-input', 'unsafe-source', 'common-source'].map(id => source(id, 626))],
    [4104, ['danger', 'unsafe-source', 'common-source'].map(id => source(id, 627, 'spoil'))]
]);
replace(Planner, 'sourceIndexFor', () => sourceIndex);
replace(Planner, 'itemDropYield', () => { checks++; return { expectedYield: 1 }; });
replace(Rewards, 'spoilerFor', state => spoiler && state.characterId === 2 ? state : null);
replace(Matchup, 'stateProfiles', () => []);
replace(Routes, 'isSpotAllowedForState', spot => spot.id !== 'unsafe-source');
replace(Routes, 'bestSpot', candidates => candidates.length ? { spot: candidates[0] } : null);
replace(Service, 'findCurrentSpot', () => byId.get(physicalSpotId));
replace(Service, 'arrivalPointsForParty', roster => Object.fromEntries(roster.map(s => [s.characterId, { ...point, locX: point.locX + 100 }])));
replace(Spots, 'findForState', () => byId.get('cash-field'));
// All row reads must go through the material source index, not population scans.
replace(invoke('GameServer/Bot/Population/BotLifeState'), 'everyState', () => { throw Error('no population scan'); });

async function proposalsFor(currentParty, roster, route, timestamp) {
    const messages = [], kernel = new ColdSimulationKernel({ now: () => timestamp,
        resolveSolo: () => { throw Error('no solo combat during evacuation'); },
        resolveParty: () => { throw Error('no party combat during travel'); },
        // The party run's route (the worker's BotRoute.route).
        partyRoute: () => route,
        emit: (type, payload) => messages.push({ type, payload }) });
    for (const state of roster) {
        kernel.upsert({ state });
        kernel.inFlight.set(state.characterId, { state, startedAt: timestamp, partyId: party.partyId });
    }
    kernel.partyRuns.set(currentParty.partyId, { party: currentParty, members: roster, spot: byId.get(currentParty.spotId), startedAt: timestamp });
    await kernel.resolvePartyStep(currentParty.partyId);
    const proposals = messages.find(message => message.type === 'proposal_batch')?.payload.proposals;
    assert(proposals, JSON.stringify(messages));
    assert(proposals.every(row => row.atomicGroup?.memberIds.length === roster.length), 'every transition uses the complete atomic roster');
    return { members: proposals.map(row => row.nextState), party: proposals.find(row => row.partyResolution).partyResolution.party };
}
async function main() {
    // Three alternatives per need still leave a common source after the risk
    // and combat gates remove the other two (room is checked at arrival).
    sourceIndex.get(4108).splice(1, 1);
    const selected = Route.select(party, members, profiles, options);
    assert.equal(selected?.spot.id, 'common-source');
    assert.deepEqual(selected.sources.map(row => [row.itemId, row.npcId, row.sourceKind]), [[4108, 626, 'drop'], [4104, 627, 'spoil']]);
    assert(checks <= needs.length * Material.MAX_SOURCE_CHECKS);
    const before = checks;
    for (let i = 0; i < 100; i++) Route.select(party, members, profiles, options);
    assert.equal(checks, before, 'warm source reviews perform no new source traversal');
    const routeFor = (state, currentSpot, currentParty, roster) => BotRoute.route(state, currentSpot, currentParty, roster,
        { spots: profiles, timestamp: at });
    const route = routeFor(members[0], byId.get('danger'), party, members);
    assert.equal(route.spotId, 'common-source', 'the real route search cannot choose the unrelated cash camp');
    assert(route.materialSources);
    assert.equal(route.cause, 'death_pressure');
    physicalSpotId = 'common-source';
    const backedOffParty = Risk.withBackoff(party, Risk.backoff(party, 'danger', at), at);
    const displaced = { ...backedOffParty, spotId: physicalSpotId };
    assert(routeFor(members[0], byId.get(physicalSpotId), displaced, members)?.materialSources,
        'a previously displaced party repairs stale contract sources even when already at the selected camp');
    physicalSpotId = 'danger';
    const original = JSON.stringify(party);
    const moved = await proposalsFor(party, members, route, at);
    assert.equal(JSON.stringify(party), original, 'routing does not mutate the source party');
    assert(moved.members.every(state => state.activity === 'traveling'));
    assert.equal(moved.party.stats.objective.spotId, route.spotId);
    assert.equal(Material.target(moved.party, moved.members), 626);
    assert.equal(moved.party.stats.agreement.materialCursor, 7);
    moved.party.stats.agreement.materialNeeds.forEach((goal, i) => {
        assert.equal(goal.spotId, route.spotId);
        assert.equal(goal.npcId, selected.sources[i].npcId);
        assert.equal(goal.quota, needs[i].quota);
        assert.equal(goal.collected, needs[i].collected);
        assert.deepEqual(goal.helpDeal, needs[i].helpDeal);
    });
    assert(Risk.excludedSpotIds(moved.party, at + 1).has('danger'));
    moved.members.forEach((state, i) => assert.deepEqual(state.stats.spotBackoffs, members[i].stats.spotBackoffs));

    spoiler = false;
    assert.equal(Route.select(party, members, profiles, options), null, 'spoil is not an executable source without a party spoiler');
    const evacuation = routeFor(members[0], byId.get('danger'), party, members);
    assert.equal(evacuation.spotId, 'cash-field', 'lack of materials must not prevent leaving the risky camp');
    assert.equal(evacuation.materialEvacuation, true);
    physicalSpotId = 'cash-field';
    assert(routeFor(members[0], byId.get(physicalSpotId), { ...backedOffParty, spotId: physicalSpotId }, members)
        ?.materialEvacuation, 'a party already farming unrelated ground must also exit the stale operation');
    physicalSpotId = 'danger';
    const departed = await proposalsFor(party, members, evacuation, at);
    departed.party.stats.sessionReview = { at, nextAt: at + 1 }; // its review clock runs out before the arrival
    const arrived = await proposalsFor(departed.party, departed.members, null, departed.party.stats.travel.arrivalAt);
    assert.equal(arrived.party.status, 'dissolved');
    arrived.members.forEach((state, i) => {
        assert.equal(state.party.partyId, null);
        assert.equal(state.activity, 'hunting');
        assert.deepEqual(state.stats.spotBackoffs, members[i].stats.spotBackoffs);
        if (i === 2) return assert.equal(state.stats.partyRequest, null, 'support receives no invented material need');
        assert.equal(state.stats.partyRequest.itemId, needs[i].itemId);
        assert.equal(state.stats.partyRequest.amount, needs[i].quota - needs[i].collected);
        assert.equal(state.stats.partyRequest.attempts, 3);
        assert.equal(state.stats.partyRequest.lastReason, Route.REASON);
        assert.equal(Request.partyRequestForPlan({ ...state, activity: 'traveling' }, state.stats.equipmentPlan,
            departed.party.stats.travel.arrivalAt + 1), state.stats.partyRequest, 'native replanning preserves evacuation cooldown during recovery/travel');
    });
    const ordinary = { ...party, stats: { ...party.stats, objective: { spotId: 'danger' } } };
    const normal = routeFor(members[0], byId.get('danger'), ordinary, members);
    assert.equal(normal.spotId, 'cash-field');
    assert.equal(normal.materialEvacuation, undefined, 'ordinary and clan hunting keep their existing risk retreat');
    spoiler = true;
    sourceIndex = new Map([[4108, [source('only-one-input', 626)]], [4104, [source('common-source', 627)]]]);
    assert.equal(Route.select(party, members, profiles, options), null, 'one owner cannot silently lose his input when no common camp exists');
    const finishedOwner = { ...members[0], inventory: { 148: { amount: 1 } } };
    const unfinished = Route.select(party, [finishedOwner, ...members.slice(1)], profiles, options);
    assert.equal(unfinished?.spot.id, 'common-source');
    assert.deepEqual(unfinished.sources.map(row => row.characterId), [2], 'a physically fulfilled owner no longer constrains the remaining material route');
    console.log('PASS bounded material-source retreat, different drop/spoil mobs, native risk gates, atomic contract retarget, evacuation and personal cooldowns');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => saved.reverse().forEach(restore => restore()));
