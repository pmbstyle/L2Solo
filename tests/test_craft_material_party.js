'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Material = require('../src/GameServer/Bot/Population/CraftMaterialParty');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Request = require('../src/GameServer/Bot/Population/PartyRequestPlanner');
const Funding = require('../src/GameServer/Bot/Economy/PurchaseFunding');
const Composition = require('../src/GameServer/Bot/Population/BackgroundPartyComposition');
const Formation = require('../src/GameServer/Bot/Population/RequiredPartyFormation');
const Agreement = require('../src/GameServer/Bot/Population/PartyAgreement');
const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
const timestamp = Date.now();
const plan = { status: 'active', strategy: 'craft', recipeId: 424, target: { selfId: 5726, slot: 12 },
    materials: invoke('GameServer/Items/C4RecipeItems').resolveByRecipeId(424).materials, next: null };
const state = { characterId: 990201, level: 65, classId: 8, phase: 'cold', activity: 'hunting', spotId: 'solo',
    party: { partyId: null, role: 'dps' }, clanId: 1, adena: 1000000,
    stats: { classId: 8, role: 'dps', equipmentPlan: plan, wishFocus: ['power:5726:12', 0, 1] },
    inventory: {}, simulation: { revision: 1 }, updatedAt: timestamp };
const spots = Array.from({ length: 40 }, (_, i) => ({ id: `camp:${i}`, raidBoss: false }));
const entries = spots.map((spot, i) => ({ spot, kind: 'drop', npcLevel: 60, reward: { selfId: 626 },
    sourceCount: 40 - i, totalCount: 40 }));
const original = { sourceIndexFor: Planner.sourceIndexFor, itemDropYield: Planner.itemDropYield,
    sourceRouteReader: Planner.sourceRouteReader, spendable: Funding.spendable };
let inspected = 0, routeChecks = 0;
let index = new Map([[4097, entries]]);
Planner.sourceIndexFor = () => index;
Planner.itemDropYield = () => { inspected++; return { expectedYield: 1 }; };
Planner.sourceRouteReader = () => () => { routeChecks++; return false; };
const economy = { network: { focus: ['power:5726:12', 0, 1], activity: null, plans: new Map() },
    stockFor: () => ({ incoming: 0 }), worth: () => 100 };

(async () => {
try {
    const request = Material.request(state, plan, { spots, economy, timestamp });
    assert(request && request.materialParty, 'an unsafe solo material route becomes an explicit request');
    assert.equal(request.itemId, 4097);
    assert.equal(request.amount, 12);
    assert.equal(inspected, Material.MAX_SOURCE_CHECKS);
    assert.equal(routeChecks, Material.MAX_CAMPS);
    assert.equal(plan.next, null, 'the request never turns an unsafe source into an executable solo route');
    const retained = { ...state, stats: { ...state.stats, partyRequest: request } };
    const costs = [];
    for (let i = 0; i < 1000; i++) {
        const at = performance.now();
        assert.equal(Material.request(retained, plan, { spots, economy, timestamp: timestamp + i }).spotId, request.spotId);
        costs.push(performance.now() - at);
    }
    assert.equal(inspected, Material.MAX_SOURCE_CHECKS, 'warm reviews do not traverse source rows');
    assert.equal(routeChecks, Material.MAX_CAMPS, 'warm reviews perform no exact route/combat check');
    costs.sort((a, b) => a - b);
    console.log(`MATERIAL_REQUEST_WARM_P95_MS ${costs[950].toFixed(4)}`);
    const shopping = { ...economy, network: { ...economy.network,
        activity: { rootKey: 'power:5726:12', activity: 'shopping', itemId: 4097 } } };
    assert.equal(Material.request(retained, plan, { spots, economy: shopping, timestamp }), null,
        'a current purchase supersedes the cached recruitment request');
    assert.equal(Material.request({ ...state, inventory: { 4097: { amount: 12 } } }, plan, { spots, economy, timestamp }), null);
    assert.equal(Material.request(state, plan, { spots, economy: { ...economy, stockFor: () => ({ incoming: 12 }) }, timestamp }), null);
    assert.equal(Material.request(state, plan, { spots, economy: { ...economy, network: { focus: ['stock:shots'] } }, timestamp }), null);
    const soloQuote = { ...economy, network: { ...economy.network, plans: new Map([['item:4097',
        { kind: 'drop', executable: true, readyHours: 0.25, tripHours: 0.1 }]]) } };
    assert.equal(Material.request(retained, plan, { spots, economy: soloQuote, timestamp }).materialSoloHours, 3.1,
        'an existing executable source quote preserves the complete alternative solo delivery time');
    const aTarget = Data.items.find(item => item.etc?.rank === 'a' && item.etc?.slot === 12);
    assert(aTarget);
    const aPlan = { ...plan, target: { selfId: aTarget.selfId, slot: 12 } };
    assert.equal(Material.request(state, aPlan, { spots, economy: { ...economy,
        network: { ...economy.network, focus: [`power:${aTarget.selfId}:12`] } }, timestamp }), null,
    'a mixed hunt cannot bypass the native working B kit milestone for A crafting');
    // Early indexed entries can all be invalid. Continue a bounded page on
    // the next cold review instead of permanently losing later sources.
    index = new Map([[4097, entries.map((entry, i) => i < Material.MAX_SOURCE_CHECKS
        ? { ...entry, npcLevel: 1 } : entry)]]);
    // memo: the bot's record in the background thread, which keeps the negative.
    const memo = {}, inspectedBefore = inspected, routesBefore = routeChecks;
    assert.equal(Material.request(state, plan, { spots, economy, memo, timestamp }), null);
    assert.equal(Material.request(state, plan, { spots, economy: { ...economy }, memo, timestamp: timestamp + 1 }), null);
    assert.equal(inspected, inspectedBefore);
    assert.equal(routeChecks, routesBefore, 'a cached negative repeats no safety checks, whatever economy object is passed');
    // A raised section (the decision sequence moved) re-checks before the review time.
    const raised = { ...state, stats: { ...state.stats, decisionSeq: Number(state.stats?.decisionSeq || 0) + 1 } };
    assert(Material.request(raised, plan, { spots, economy, memo, timestamp: timestamp + 2 }),
        'a moved decision re-checks the camps');
    assert.equal(inspected - inspectedBefore, entries.length - Material.MAX_SOURCE_CHECKS,
        'a later review reaches valid sources after the rejected first bounded page');
    assert(Material.request(state, plan, { spots, economy, memo, timestamp: timestamp + Material.REVIEW_MS }),
        'the negative ends at its review time');
    const equippedB = {};
    const role = Planner.roleFor(state);
    for (const entry of invoke('GameServer/Bot/AI/BotGear').planFor({ classId: state.classId, level: 40 }).items) {
        const slot = Number(entry.slot);
        const nativeSlot = ({ 2: 1, 5: 4 })[slot] || slot;
        const item = Data.items.find(item => item.etc?.rank === 'b' && Number(item.etc.slot) === nativeSlot
            && Planner.equipmentCandidate(item, state, role));
        assert(item, `native usable B item for slot ${slot}`);
        const previous = equippedB[item.selfId];
        equippedB[item.selfId] = { selfId: item.selfId, equipped: true, amount: (previous?.amount || 0) + 1,
            slot, equippedSlots: [...(previous?.equippedSlots || []), slot] };
    }
    const c4 = invoke('GameServer/Items/C4RecipeItems');
    const aCraftTarget = Data.items.find(item => item.etc?.rank === 'a' && Number(item.etc.slot) === 12
        && c4.resolveByProductId(item.selfId));
    const aRecipe = c4.resolveByProductId(aCraftTarget.selfId), aMaterial = aRecipe.materials[1];
    const readyAPlan = { ...plan, recipeId: aRecipe.recipeId, target: { selfId: aCraftTarget.selfId, slot: 12 } };
    const readyA = { ...state, inventory: equippedB, stats: { ...state.stats, equipmentPlan: readyAPlan } };
    assert.equal(invoke('GameServer/Bot/AI/PersonalGearProgression').acquisitionAssessment(readyA).required, false);
    const bIndex = index; index = new Map([[aMaterial.selfId, entries]]);
    const aRequest = Material.request(readyA, readyAPlan, { spots, economy: { ...economy,
        network: { ...economy.network, focus: [`power:${aCraftTarget.selfId}:12`] } }, timestamp });
    assert.equal(aRequest?.itemId, aMaterial.selfId, 'after a native complete B kit the same route opens A component hunts');
    assert.equal(aRequest.amount, aMaterial.amount);
    index = bIndex;
    Funding.spendable = () => 1000000;
    const funded = Request.partyRequestForPlan(retained, plan, timestamp, { spots, economy });
    const fallback = require('../src/GameServer/Bot/Population/PartyWaitFallback');
    const cooldown = { ...funded, status: 'deferred', attempts: 3,
        deferredUntil: timestamp + 60000, expiredAt: timestamp - 1 };
    let resupplying = { ...retained, stats: { ...retained.stats, partyRequest: cooldown } };
    const checksBeforeSupplies = [inspected, routeChecks];
    for (const [offset, activity, focus] of [[100, 'hunting', 'stock:shots'], [1000, 'traveling', 'stock:scrolls'],
        [2000, 'shopping', 'stock:shots'], [61000, 'resting', 'stock:shots']]) {
        const stockEconomy = { ...economy, network: { ...economy.network, focus: [focus] } };
        const parked = Request.partyRequestForPlan({ ...resupplying, activity }, plan, timestamp + offset,
            { spots, economy: stockEconomy });
        assert.equal(parked.status, 'deferred', 'supply priority never reopens the material request');
        assert.equal(parked.attempts, 3);
        assert.equal(parked.deferredUntil, cooldown.deferredUntil, 'supply work does not extend or erase the pause');
        assert.equal(parked.suspendedFor, focus);
        assert.equal(fallback.waiting(resupplying, plan, parked), false, 'a parked request cannot override the supply route');
        resupplying = { ...resupplying, stats: { ...resupplying.stats, partyRequest: parked } };
        assert.equal(Request.partyObjectiveForState(resupplying), null, 'parked requests cannot recruit');
    }
    assert.deepEqual([inspected, routeChecks], checksBeforeSupplies, 'restocking performs no source or combat checks');
    const resumed = Request.partyRequestForPlan(resupplying, plan, timestamp + 62000, { spots, economy });
    assert.equal(resumed.status, 'open');
    assert.equal(resumed.attempts, 3, 'the same material operation resumes with its assembly history');
    assert.equal(resumed.suspendedFor, undefined);
    const earlyReturn = Request.partyRequestForPlan({ ...resupplying, stats: { ...resupplying.stats,
        partyRequest: { ...resupplying.stats.partyRequest, deferredUntil: timestamp + 120000 } } },
    plan, timestamp + 62000, { spots, economy });
    assert.equal(earlyReturn.status, 'deferred', 'returning to the weapon cannot bypass a still-live pause');
    assert.equal(earlyReturn.deferredUntil, timestamp + 120000);
    const assemblyReturn = Request.partyRequestForPlan({ ...resupplying, stats: { ...resupplying.stats,
        partyRequest: { ...resupplying.stats.partyRequest, deferReason: 'party_material_route_unavailable',
            deferredUntil: timestamp + 120000 } } }, plan, timestamp + 62000, { spots, economy });
    assert.equal(assemblyReturn.status, 'deferred');
    assert.equal(assemblyReturn.attempts, 3);
    assert.equal(assemblyReturn.suspendedFor, undefined, 'returning from supplies restores the ordinary safe waiting route');
    const stockEconomy = { ...economy, network: { ...economy.network, focus: ['stock:shots'] } };
    for (const [label, next, nextPlan, context] of [
        ['target complete', resupplying, { ...plan, status: 'complete' }, stockEconomy],
        ['changed target', resupplying, { ...plan, target: { selfId: 5730, slot: 12 } }, stockEconomy],
        ['materials collected', { ...resupplying, inventory: { 4097: { amount: 12 } } }, plan, stockEconomy],
        ['item received', { ...resupplying, inventory: { 5726: { amount: 1 } } }, plan, stockEconomy],
        ['materials incoming', resupplying, plan, { ...stockEconomy, stockFor: () => ({ incoming: 12 }) }],
        ['clan owns plan', resupplying, { ...plan, clanGoal: { clanId: 1 } }, stockEconomy]
    ]) {
        assert.equal(Request.partyRequestForPlan(next, nextPlan, timestamp + 62000, { spots, economy: context }), null,
            `${label}: an obsolete need is removed during restocking`);
    }
    const pausedOpen = Request.partyRequestForPlan({ ...retained, stats: { ...retained.stats,
        partyRequest: { ...funded, attempts: 2 } } }, plan, timestamp + 100, { spots, economy: stockEconomy });
    assert.equal(pausedOpen.status, 'deferred');
    assert.equal(pausedOpen.attempts, 2, 'supply priority is not another failed assembly');
    assert.equal(funded.helpDeal.count, 12, 'the helper contract covers the complete missing component quantity');
    assert.equal(funded.helpDeal.fee, 1200);
    const partial = { ...retained, inventory: { 4097: { selfId: 4097, amount: 4 } } };
    const reduced = Request.partyRequestForPlan({ ...partial, stats: { ...partial.stats, partyRequest: funded } },
        plan, timestamp + 1, { spots, economy });
    assert.equal(reduced.helpDeal.count, 8);
    assert.equal(reduced.helpDeal.fee, 800, 'new physical receipts reduce the proposed helper bill');
    const pending = Material.request(state, plan, { spots, economy: { ...economy, stockFor: () => ({ incoming: 3 }) }, timestamp });
    const pendingOwner = { ...state, stats: { ...state.stats, partyRequest: pending } };
    const pendingContract = Agreement.propose(pendingOwner, [pendingOwner], pending);
    assert.equal(pendingContract.materialNeeds[0].quota, 9, 'accepted incoming limits the physical collection quota');

    const Recovery = require('../src/GameServer/Bot/Population/PartyAssemblyRecovery');
    const Lifecycle = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle');
    const rotationIndex = index;
    index = new Map([[4097, entries]]);
    let retryState = state, retryAt = timestamp + 2 * Material.REVIEW_MS;
    const visited = [];
    for (let attempt = 0; attempt <= Material.MAX_CAMPS; attempt++) {
        const current = Request.partyRequestForPlan(retryState, plan, retryAt, { spots, economy });
        assert.equal(current.attempts, attempt, 'changing camp retains the material operation failure count');
        assert.equal(current.requestedAt, retryAt, 'a new camp gets a fresh waiting window');
        visited.push(current.spotId);
        const owner = { ...retryState, stats: { ...retryState.stats, partyRequest: current } };
        const failedParty = { stats: { objective: current, agreement: Agreement.propose(owner, [owner], current) } };
        const departure = Material.departureRequest(failedParty, owner);
        retryState = Lifecycle.releaseMember({ ...owner, activity: 'grouped' }, retryAt, Recovery.REASON, departure);
        assert.equal(Request.partyRequestForPlan(retryState, plan, retryAt + 1, { spots, economy }), retryState.stats.partyRequest,
            'failed assembly still respects the native cooldown');
        retryAt += Math.max(Recovery.RETRY_MS, Material.REVIEW_MS) + 1;
    }
    assert.deepEqual(visited, ['camp:0', 'camp:1', 'camp:2', 'camp:3', 'camp:0'],
        'successive failed assemblies visit every retained camp before repeating');
    const waiting = { ...retryState, stats: { ...retryState.stats, partyRequest: { ...retryState.stats.partyRequest,
        deferReason: null, materialReviewedAt: 0, deferredUntil: retryAt + 60000 } } };
    const deferred = Request.partyRequestForPlan(waiting, plan, retryAt, { spots, economy });
    assert.equal(deferred.status, 'deferred', 'a rotated camp cannot bypass an expired-request cooldown');
    assert.equal(deferred.deferredUntil, retryAt + 60000);
    assert.equal(deferred.attempts, Material.MAX_CAMPS + 1);
    const unrelated = { ...state, stats: { ...state.stats, partyRequest: { ...retryState.stats.partyRequest,
        targetId: 5730, attempts: 3 } } };
    assert.equal(Request.partyRequestForPlan(unrelated, plan, retryAt, { spots, economy }).attempts, 0,
        'a different equipment target starts a new material operation');
    assert.equal(Material.request(unrelated, plan, { spots, economy, timestamp: retryAt }).spotId, 'camp:0');
    const changedMaterial = { ...state, stats: { ...state.stats, partyRequest: { ...unrelated.stats.partyRequest,
        targetId: plan.target.selfId, itemId: 4098 } } };
    assert.equal(Request.partyRequestForPlan(changedMaterial, plan, retryAt, { spots, economy }).attempts, 0,
        'a different component also starts a new material operation');
    index = rotationIndex;

    const coreA = { ...retained, activity: 'party_wait' };
    const coreB = { ...retained, characterId: 990202, clanId: 2, activity: 'party_wait',
        stats: { ...retained.stats, equipmentPlan: { ...plan, target: { selfId: 5730, slot: 12 } },
            partyRequest: { ...request, itemId: 4098, npcId: 627, targetId: 5730 } } };
    const helper = { ...state, characterId: 990203, clanId: 0, spotId: 'another-camp',
        party: { partyId: null, role: 'healer' }, stats: { classId: 16, role: 'healer' } };
    const members = [coreA, coreB, helper];
    const groups = invoke('GameServer/Bot/Population/PopulationService').groupPartyCandidatesByObjective(members);
    assert(groups.some(group => members.every(member => group.includes(member))),
        'different target NPCs at the same camp share their core and a remote support candidate');
    const proposal = Formation.proposalFromStates(members, { timestamp });
    assert.equal(proposal.materialParty, true);
    assert.deepEqual(new Set(proposal.candidates.map(row => row.characterId)), new Set(members.map(row => row.characterId)));
    const selected = Material.selectMembers(members, { timestamp });
    assert.equal(selected.length, 3);
    assert.equal(Composition.roleCoverage(selected).healer, 1);
    const Match = invoke('GameServer/Bot/AI/BotTargetMatchup');
    const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
    const materialNpc = Data.npcs.find(npc => npc.selfId === request.npcId);
    assert(materialNpc, 'the material NPC exists in the native datapack');
    const materialSpot = { id: request.spotId, npcEntries: [{ selfId: request.npcId, pull: 5 }] };
    const weak = [{ level: 65, pAtk: 1, mAtk: 1, pDef: 1, maxHp: 1, atkSpd: 300, skills: [] }];
    const strong = [{ ...weak[0], pAtk: 100000, pDef: 100000, maxHp: 1000000 }];
    assert.equal(Material.canHunt(members, materialSpot, weak), false, 'support damage cannot admit a lethal material pull');
    assert.equal(Material.canHunt(members, materialSpot, strong), true, 'a capable material roster remains eligible');
    const findSpot = SpotProfiles.findById, stateProfiles = Match.stateProfiles;
    try {
        SpotProfiles.findById = () => materialSpot;
        Match.stateProfiles = (_state, options) => {
            assert.equal(options.capacityStates.length, 3, 'formation safety sees the complete proposed roster');
            return weak;
        };
        assert.deepEqual(Material.selectMembers(members, { timestamp }), [], 'formation refuses an incapable material contract');
    } finally { SpotProfiles.findById = findSpot; Match.stateProfiles = stateProfiles; }
    assert.equal(Material.selectMembers([coreA, coreB, { ...helper, stats: { ...helper.stats,
        partyRequest: { status: 'deferred', deferredUntil: Date.now() + 60000 } } }]).length, 2,
    'a helper on its native recruitment cooldown is not recruited without an explicit clock');
    const contract = Agreement.propose(coreA, members, request);
    assert.equal(contract.mode, 'need');
    assert.equal(contract.materialNeeds.length, 2);
    const party = { partyId: 'material-test', memberIds: members.map(row => row.characterId), leaderId: coreA.characterId,
        startedAt: timestamp, spotId: request.spotId, stats: { objective: request, agreement: contract, fightsWon: 0 } };
    assert.equal(Material.target(party, members), 626);
    assert.equal(Material.target({ ...party, stats: { ...party.stats, fightsWon: 1 } }, members), 627);
    assert.equal(Material.target({ ...party, stats: { ...party.stats, fightsWon: 1,
        pveEncounter: {}, materialTargetNpcId: 626 } }, members), 626, 'an unfinished encounter retains its original target');
    const withPiece = { ...coreA, inventory: { 4097: { selfId: 4097, amount: 12 } } };
    assert.equal(Material.target(party, [withPiece, coreB, helper]), 627, 'a completed need leaves the target rotation');
    let prepared = 0;
    const joint = await Calculation.calculate(party, members, async () => { prepared++; throw Error('wish rebuild'); }, timestamp);
    assert.equal(prepared, 0, 'the native party-goal calculation builds no personal or group wish graph');
    assert.equal(joint.memberGoals.length, 3);

    const samePartB = { ...coreB, inventory: { 4097: { selfId: 4097, amount: 11 } },
        stats: { ...coreB.stats, equipmentPlan: plan, partyRequest: { ...request } } };
    const shortA = { ...coreA, inventory: { 4097: { selfId: 4097, amount: 10 } } };
    const splitMembers = [shortA, samePartB, helper];
    const splitContract = Agreement.propose(shortA, splitMembers, request);
    const results = splitMembers.map(member => ({ state: member, result: { materialize: { items: member === helper
        ? [{ selfId: 4097, amount: 3, partySpoil: true }, { selfId: 1867, amount: 1 }] : [] } } }));
    const distribution = Agreement.allocate(results, splitContract, { needScore: () => { throw Error('wish loot scoring'); } });
    assert.deepEqual(distribution.memberResults.map(entry => entry.result.materialize.items
        .filter(item => item.selfId === 4097).reduce((sum, item) => sum + item.amount, 0)), [2, 1, 0],
    'one native stack is split by physical shortages, including agreed spoil');
    assert.equal(distribution.memberResults.flatMap(entry => entry.result.materialize.items)
        .reduce((sum, item) => sum + item.amount, 0), 4, 'allocation conserves every physical unit');
    assert.equal(splitContract.materialNeeds[0].collected, 0, 'allocation does not mutate the source agreement');
    assert.equal(distribution.agreement.materialNeeds[0].collected, 2);
    const quotaReceived = Agreement.allocate([{ state: pendingOwner,
        result: { materialize: { items: [{ selfId: 4097, amount: 9 }] } } }], pendingContract);
    const awaitingDelivery = { ...pendingOwner, inventory: { 4097: { amount: 9 } } };
    assert.equal(Material.needs([awaitingDelivery], pending, quotaReceived.agreement).length, 0,
        'the group does not collect the units already promised by an accepted delivery');
    const completed = [withPiece, { ...coreB, inventory: { 4098: { amount: 12 } } }, helper];
    const resolved = invoke('GameServer/Bot/Population/BackgroundPartyResolver').resolve({ party, members: completed,
        spot: { id: request.spotId }, timestamp });
    assert.equal(resolved.partyPatch.status, 'dissolved');
    assert.equal(resolved.atomic, true, 'completion must release every member and the party in one commit');
    assert.equal(resolved.debug.reason, 'craft_materials_collected');
    assert.equal(resolved.debug.fights, 0);
    const released = require('../src/GameServer/Bot/Population/BackgroundPartyLifecycle')
        .releaseMember({ ...withPiece, activity: 'grouped' }, timestamp, resolved.debug.reason, request);
    assert.equal(released.activity, 'hunting', 'the completed core resumes its native solo/craft lifecycle');
    assert.equal(released.stats.partyRequest, null);
    console.log('PASS material party: bounded source proposal, shared camp, support, quantity contract, target rotation, native loot and completion');
} finally { Object.assign(Planner, { sourceIndexFor: original.sourceIndexFor, itemDropYield: original.itemDropYield,
    sourceRouteReader: original.sourceRouteReader }); Funding.spendable = original.spendable; }
})().catch(error => { console.error(error); process.exitCode = 1; });
