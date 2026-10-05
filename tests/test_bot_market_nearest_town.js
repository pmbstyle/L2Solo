const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

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
    const context = await ClanPlanning.context();
    const worker = new ClanPlanning.ClanPlanningCoordinator();
    try {
        const member = { ...npcKitState(townCenters['Talking Island']), phase: 'cold', currentRegion: 'Talking Island' };
        const payload = { member, spots: [], warehouseRows: [], context, options: { maxExpectedKills: 1500 } };
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

// The shared plan selection (worker, resolve, party refresh) ranks equal-price
// towns from the bot's hunting ground itself: its callers pass no origin.
function selectionPlansFromHuntingSpot() {
    const { selectAcquisitionPlan } = invoke('GameServer/Bot/AI/GearPlanSelection');
    const spots = [{ id: 'origin-spot', center: townCenters['Orc Village'] }];
    const wanderer = { ...npcKitState(townCenters['Dwarven Village']), spotId: 'origin-spot', phase: 'cold', activity: 'hunting' };
    const plan = selectAcquisitionPlan(wanderer, null, { spots, occupancy: {} }).acquisitionPlan;
    assert.strictEqual(plan?.market?.town, 'Orc Village',
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
})().catch((error) => { console.error(error); process.exitCode = 1; });
