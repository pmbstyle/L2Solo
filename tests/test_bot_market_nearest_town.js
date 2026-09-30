const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const Planner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ColdNpcPlanningCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');
const { npcPlanningCatalogRows } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const ClanPlanning = require('../src/GameServer/Clan/ClanPlanningCoordinator');
const { planForMember } = require('../src/GameServer/Clan/ClanEquipmentPlanner');

// NPC prices are equal across towns, so a tie must resolve to the town
// nearest the buyer rather than to the alphabetically first one.
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
        MarketOpportunity.bestOffer = (_selfId, { town }) => sellers[town] || null;
        const target = { selfId: 48, template: { name: 'Short Gloves' } };
        const nearIsland = { characterId: 8, loc: townCenters['Talking Island'] };
        assert.strictEqual(Planner.marketOfferForTarget(target, nearIsland)?.town, 'Talking Island',
            'a market search near Talking Island buys there at the same price');
        assert.strictEqual(Planner.marketOfferForTarget(target, { characterId: 9, loc: townCenters['Dark Elven Village'] })?.town,
            'Dark Elven Village');
        sellers['Talking Island'] = { ...sellers['Talking Island'], price: 80 };
        assert.strictEqual(Planner.marketOfferForTarget(target, nearIsland)?.town, 'Dark Elven Village',
            'a lower price still wins over distance');
    } finally {
        MarketOpportunity.bestOffer = originalBestOffer;
    }
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

(async () => {
    mainThreadPlanning();
    coldWorkerPlanning();
    companionSupplyErrand();
    await clanWorkerPlanning();
    console.log('Bot market nearest town checks passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
