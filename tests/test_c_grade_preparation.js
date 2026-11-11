'use strict';
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort } = require('node:worker_threads');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Gear = invoke('GameServer/Bot/AI/BotGear');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Progression = invoke('GameServer/Bot/AI/PersonalGearProgression');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
const Occupation = invoke('GameServer/Bot/Population/ColdOccupationSources');
const Valuation = invoke('GameServer/Bot/Economy/EconomicValuation');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const timestamp = 1791669000000;
function kit(classId, level) {
    const inventory = {};
    for (const row of Gear.planFor({ classId, level }).items) {
        const previous = inventory[row.selfId];
        const equippedSlots = [...previous?.equippedSlots || [], row.slot];
        inventory[row.selfId] = { ...row, amount: equippedSlots.length, equippedSlots,
            equippedCount: equippedSlots.length, equipped: true };
    }
    return inventory;
}
function bot(classId = 54, level = 33) {
    const state = { characterId: 990331, level, adena: 10000000, phase: 'cold', activity: 'hunting',
        currentRegion: 'Giran', loc: { locX: 83396, locY: 147904, locZ: -3400 },
        inventory: kit(classId, 20), stats: { classId, exp: Data.experience[level - 1] } };
    state.stats.coldCombat = Profile.legacySnapshot(state, Profile.skillRecordsFromTree(classId, level), timestamp);
    return state;
}
function review(state, board = new BoardIndex(), extra = {}, forget = true) {
    Economy.reset(); if (forget) Profile.forgetBuild(state.characterId);
    return Economy.forState(state, { spots: [], board, timestamp, npcOffersFor: () => [],
        routeRows: Array.from({ length: require('../src/GameServer/Bot/Economy/EconomicTrip').towns.length },
            () => [true, 0, 0]), ...extra });
}
const source = bot(), before = structuredClone(source);
assert.equal(Progression.assess(source).required, false);
const prepared = Progression.preparation(source);
assert.equal(prepared.level, 40);
assert.deepEqual(source, before, 'preparation never changes the physical kit or level');
for (const classId of [0, 10, 18, 25, 38, 49, 50, 53, 54, 56]) {
    const complete = bot(classId);
    assert(Progression.preparation(complete), `full D admits class ${classId}`);
    const missing = structuredClone(complete);
    const weapon = Object.values(missing.inventory).find(row => row.equippedSlots.some(slot => [7, 14].includes(slot)));
    delete missing.inventory[weapon.selfId];
    assert.equal(Progression.preparation(missing), null, 'a missing D weapon blocks early C');
    assert(Progression.assess({ ...complete, level: 40 }).required, 'D opens the C milestone at 40');
    assert(Progression.assess({ ...complete, level: 52 }).required, 'level 52 does not forgive missing C equipment');
}
if (isMainThread) invoke('GameServer/Clan/ClanSupplyPolicy').publish({ id: 1, level: 1, state: {} });
else invoke('GameServer/Clan/ClanSupplyPolicy').useRowSource(id => id === 1 ? [1, 1, [], 1] : undefined);
assert.equal(Progression.preparation({ ...source, clanId: 1 }), null, 'clan early C preparation keeps its existing owner');
// The native gate reads the same ceiling as the wish that chose a prepared C
// target, so a retained wish_focus plan does not refuse the advisory forever.
const cWish = { status: 'deferred', strategy: 'none', reason: 'wish_focus', next: null, target: { selfId: 883, slot: 4 } };
assert.equal(Planner.acquisitionTargetAllowed(source, cWish), true, 'early C preparation admits its C target');
assert.equal(Planner.replanContextFor(source, cWish, timestamp).invalidSource, null);
const gapped = structuredClone(source);
delete gapped.inventory[Object.values(gapped.inventory).find(row => row.equippedSlots.some(slot => [7, 14].includes(slot))).selfId];
assert.equal(Planner.replanContextFor(gapped, cWish, timestamp).invalidSource?.reason, 'c_kit_incomplete', 'a D gap still holds C back');
assert.equal(Planner.acquisitionTargetAllowed({ ...source, clanId: 1 }, cWish), false, 'clan custody keeps the plain ceiling');
for (const classId of [0, 10, 18, 25, 38, 46, 49, 50, 53, 54, 56]) {
    for (const level of [40, 47, 51, 52, 60, 61, 78]) {
        const adult = bot(classId, level), member = { ...adult, clanId: 1 };
        assert(Progression.assess(member).required, `clan D kit opens C milestone for class ${classId} at ${level}`);
        assert.deepEqual([...Progression.assess(member).gaps], [...Progression.assess(adult).gaps],
            'warehouse access does not change personal C equipment gaps');
        assert(Progression.allowsCGradeAcquisition(member));
        assert.equal(Progression.priority(Data.items.find(item => item.selfId === 850), 2,
            Progression.assess(member)), 0, 'a D earring cannot satisfy the C milestone');
    }
    for (const level of [52, 60, 61, 78]) {
        const completeC = { ...bot(classId, level), inventory: kit(classId, 40) };
        assert.equal(Progression.assess(completeC).required, false, `complete C closes class ${classId} at ${level}`);
        assert.equal(Progression.acquisitionRankFor(completeC), Planner.gradeForLevel(level),
            'complete C permits the expertise grade');
        assert.equal(Progression.acquisitionRankFor({ ...bot(classId, level), clanId: 1 }), 'c',
            'missing C caps acquisition without changing expertise');
    }
}
assert.equal(Progression.allowsCGradeAcquisition({ ...source, clanId: 1 }), false,
    'early C preparation retains the pre-40 clan boundary');
assert.equal(Progression.allowsCGradeAcquisition({ ...source, level: 40,
    stats: { ...source.stats, craftStationId: 1 } }), false, 'stationary services are outside equipment acquisition');

for (const level of [52, 61]) {
    const missingHelmet = { ...bot(54, level), inventory: kit(54, 40) };
    const helmet = Object.values(missingHelmet.inventory).find(row => row.equippedSlots.includes(6));
    delete missingHelmet.inventory[helmet.selfId];
    const assessment = Progression.assess(missingHelmet);
    assert(assessment.gaps.has(6), 'a missing helmet remains an equipment opportunity');
    assert.equal(assessment.required, false, 'a C helmet cannot hold higher-grade progression');
    assert.equal(Progression.acquisitionRankFor(missingHelmet), Planner.gradeForLevel(level));
    const candidate = Data.items.find(item => item.selfId === 500);
    assert.equal(Progression.priority(candidate, 6, assessment), 0, 'helmet shopping stays optional');
    assert.equal(Planner.marketPlanForTarget(missingHelmet, candidate.selfId,
        { findMarketOffer: () => ({ price: 100, town: 'Giran', count: 1 }) })?.target.selfId,
    candidate.selfId, 'an available C helmet remains a valid purchase above level 52');
    const received = Planner.equipInventoryUpgrades(missingHelmet, { ...missingHelmet.inventory,
        [helmet.selfId]: { ...helmet, equipped: false, equippedCount: 0, equippedSlots: [] } });
    assert(received[helmet.selfId].equipped, 'a suitable received helmet is still worn');
    const profiles = [{ id: 'helmet-field', avgLevel: 46,
        npcEntries: [{ selfId: 222, name: 'Krator', count: 4 }] }];
    assert(Planner.sourceIndexFor(profiles).has(candidate.selfId), 'the helmet has a real authored drop source');
    assert.deepEqual(Planner.sourceForItem(candidate.selfId, profiles, missingHelmet), [], 'optional C helmets are bought or crafted');
}

// The last paired C slot must win over a cheap B offer and a persisted B goal.
// Completing that slot immediately opens higher-grade planning on the same bot.
const Index = invoke('GameServer/Item/ItemTemplateIndex');
const Providers = invoke('GameServer/Bot/Economy/WishProviders');
const exchangeEar = Data.items.find(item => item.selfId === 852);
const higherEar = Data.items.find(item => item.etc?.rank === 'b' && item.etc?.slot === 1
    && Planner.considerable(item, { ...bot(54, 52), inventory: kit(54, 40) }));
assert(higherEar, 'authored B earring fixture');
for (const level of [52, 60, 61, 78]) {
    const completeC = { ...bot(54, level), inventory: kit(54, 40) };
    const supplies = Economy.basics(completeC);
    for (const kind of ['shots', 'potions', 'scrolls']) {
        const itemId = supplies.stock(kind).itemId;
        completeC.inventory[itemId] = { selfId: itemId, amount: 100000 };
    }
    const oldEar = Object.values(completeC.inventory).find(row => row.equippedSlots?.includes(2));
    const ear = { ...oldEar, selfId: exchangeEar.selfId, name: exchangeEar.template.name };
    delete completeC.inventory[oldEar.selfId];
    completeC.inventory[ear.selfId] = ear;
    const missingC = { ...completeC, inventory: { ...completeC.inventory,
        [ear.selfId]: { ...ear, amount: 1, equippedCount: 1, equippedSlots: [1] } } };
    assert.deepEqual([...Progression.assess(missingC).gaps.keys()], [2]);
    assert.equal(Planner.gradeForLevel(level), level >= 76 ? 's' : level >= 61 ? 'a' : 'b',
        'expertise stays at the physical level');
    assert.equal(Progression.acquisitionRankFor(missingC), 'c');
    const offerForC = item => item.selfId === ear.selfId ? { price: 100, town: 'Giran', count: 1 } : null;
    const nativeC = Planner.planFor(missingC, { findMarketOffer: offerForC, craftRecipes: [], spots: [] });
    assert.equal(nativeC.target?.selfId, ear.selfId, 'native planning also fills a second identical C piece');
    assert.equal(nativeC.target.slot, 2);
    assert.equal(Planner.marketPlanForTarget(missingC, ear.selfId, { findMarketOffer: offerForC }).target.slot, 2);
    assert.equal(Planner.considerable(higherEar, missingC), false);
    assert.equal(Planner.preferredTarget(missingC, { wishTargetId: higherEar.selfId }), null);
    assert.equal(Planner.marketPlanForTarget(missingC, higherEar.selfId,
        { findMarketOffer: () => ({ price: 1, town: 'Giran', count: 1 }) }), null);

    const staleB = { status: 'active', strategy: 'direct_drop', grade: 'b',
        plannedForLevel: level, rateModelVersion: Planner.RATE_MODEL_VERSION,
        rateProfileSignature: Planner.rateProfileSignature(),
        target: { selfId: higherEar.selfId, slot: 2 }, clanGoal: { clanId: 1, goalKey: 'old-b-earring' } };
    const member = { ...missingC, clanId: 1,
        stats: { ...missingC.stats, equipmentPlan: staleB, wishFocus: [`power:${higherEar.selfId}:2`, 0, 1] } };
    assert.equal(Planner.acquisitionTargetAllowed(member, staleB), false);
    assert.equal(Planner.clanGoalPlanLocked(member, staleB), false);
    assert.equal(Planner.replanContextFor(member, staleB, timestamp).routeCurrent, false);
    assert.equal(Planner.replanContextFor(member, staleB, timestamp).invalidSource.reason, 'c_kit_incomplete');
    assert.equal(Planner.bestSourceForPlan(member, staleB, []), null);
    assert.equal(Planner.safeFallbackForPlan(member, staleB, []), null);
    const cPlan = { ...staleB, grade: 'c', target: { selfId: ear.selfId, slot: 2 } };
    assert.equal(Planner.replanContextFor(member, cPlan, timestamp).routeCurrent, true,
        'a current C route stays reusable above level 52');
    const choices = Providers.gearCandidates(member);
    assert([...choices.values()].flat().every(item => ['none', 'd', 'c'].includes(item.etc.rank)),
        'the candidate catalogue cannot nominate higher grades before full C');

    const offers = new BoardIndex();
    offers.put({ id: 101, ownerId: 990335, storeType: 1, kind: 'shop', town: 'Giran',
        lines: [{ lineId: 10, selfId: ear.selfId, count: 1, enchant: 0, price: 100 },
            { lineId: 11, selfId: higherEar.selfId, count: 1, enchant: 0, price: 1 }] });
    const waiting = review(member, offers);
    assert(waiting.projection.roots.includes(`power:${ear.selfId}:2`));
    assert(!waiting.projection.roots.some(key => key.startsWith('level:')),
        'XP remains optional only after the C milestone is closed');
    assert(waiting.network.queue.filter(row => row.object?.slot).every(row =>
        Index.find(Data.items, row.object.itemId)?.etc.rank === 'c'));
    assert.equal(waiting.network.activity.rootKey, `power:${ear.selfId}:2`,
        'the missing C earring wins even when B is cheaper and was the old focus');
    const crystalPath = waiting.projection.nodes.find(row => row.key === `item:${ear.selfId}`)
        ?.paths.find(row => row.kind === 'luxury_exchange');
    assert(crystalPath, 'Luxury remains an available C acquisition route after 52');
    const clanPlan = invoke('GameServer/Clan/ClanEquipmentPlanner').planForMember(member, [], [], {
        throwOnError: true, maxExpectedKills: Infinity, craftRecipes: [] });
    assert.notEqual(clanPlan.target?.selfId, higherEar.selfId, 'the clan retires an unfinished higher-grade plan');

    const delivered = Planner.equipInventoryUpgrades(member, { ...member.inventory,
        [ear.selfId]: { ...ear, amount: 2 } });
    const finished = { ...member, inventory: delivered };
    assert.equal(Progression.assess(finished).required, false);
    assert(Planner.considerable(higherEar, finished));
    const next = review(finished, offers);
    assert.equal(Progression.acquisitionAssessment(finished).rank, 3);
    assert(next.projection.roots.some(key => key.startsWith('power:')
        && Index.find(Data.items, Number(key.split(':')[1]))?.etc.rank === 'b'),
        'delivery of the last C piece opens B progression without another level-up');
    const bWorn = { ...finished, inventory: { ...delivered,
        [ear.selfId]: { ...delivered[ear.selfId], amount: 1, equippedCount: 1, equippedSlots: [1] },
        [higherEar.selfId]: { selfId: higherEar.selfId, amount: 1, equipped: true,
            equippedCount: 1, equippedSlots: [2], slot: 2 } } };
    assert.equal(Progression.assess(bWorn).required, false, 'worn B satisfies the C minimum without a downgrade');
}

const board = new BoardIndex();
board.put({ id: 91, ownerId: 990332, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 1, selfId: 162, count: 1, enchant: 0, price: 10000 }] });
const ctx = review(source, board);
assert(ctx.projection.roots.some(key => /^power:/.test(key)
    && Data.items.find(item => item.selfId === Number(key.split(':')[1]))?.etc.rank === 'c'),
    'native wishes compare C sources before 40 after completing D');
Profile.forgetBuild(source.characterId);
const missing = structuredClone(source);
delete missing.inventory[Object.values(missing.inventory).find(row => row.equippedSlots.includes(12)).selfId];
assert(!review(missing, board).projection.roots.some(key => /^power:/.test(key)
    && Data.items.find(item => item.selfId === Number(key.split(':')[1]))?.etc.rank === 'c'),
    'native wishes fill the D gap first');
assert(Planner.preferredTarget(source, { wishTargetId: 162 }), 'native acquisition accepts the chosen early C target');
const sourcePlan = Planner.planFor(source, { wishTargetId: 162, board, spots: [] });
assert.equal(sourcePlan.target.selfId, 162, 'native replan retains the early C target');
const recipe = invoke('GameServer/Items/C4RecipeItems').resolveByProductId(162);
assert(recipe, 'authored War Axe recipe');
const inputs = Object.fromEntries(recipe.materials.map(row => [row.selfId, { ...row, equipped: false }]));
const customer = { ...source, inventory: { ...source.inventory, ...inputs } };
const service = { characterId: 990334, recipeId: recipe.recipeId, price: 1, entryPrice: 1,
    revision: 2, townName: 'Giran', loc: source.loc, capacityBatches: 1 };
const crafted = review(customer, board, { workshops: id => id === recipe.recipeId ? [service] : [] });
const provider = crafted.projection.nodes.find(row => row.key === 'item:162')?.paths.find(row => row.kind === 'craft');
assert(provider?.workshop, 'a full D customer can use a real C workshop before 40');
assert.equal(provider.requiresRecipeLearning, false, 'the customer does not learn the dwarf recipe');
assert(!provider.grossRequirements.some(row => row.key === `item:${recipe.recipeItemId}`));
const exchangePath = ctx.projection.nodes.find(row => row.key === 'item:162')?.paths.find(row => row.kind === 'luxury_exchange');
assert(exchangePath, 'native C choices include the authored Luxury route');
assert.deepEqual(exchangePath.grossRequirements, [{ key: 'item:1458', amount: 5375 }]);
assert(!ctx.projection.nodes.some(row => row.key === 'item:1459'), 'the bot Luxury path never acquires C crystals');
const stocked = { ...source, level: 40, inventory: { ...source.inventory, 1463: { selfId: 1463, amount: 100000 } } };
const dStock = { ...stocked, inventory: { ...stocked.inventory, 1458: { selfId: 1458, amount: 10000 } } };
const readyExchange = review(dStock);
assert.equal(readyExchange.network.activity?.kind, 'luxury_exchange', 'a prepared native Luxury leaf is executable');
assert.equal(readyExchange.network.activity.activity, 'improving');
const exchangePlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(dStock, readyExchange);
assert.equal(exchangePlan?.strategy, 'luxury_exchange');
assert(exchangePlan.materials.every(row => row.selfId === 1458));
const clanStock = { ...dStock, level: 47, clanId: 1,
    stats: { ...dStock.stats, wishFocus: ['power:850:2', 0, 0] } };
const clanExchange = review(clanStock);
assert.equal(clanExchange.network.activity.kind, 'luxury_exchange', 'a clan member can execute its own C exchange');
assert.notEqual(clanExchange.network.focus[0], 'power:850:2', 'an obsolete D focus cannot hold the C milestone');
assert(clanExchange.network.queue.filter(row => row.object?.slot).every(row =>
    Data.items.find(item => item.selfId === row.object.itemId)?.etc.rank === 'c'),
    'clan gear wishes acquire C while the D kit is inadequate');
assert(!clanExchange.projection.roots.some(key => key.startsWith('level:')), 'clan C equipment precedes leveling');
const crystalBoard = new BoardIndex();
crystalBoard.put({ id: 92, ownerId: 990333, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 2, selfId: 1458, count: 10000, enchant: 0, price: 1 }] });
const waitingExchange = review(stocked, crystalBoard);
assert.equal(waitingExchange.network.activity.itemId, 1458, 'missing D crystals become a real acquisition leaf');
assert.equal(waitingExchange.network.activity.activity, 'shopping');
assert(!review(source).network.leaves?.some(row => row.kind === 'luxury_exchange'), 'missing inputs cannot execute the exchange');
const Crystals = invoke('GameServer/Bot/Economy/BotCrystallization');
const spareId = Crystals.catalog().find(id => !stocked.inventory[id]);
const gearBoard = new BoardIndex();
gearBoard.put({ id: 93, ownerId: 990335, storeType: 1, kind: 'shop', town: 'Giran',
    lines: [{ lineId: 3, selfId: spareId, count: 16, enchant: 0, price: 1 }] });
const gearInput = review(stocked, gearBoard);
assert.equal(gearInput.network.activity.itemId, spareId, 'a cheap D market item can fund Luxury crystals');
assert.equal(gearInput.network.activity.activity, 'shopping');
const fromGear = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(stocked, gearInput);
assert(fromGear.materials.some(row => row.selfId === spareId && row.amount >= 1 && row.amount <= Crystals.BATCH_LIMIT),
    'the native plan reserves a bounded purchase batch');
const readyBag = { ...stocked, inventory: { ...stocked.inventory, [spareId]: { selfId: spareId, amount: 16, equipped: false } } };
const readyCrystals = review(readyBag, gearBoard);
assert.equal(readyCrystals.network.activity.kind, 'crystallize');
assert(readyCrystals.network.activity.improvement.amount >= 1);
const smallKit = kit(54, 40);
for (const id of Object.keys(smallKit)) if (smallKit[id].equippedSlots.some(slot => [7, 14].includes(slot))) delete smallKit[id];
const smallWeapon = Object.values(stocked.inventory).find(row => row.equippedSlots?.some(slot => [7, 14].includes(slot)));
const smallBag = { ...stocked, inventory: { ...smallKit, [smallWeapon.selfId]: smallWeapon, 1463: stocked.inventory[1463],
    [spareId]: { selfId: spareId, amount: 2, equipped: false } } };
const smallBatch = review(smallBag, gearBoard);
assert.equal(smallBatch.network.activity.kind, 'crystallize', 'held spares run before buying more for the full C goal');
assert.equal(smallBatch.network.activity.improvement.amount, 2);
const smallPlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(smallBag, smallBatch);
assert.equal(smallPlan.materials.find(row => row.selfId === spareId).amount, 2,
    'native reservations follow the two-item command, rather than the entire future input supply');
assert(Crystals.ready({ ...smallBag, stats: { ...smallBag.stats, equipmentPlan: smallPlan } }),
    'physical two-item command remains ready when the market offers sixteen more');
const smallCard = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture(smallBatch, smallBag);
assert.equal(smallCard.activity.improvement.amount, 2, 'the compact worker card keeps the physical command quantity');
assert(smallCard.data.byteLength <= 800);
const smallWatch = invoke('GameServer/Bot/Economy/TradeIntent').project(smallBag, smallBatch.network,
    smallBatch.projection, () => 1);
assert(!smallWatch.some(row => row.itemId === spareId), 'the retained command does not advertise inputs already held');
assert(smallWatch.every(row => Number.isFinite(row.valueHours)), 'retaining a command preserves its output share');
const card = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture(readyCrystals, readyBag);
assert.equal(card.activity.improvement.amount, readyCrystals.network.activity.improvement.amount);
assert(card.data.byteLength <= 800, 'the worker/native decision keeps its byte bound');
const mixedIds = Crystals.catalog().filter(id => !stocked.inventory[id]).slice(0, 4);
const mixedBag = { ...stocked, inventory: { ...stocked.inventory,
    ...Object.fromEntries(mixedIds.map(id => [id, { selfId: id, amount: 2, equipped: false }])) } };
const mixed = Crystals.choices(mixedBag, () => null, { known: true, hours: 0, fees: 0 })[0];
assert.equal(mixed.inputs.length, 4, 'one bounded batch can combine distinct spare types');
assert(mixed.inputs.reduce((count, row) => count + row.amount, 0) <= Crystals.BATCH_LIMIT);
assert.equal(mixed.net, mixed.inputs.reduce((count, row) => count
    + row.amount * Crystals.reward(Data.items.find(item => item.selfId === row.selfId)).net, 0));
const mixedActivity = { ...readyCrystals.network.activity, improvement: {
    kind: 'crystallize', npcId: Crystals.npcId, items: mixed.inputs, amount: 1 } };
const mixedCard = invoke('GameServer/Bot/Population/ColdEconomyDecision').capture({ ...readyCrystals,
    network: { ...readyCrystals.network, activity: mixedActivity } }, mixedBag);
assert.deepEqual(mixedCard.activity.improvement.items, mixed.inputs);
assert(mixedCard.data.byteLength <= 800, 'mixed batch transport keeps the same byte bound');
const townPlan = invoke('GameServer/Bot/Economy/WishProviders').personalCraftPlan(readyBag, readyCrystals);
const townReady = { ...readyBag, stats: { ...readyBag.stats, equipmentPlan: townPlan } };
assert(Crystals.ready(townReady), 'owned inputs admit the finite town command');
assert.equal(invoke('GameServer/Bot/Population/ColdSimulationKernel').lifecycleKind(townReady), 'command');
assert(!Crystals.ready({ ...townReady, inventory: { ...townReady.inventory,
    [spareId]: { ...townReady.inventory[spareId], amount: 0 } } }));
assert(Crystals.ready({ ...townReady, clanId: 1 }), 'a clan member with owned inputs admits its C town command');
assert.equal(invoke('GameServer/Bot/Population/ColdSimulationKernel').lifecycleKind({ ...townReady, clanId: 1 }), 'command');
const Improvement = invoke('GameServer/Bot/Economy/BotImprovementService');
const outside = { ...townReady, activity: 'hunting', currentRegion: 'Dion',
    loc: { locX: 18748, locY: 145437, locZ: -3132 } };
const townTrip = Improvement.acquisitionTravel(outside, readyCrystals.network.activity, timestamp);
assert.equal(townTrip.activity, 'traveling');
assert.equal(townTrip.stats.travel.townName, 'Giran', 'the selected NPC operation owns the destination');
assert(townTrip.adena < outside.adena, 'the real gatekeeper trip debits its fee');
assert.equal(Improvement.acquisitionTravel(townReady, readyCrystals.network.activity, timestamp), null);
const clanTrip = Improvement.acquisitionTravel({ ...outside, clanId: 1 }, readyCrystals.network.activity, timestamp);
assert.equal(clanTrip.stats.travel.townName, 'Giran', 'the clan member can reach its own C exchange station');
assert(clanTrip.adena < outside.adena);
assert.equal(Improvement.acquisitionTravel({ ...outside, level: 33, clanId: 1 }, readyCrystals.network.activity, timestamp), null);
assert.equal(require('../src/GameServer/Bot/Population/BotRoute').route(outside, null, null, [], { spots: [], timestamp }), null,
    'a ready NPC operation suppresses the competing hunting route');
const npcInput = review(stocked, new BoardIndex(), { npcOffersFor: id => id === spareId
    ? [{ selfId: id, price: 1, sourceType: 'npc', town: 'Giran', available: true }] : [] });
assert.equal(npcInput.network.activity.itemId, spareId, 'native shop equipment is also a crystal source');
const adultKit = kit(54, 40);
for (const id of Object.keys(adultKit)) if (adultKit[id].equippedSlots.some(slot => [7, 14].includes(slot))) delete adultKit[id];
const dWeapon = Object.values(stocked.inventory).find(row => row.equippedSlots?.some(slot => [7, 14].includes(slot)));
const weaponOnly = { ...stocked, inventory: { ...adultKit, [dWeapon.selfId]: dWeapon, 1463: stocked.inventory[1463] } };
const multiple = review(weaponOnly, gearBoard);
assert(multiple.network.activity.amount > 1 && multiple.network.activity.itemId === spareId,
    'a larger C gap orders several real D items, rather than assuming a fractional item');

const stashed = { ...source, inventory: { ...source.inventory,
    162: { selfId: 162, amount: 1, slot: 7, equipped: false },
    883: { selfId: 883, amount: 2, slot: 4, equipped: false } } };
const physical = Planner.equipInventoryUpgrades(stashed, stashed.inventory);
assert.equal(physical[162].equipped, false, 'C remains in the bag before expertise');
assert.equal(physical[883].equipped, false);
assert.equal(Progression.preparedAmounts(stashed)[162], 1);
assert.equal(Progression.preparedAmounts(stashed)[883], 2, 'both future rings are reserved');
assert.equal(Disposition.reservedEquipmentAmounts(stashed)[162], 1);
const steps = Occupation.reservations(stashed); let step;
do step = steps.next(); while (!step.done);
assert.equal(step.value[162], 1, 'worker production and native sales share future gear reservation');
assert.equal(step.value[883], 2);
assert(!Disposition.saleCandidates(stashed).some(row => [162, 883].includes(row.selfId)),
    'prepared equipment is not sold as surplus');
assert(!review(stashed, board).projection.roots.includes('power:162:7'), 'owned future weapon is not bought twice');
const wearable = Planner.equipInventoryUpgrades({ ...stashed, level: 40 }, stashed.inventory);
assert(wearable[162].equipped && wearable[883].equippedCount === 2, 'native reconciliation wears C from level 40');
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 1, horizonHours: 18,
    notBeforeHours: 6, delayHours: 3 }), 12, 'preparing early cannot earn combat benefit before 40');
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 1, horizonHours: 18,
    notBeforeHours: 6, delayHours: 9 }), 9, 'late readiness loses only usable C hours');
assert.equal(Valuation.readyBenefit({ valueHours: 12, benefitPerHour: 1, horizonHours: 18,
    notBeforeHours: 6, delayHours: 100 }), 0);
console.log(`PASS native C preparation: full D gate, classes, future horizon, workshop/Luxury/input goals, stash and expertise ${isMainThread ? 'main' : 'worker'}`);
if (isMainThread) {
    const worker = new Worker(__filename);
    worker.on('error', error => { console.error(error); process.exitCode = 1; });
    worker.on('exit', code => { if (code) process.exitCode = code; });
} else parentPort.postMessage('verified');
