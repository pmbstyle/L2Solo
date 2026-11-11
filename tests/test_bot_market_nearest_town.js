const assert = require('assert');

const isolated = require('./helpers/isolatedSocialDatabase')('test_bot_market_nearest_town');
require('../src/Global');
isolated.assertConfigured(options.default);

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Database = invoke('Database');
Database.init();

const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const OfferOrder = require('../src/GameServer/Bot/Economy/OfferOrder');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdNpcPlanningCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const ClanPlanning = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const { planForMember } = require('../src/GameServer/Clan/ClanEquipmentPlanner');
const ClanEquipmentPlanner = require('../src/GameServer/Clan/ClanEquipmentPlanner');

// Equal-tax towns sell an NPC item at the same price, so a tie must resolve
// to the town nearest the buyer rather than to the alphabetically first one.
const townCenters = {
    'Dark Elven Village': { locX: 12000, locY: 16000 },
    'Dwarven Village': { locX: 116000, locY: -180000 },
    'Elven Village': { locX: 45000, locY: 47000 },
    'Orc Village': { locX: -44000, locY: -112000 },
    'Talking Island': { locX: -84000, locY: 243000 }
};
const npcKitState = (loc) => ({
    characterId: 990101,
    level: 14,
    adena: 100000,
    stats: { classId: 0, role: 'dps' },
    inventory: { 57: { selfId: 57, amount: 100000 } },
    loc
});

function mainThreadPlanning() {
    Object.entries(townCenters).forEach(([town, loc]) => {
        assert.strictEqual(Planner.staticNpcUpgradePlan(npcKitState(loc))?.market?.town, town,
            `a bot near ${town} must buy its NPC kit there`);
    });
    assert.strictEqual(Planner.staticNpcUpgradePlan(npcKitState(undefined))?.market?.town, 'Dark Elven Village',
        'without a known location the NPC kit keeps the deterministic town-name order');

    const originalBestOffer = MarketOpportunity.bestOffer;
    try {
        const sellers = {
            'Dark Elven Village': { sourceType: 'npc', town: 'Dark Elven Village', price: 74, locX: 9745, locY: 15606, available: true, count: Infinity },
            'Talking Island': { sourceType: 'npc', town: 'Talking Island', price: 74, locX: -84318, locY: 244579, available: true, count: Infinity },
            'Gludio': { sourceType: 'npc', town: 'Gludio', price: 90, locX: -14225, locY: 123540, available: true, count: Infinity }
        };
        // The planner asks once for its towns; the one order weighs the trip.
        MarketOpportunity.bestOffer = (_selfId, { towns, cost, accept }) => OfferOrder.best(
            towns.map((town) => sellers[town]).filter((offer) => offer && accept(offer)), { cost });
        const target = { selfId: 48, template: { name: 'Short Gloves' } };
        const nearIsland = { characterId: 8, loc: townCenters['Talking Island'] };
        assert.strictEqual(Planner.marketOfferForTarget(target, nearIsland)?.town, 'Talking Island',
            'a market search near Talking Island buys there at the same price');
        assert.strictEqual(Planner.marketOfferForTarget(target, { characterId: 9, loc: townCenters['Dark Elven Village'] })?.town,
            'Dark Elven Village');
        // The one order weighs the trip (б5): price plus the trip's time at the
        // buyer's hour and the gatekeeper fee (from Talking Island about 21k
        // to Gludio, 24k to the Dark Elven Village).
        sellers['Talking Island'] = { ...sellers['Talking Island'], price: 80 };
        assert.strictEqual(Planner.marketOfferForTarget(target, nearIsland)?.town, 'Talking Island',
            'a few Adena cheaper does not pay for the trip');
        sellers['Talking Island'] = { ...sellers['Talking Island'], price: 30000 };
        assert.strictEqual(Planner.marketOfferForTarget(target, nearIsland)?.town, 'Gludio',
            'a price lower by more than the trip wins: the lowest price with the trip');
    } finally {
        MarketOpportunity.bestOffer = originalBestOffer;
    }
}

function plannedFromHuntingSpot() {
    // A cold bot plans from the centre of its hunting spot, not from its
    // position, which wanders across the spot.
    const catalog = ColdNpcPlanningCatalog.createLookup(npcPlanningCatalogRows());
    const spots = [{ id: 'island_spot', center: { ...townCenters['Talking Island'] } }];
    const atElven = { ...npcKitState(townCenters['Elven Village']), spotId: 'island_spot' };
    assert.strictEqual(Planner.npcEquipmentBridgePlan(atElven, { ...catalog.plannerOptions, spots })?.market?.town,
        'Talking Island', 'the hunting spot centre decides an equal-price tie');
    assert.strictEqual(Planner.npcEquipmentBridgePlan(atElven, catalog.plannerOptions)?.market?.town,
        'Elven Village', 'without the spot list the position decides');
    assert.strictEqual(Planner.replacementPlanFor(atElven, {}, spots, catalog.plannerOptions)?.market?.town,
        'Talking Island', 'a replacement plan buys from the hunting spot too');
}

function coldWorkerPlanning() {
    const catalog = ColdNpcPlanningCatalog.createLookup(npcPlanningCatalogRows());
    Object.entries(townCenters).forEach(([town, loc]) => {
        assert.strictEqual(Planner.npcEquipmentBridgePlan(npcKitState(loc), catalog.plannerOptions)?.market?.town, town,
            `a cold bot near ${town} must buy its NPC kit there`);
    });
    assert.strictEqual(Planner.npcEquipmentBridgePlan(npcKitState(undefined), catalog.plannerOptions)?.market?.town,
        'Dark Elven Village', 'a cold bot without a location keeps the deterministic town-name order');
}

function companionSupplyErrand() {
    // Wooden Arrows cost the same in most towns; Aden is first by name.
    const supplyTown = (origin) => MarketOpportunity.bestSupplyOffer(17, { amount: 100, origin })?.town;
    assert.strictEqual(supplyTown({ locX: 82000, locY: 148000 }), 'Giran',
        'a companion in Giran buys arrows in Giran');
    assert.strictEqual(supplyTown(townCenters['Talking Island']), 'Talking Island');
    assert.strictEqual(supplyTown(undefined), 'Aden', 'without an origin the catalog order is kept');
    const catalogTown = (origin) => MarketOpportunity.supplyCatalog(10000, origin).find((entry) => entry.selfId === 17)?.town;
    assert.strictEqual(catalogTown({ locX: 82000, locY: 148000 }), 'Giran',
        'the supply catalog a companion is shown names the town its errand goes to');
}

async function clanWorkerPlanning() {
    const worker = new ClanPlanning.ClanPlanningCoordinator();
    try {
        const member = { ...npcKitState(townCenters['Talking Island']), phase: 'cold', currentRegion: 'Talking Island' };
        const payload = { member, spots: [], warehouseRows: [], options: { maxExpectedKills: 1500 } };
        const expected = planForMember(member, [], [], payload.options);
        assert.strictEqual(expected?.market?.town, 'Talking Island');
        assert.deepStrictEqual(await worker.plan(payload, DataCache), expected,
            'the clan worker must pick the same nearest town as the main thread');
    } finally {
        await worker.shutdown();
    }
}

function clanPlanKeepsTown() {
    // A clan member walking past the midpoint between two towns that sell
    // its planned NPC item at the same price keeps the planned town.
    const originalMarketPlan = Planner.marketPlanForTarget;
    const planned = { target: { selfId: 48, slot: 10 }, strategy: 'market', status: 'active',
        market: { town: 'Talking Island', price: 74, sourceType: 'npc' } };
    const member = (equipmentPlan) => ({ characterId: 990201, name: 'ClanWalker', level: 14, adena: 100000,
        phase: 'cold', inventory: {}, loc: townCenters['Elven Village'], stats: { equipmentPlan } });
    try {
        Planner.marketPlanForTarget = () => ({ market: { town: 'Elven Village', price: 74, sourceType: 'npc' }, expectedKills: 1 });
        assert.strictEqual(ClanEquipmentPlanner.planForMember(member(planned))?.market?.town, 'Talking Island',
            'an equal-price town nearer to the member must not replace the planned one');
        Planner.marketPlanForTarget = () => ({ market: { town: 'Elven Village', price: 70, sourceType: 'npc' }, expectedKills: 1 });
        assert.strictEqual(ClanEquipmentPlanner.planForMember(member(planned))?.market?.town, 'Elven Village',
            'a cheaper town still replaces the planned one');
    } finally {
        Planner.marketPlanForTarget = originalMarketPlan;
    }
}

// The shared plan selection (worker, resolve, party refresh) compares NPC
// costs from the hunting ground itself: its callers pass no origin.
function selectionPlansFromHuntingSpot() {
    const { selectAcquisitionPlan } = invoke('GameServer/Bot/AI/GearPlanSelection');
    const huntCenter = { locX: -14225, locY: 123540, locZ: 0 };
    const spots = [{ id: 'origin-spot', center: huntCenter }];
    const original = { ...npcKitState(townCenters['Dwarven Village']), spotId: 'origin-spot', phase: 'cold', activity: 'hunting' };
    const lookup = ColdNpcPlanningCatalog.createLookup(npcPlanningCatalogRows());
    // An unarmed bot's NPC weapon is a survival wish of its build: funded
    // from the whole wallet it is the step, and the gear plan buys it (the weapon bridge).
    const Context = invoke('GameServer/Bot/Economy/EconomyContext');
    const unarmed = (adena) => {
        const state = { ...original, adena, inventory: { 57: { selfId: 57, amount: adena } } };
        Context.forget(state.characterId);
        const economy = Context.forState(state, { spots, timestamp: Date.now(), npcOffersFor: id => lookup.offersFor(id),
            routeRows: require('./fixtures/native_gear_economy').prepareRoutes(state) });
        return { state, economy, plan: selectAcquisitionPlan(state, null, { spots, preparedEconomy: economy,
            planningOptions: lookup.plannerOptions }).acquisitionPlan };
    };
    const armedWith = unarmed(100000);
    assert.strictEqual(armedWith.economy.network.activity?.activity, 'shopping', 'the funded bridge is the step');
    assert.strictEqual(armedWith.plan.status, 'active');
    assert.strictEqual(armedWith.plan.strategy, 'market');
    assert(armedWith.plan.weaponBridge, 'the gear plan is the weapon bridge');
    assert.strictEqual(armedWith.economy.network.activity.rootKey, `power:${armedWith.plan.target.selfId}:${armedWith.plan.target.slot}`);
    // A broke unarmed bot hunts for it: the wallet's threshold is the bridge's price (goal_affordable:focus).
    const broke = unarmed(100);
    const afford = broke.economy.statsPacket.wishSections.affordAt;
    assert.strictEqual(afford?.kind, 'focus', 'a broke bot waits for its weapon bridge first');
    assert(afford.at > 100);
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    const raised = wallet => Sections.moneyCrossings(wallet, broke.economy.statsPacket.wishSections).includes('goal_affordable:focus');
    assert.strictEqual(raised(afford.at - 1), false);
    assert.strictEqual(raised(afford.at), true, 'its price in the wallet raises goal_affordable:focus');
    const kit = require('./fixtures/profitable_stock_state').kitFor(0, original.level);
    const wanderer = { ...original, exp: Number(DataCache.experience[13]), currentRegion: 'Dwarven Village',
        loc: { ...original.loc, locZ: 0 }, stats: { ...original.stats }, inventory: structuredClone(kit.inventory) };
    wanderer.inventory[57] = { selfId: 57, name: 'Adena', amount: wanderer.adena, stackable: true };
    assert.strictEqual(invoke('GameServer/Bot/AI/PersonalGearProgression').assess(wanderer).required, false);
    const missing = kit.entries.find(entry => Number(entry.slot) > 0 && ![7, 14].includes(Number(entry.slot))
        && wanderer.inventory[entry.selfId].amount === 1
        && lookup.offersFor(entry.selfId).some(offer => offer.town === 'Orc Village'));
    assert(missing, 'the native NG kit has a single-slot wearable sold by canonical Orc NPCs');
    delete wanderer.inventory[missing.selfId];
    const timestamp = Date.now();
    // Each review is a fresh look at the state this test set: a far bot at work holds its
    // plan through a change of its kit or bag (Reaction), and these are the test's edits.
    const review = () => {
        Context.forget(wanderer.characterId);
        return Context.forState(wanderer, { spots, timestamp,
            routeRows: require('./fixtures/native_gear_economy').prepareRoutes(wanderer),
            npcOffersFor: id => lookup.offersFor(id) });
    };
    let economy = review();
    const shot = economy.stock('shots');
    if (shot.survivalMissing > 0) {
        assert(Number.isFinite(shot.survivalMissing) && Number.isInteger(shot.survivalMissing));
        assert.strictEqual(shot.itemId, invoke('GameServer/Inventory/ShotStock').planForState(wanderer).selfId);
        // The owned use (ShotStock.usePolicy) and the kit rate's use are two numbers, not one yet: both positive.
        assert(shot.ownedUsePerHour > 0 && shot.usePerHour > 0);
        // The shots a fight loads: the paid ones and the beginner grant.
        const current = Number(wanderer.inventory[shot.itemId]?.amount || 0);
        assert.strictEqual(shot.current, current + Number(shot.beginnerCurrent || 0));
        wanderer.inventory[shot.itemId] = { ...(wanderer.inventory[shot.itemId] || {}),
            selfId: shot.itemId, amount: current + shot.survivalMissing, stackable: true, equipped: false };
        economy = review();
        assert.strictEqual(economy.stock('shots').current, current + shot.survivalMissing + Number(shot.beginnerCurrent || 0));
    }
    assert.strictEqual(economy.stock('shots').survivalMissing, 0);
    const activity = economy.network.activity;
    const gear = economy.network.queue.find(wish => wish.key === activity?.rootKey);
    const diagnostic = () => JSON.stringify({ missing: [missing.selfId, missing.slot], activity,
        queue: economy.network.queue.slice(0, 6).map(wish => [wish.key, wish.object?.itemId, wish.object?.slot, wish.funded, wish.price]),
        money: economy.statsPacket.money, admission: economy.projection?.admission && {
            candidates: economy.projection.admission.candidates,
            pending: (economy.projection.admission.pending || []).slice(0, 8),
            admitted: (economy.projection.admission.admitted || []).slice(0, 8) },
        towns: lookup.offersFor(gear?.object?.itemId || missing.selfId).map(offer => offer.town) });
    assert(['hunting', 'shopping', 'crafting'].includes(activity?.activity) && !activity.funding
        && gear?.object?.slot && gear.funded && Array.isArray(economy.statsPacket.money),
    `native nearest-town gear prerequisite: ${diagnostic()}`);
    const offers = lookup.offersFor(gear.object.itemId);
    const gludio = offers.find(offer => offer.town === 'Gludio');
    const gludin = offers.find(offer => offer.town === 'Gludin');
    assert(gludio && gludin && gludio.price > 0 && gludin.price > 0,
        `the actual selected gear has canonical NPC offers in Gludio and Gludin: ${diagnostic()}`);
    const Trip = invoke('GameServer/Bot/Economy/EconomicTrip');
    const fromHunt = Trip.read(wanderer, 'Gludio', { origin: huntCenter });
    const fromPosition = Trip.read(wanderer, 'Gludio');
    assert(fromHunt.known && fromPosition.known,
        `native trips from Gludio hunt-origin and Dwarven position are both known: ${JSON.stringify({ fromHunt, fromPosition })}`);
    const physicalOnly = selectAcquisitionPlan(wanderer, null, { spots: [], timestamp,
        planningOptions: lookup.plannerOptions, preparedEconomy: economy }).acquisitionPlan;
    assert(physicalOnly?.status === 'active' && physicalOnly.strategy === 'market'
        && physicalOnly.market?.sourceType === 'npc' && physicalOnly.market.price > 0
        && physicalOnly.target?.selfId === gear.object.itemId,
    `native physical-position NPC plan: ${JSON.stringify(physicalOnly)}; ${diagnostic()}`);
    const plan = selectAcquisitionPlan(wanderer, null, { spots, timestamp,
        planningOptions: lookup.plannerOptions, preparedEconomy: economy }).acquisitionPlan;
    assert(plan?.status === 'active' && plan.strategy === 'market' && plan.market?.sourceType === 'npc'
        && plan.market.price > 0 && plan.target?.selfId === gear.object.itemId,
    `native nearest-town NPC plan: ${JSON.stringify(plan)}; ${diagnostic()}`);
    assert.notStrictEqual(physicalOnly.market.town, 'Gludio', 'the Dwarven physical position chooses another NPC town');
    assert(offers.some(offer => offer.town === physicalOnly.market.town && offer.price === physicalOnly.market.price),
        'the physical-position choice uses its canonical NPC quote');
    assert.strictEqual(plan.market.price, gludio.price, 'the hunting-origin choice uses the canonical Gludio NPC quote');
    assert.strictEqual(plan?.market?.town, 'Gludio',
        `the selection must buy near the hunting ground, got ${plan?.strategy} ${plan?.market?.town}`);
}

(async () => {
    mainThreadPlanning();
    selectionPlansFromHuntingSpot();
    clanPlanKeepsTown();
    coldWorkerPlanning();
    plannedFromHuntingSpot();
    companionSupplyErrand();
    await clanWorkerPlanning();
    console.log('Bot market nearest town checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { Database.close(); require('node:fs').rmSync(isolated.directory, { recursive: true, force: true }); });
