const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GoalExecutor = invoke('GameServer/Bot/Goals/GoalExecutor');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MerchantStoreConfigs = invoke('GameServer/Bot/MerchantStoreConfigs');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const ShopPlaces = invoke('GameServer/Bot/Economy/ShopPlaces');

DataCache.init();

const dWeapon = DataCache.items.find((item) => item?.etc?.rank === 'd' && item.template?.kind?.startsWith('Weapon.'));
assert(dWeapon, 'datapack must contain a D-grade weapon for market routing coverage');
const noGradeSaleItem = DataCache.items.find((item) => item?.template?.kind?.startsWith('Other.Material') && Number(item.template?.price) > 0);
assert(noGradeSaleItem, 'datapack must contain a sellable no-grade material for local-market routing coverage');

const state = {
    characterId: 301,
    name: 'DGradeSeller',
    level: 25,
    activity: 'hunting',
    currentRegion: 'Gludio',
    loc: { locX: -12736, locY: 122816, locZ: -3114 },
    inventory: {
        [dWeapon.selfId]: {
            selfId: dWeapon.selfId,
            name: dWeapon.template.name,
            amount: 1,
            kind: dWeapon.template.kind,
            rank: 'd'
        }
    },
    stats: {},
    timing: {}
};

const travel = GoalExecutor.beginMarketTravel(state, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, 1000);

assert.strictEqual(travel.stats.travel.townName, 'Gludio', 'D-grade sellers must use the Gludio market instead of Giran');
assert.strictEqual(
    ListingService.targetMarketTownName(state, [{ rank: 'd' }]),
    'Gludio',
    'existing D-grade listings must be rebalanced out of Giran too'
);
assert.strictEqual(
    ListingService.targetMarketTownName(state, [{ selfId: dWeapon.selfId }]),
    'Gludio',
    'legacy store rows without a persisted rank must recover the grade from their item id'
);
assert.strictEqual(ListingService.targetMarketTownName(state, [{ selfId: 1900 }]), 'Gludio',
    'a D-grade recipe fragment must follow its crafted equipment grade');
assert.strictEqual(ListingService.targetMarketTownName(state, [{ selfId: 2935 }]), 'Giran',
    'a C-grade recipe fragment must not be routed as a no-grade material');
assert.strictEqual(ListingService.targetMarketTownName(state, [{ selfId: 1919 }]), 'Giran',
    'a B-grade recipe fragment must use Giran');
assert.strictEqual(ListingService.targetMarketTownName(state, [{ selfId: 1865 }]), 'Elven Village',
    'shared no-grade resources must keep their local starter market');
assert(Number.isInteger(ListingService.MARKET_TOWN_ROUTING_VERSION) && ListingService.MARKET_TOWN_ROUTING_VERSION > 0, 'legacy market migration must be versioned and finite');
const legacyStore = {
    ...state,
    phase: 'cold',
    activity: 'merchant',
    updatedAt: 1,
    stats: { marketStore: { town: 'Giran', items: [{ rank: 'd', count: 1 }] } }
};
const currentStore = {
    ...legacyStore,
    characterId: 399,
    updatedAt: 0,
    stats: { marketStore: { ...legacyStore.stats.marketStore, marketTownRoutingVersion: ListingService.MARKET_TOWN_ROUTING_VERSION } }
};
assert.deepStrictEqual(
    ListingService.legacyMarketTownCandidates([currentStore, legacyStore]).map((candidate) => candidate.characterId),
    [legacyStore.characterId],
    'only stores created before town routing are eligible for the transition migration'
);
const first = ShopPlaces.take('Gludio', 'test:first');
assert(ShopPlaces.isStallArea('Gludio', first), 'Gludio D-grade listings must remain inside the captured trading square');
const second = ShopPlaces.take('Gludio', 'test:second');
const dx = second.locX - first.locX;
const dy = second.locY - first.locY;
assert(Math.sqrt(dx * dx + dy * dy) >= ShopPlaces.SPACING, 'Gludio D-grade stalls must not overlap');
const dionState = {
    ...state,
    characterId: 399,
    loc: { locX: 15600, locY: 143100, locZ: -2707 }
};
const dionTravel = GoalExecutor.beginMarketTravel(dionState, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, 1000);
assert.strictEqual(dionTravel.stats.travel.townName, 'Dion', 'D-grade overflow must use the Dion market instead of overfilling Gludio');
const dionStall = ShopPlaces.take('Dion', 'test:dion');
assert(ShopPlaces.isStallArea('Dion', dionStall), 'Dion D-grade listings must remain inside the captured trading square');

// Fill every square: no dynamic stall stands closer than the spacing to a
// fixed merchant of its town.
for (const town of Object.keys(ShopPlaces.PLAZAS)) {
    const fixed = Object.values(MerchantStoreConfigs).filter((store) => store.town === town);
    for (let index = 0; ; index++) {
        const loc = ShopPlaces.take(town, `test:fill:${town}:${index}`);
        if (!loc) break;
        assert(fixed.every((store) => Math.hypot(loc.locX - store.locX, loc.locY - store.locY) >= ShopPlaces.SPACING),
            `dynamic ${town} stalls must keep their distance from fixed merchants`);
    }
    assert.strictEqual(ShopPlaces.take(town, 'test:overflow'), null, `a full ${town} square has no place left`);
}
ShopPlaces._resetForTests();

const noGradeState = {
    ...state,
    characterId: 302,
    level: 10,
    loc: { locX: -84200, locY: 244600, locZ: -3730 },
    inventory: {
        [noGradeSaleItem.selfId]: {
            selfId: noGradeSaleItem.selfId,
            name: noGradeSaleItem.template.name,
            amount: 1,
            kind: noGradeSaleItem.template.kind
        }
    }
};
const noGradeOverflowState = {
    ...noGradeState,
    characterId: 400,
    level: 25,
    loc: { locX: 16000, locY: 143500, locZ: -2800 }
};
assert.strictEqual(
    ListingService.targetMarketTownName(noGradeOverflowState, [{ rank: 'none' }]),
    'Elven Village',
    'a no-grade-only listing must use the nearest starter market even when its farming spot is outside the village radius'
);
assert.strictEqual(
    ListingService.targetMarketTownName({
        ...noGradeOverflowState,
        stats: { marketReturn: { loc: { locX: -84200, locY: 244600, locZ: -3730 } } }
    }, [{ rank: 'none' }]),
    'Talking Island',
    'legacy no-grade listings must use their departure point to return to the local starter market'
);
assert.strictEqual(
    ListingService.targetMarketTownName(noGradeState, [{ rank: 'none' }]),
    'Talking Island',
    'nearby no-grade sellers must use the captured Talking Island market'
);
const talkingIslandStall = ShopPlaces.take('Talking Island', 'test:ti');
assert(ShopPlaces.isStallArea('Talking Island', talkingIslandStall), 'Talking Island no-grade listings must remain inside the captured trading square');

const elvenState = {
    ...noGradeState,
    characterId: 303,
    loc: { locX: 46600, locY: 50000, locZ: -3060 }
};
assert.strictEqual(
    ListingService.targetMarketTownName(elvenState, [{ rank: 'none' }]),
    'Elven Village',
    'nearby no-grade sellers must use the captured Elven Village market'
);
const elvenStall = ShopPlaces.take('Elven Village', 'test:elvenStall');
assert(ShopPlaces.isStallArea('Elven Village', elvenStall), 'Elven Village no-grade listings must remain inside the captured trading square');

const darkElvenState = {
    ...noGradeState,
    characterId: 304,
    loc: { locX: 12700, locY: 16600, locZ: -4585 }
};
assert.strictEqual(
    ListingService.targetMarketTownName(darkElvenState, [{ rank: 'none' }]),
    'Dark Elven Village',
    'nearby no-grade sellers must use the captured Dark Elven Village market'
);
const darkElvenStall = ShopPlaces.take('Dark Elven Village', 'test:darkElvenStall');
assert(ShopPlaces.isStallArea('Dark Elven Village', darkElvenStall), 'Dark Elven Village no-grade listings must remain inside the captured trading square');

const orcState = {
    ...noGradeState,
    characterId: 305,
    loc: { locX: -44600, locY: -112400, locZ: -240 }
};
assert.strictEqual(
    ListingService.targetMarketTownName(orcState, [{ rank: 'none' }]),
    'Orc Village',
    'nearby no-grade sellers must use the captured Orc Village market'
);
const orcTravel = GoalExecutor.beginMarketTravel(orcState, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, 1000);
assert.strictEqual(orcTravel.stats.travel.townName, 'Orc Village', 'Orc Village sellers must travel to their local market instead of falling back to Giran');
const orcStall = ShopPlaces.take('Orc Village', 'test:orcStall');
assert(ShopPlaces.isStallArea('Orc Village', orcStall), 'Orc Village no-grade listings must remain inside the captured trading square');

const dwarvenState = {
    ...noGradeState,
    characterId: 306,
    loc: { locX: 115440, locY: -178580, locZ: -920 }
};
assert.strictEqual(
    ListingService.targetMarketTownName(dwarvenState, [{ rank: 'none' }]),
    'Dwarven Village',
    'nearby no-grade sellers must use the captured Dwarven Village market'
);
const dwarvenTravel = GoalExecutor.beginMarketTravel(dwarvenState, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, 1000);
assert.strictEqual(dwarvenTravel.stats.travel.townName, 'Dwarven Village', 'Dwarven Village sellers must travel to their local market instead of falling back to Giran');
const dwarvenStall = ShopPlaces.take('Dwarven Village', 'test:dwarvenStall');
assert(ShopPlaces.isStallArea('Dwarven Village', dwarvenStall), 'Dwarven Village no-grade listings must remain inside the captured trading square');

const originalMigrateLegacyMarketTowns = PopulationService.migrateLegacyMarketTowns;
const originalMigrationRunning = PopulationService.marketTownMigrationRunning;
const originalNextMigrationAt = PopulationService.nextMarketTownMigrationAt;
const originalExpireStaleMarketStores = PopulationService.expireStaleMarketStores;
const originalExpiryRunning = PopulationService.marketExpiryCleanupRunning;
const originalNextExpiryAt = PopulationService.nextMarketExpiryCleanupAt;
let migrationCalls = 0;
let expiryCalls = 0;
PopulationService.migrateLegacyMarketTowns = () => {
    migrationCalls++;
    return Promise.resolve([]);
};
PopulationService.marketTownMigrationRunning = false;
PopulationService.nextMarketTownMigrationAt = 0;
PopulationService.expireStaleMarketStores = () => {
    expiryCalls++;
    return Promise.resolve([]);
};
PopulationService.marketExpiryCleanupRunning = false;
PopulationService.nextMarketExpiryCleanupAt = 0;
Promise.resolve()
    .then(() => PopulationService.maybeMigrateLegacyMarketTowns(1000))
    .then(() => PopulationService.maybeMigrateLegacyMarketTowns(1001))
    .then(() => PopulationService.maybeMigrateLegacyMarketTowns(11000))
    .then(() => PopulationService.maybeExpireStaleMarketStores(1000))
    .then(() => PopulationService.maybeExpireStaleMarketStores(1001))
    .then(() => PopulationService.maybeExpireStaleMarketStores(11000))
    .then(() => {
        assert.strictEqual(migrationCalls, 2, 'the post-resolve migration fallback must run initially and then respect its cadence');
        assert.strictEqual(expiryCalls, 2, 'the post-resolve expiry cleanup must run initially and then respect its cadence');
        console.log('Bot market town routing checks passed');
    })
    .catch((err) => {
        console.error(err);
        process.exitCode = 1;
    })
    .finally(() => {
        PopulationService.migrateLegacyMarketTowns = originalMigrateLegacyMarketTowns;
        PopulationService.marketTownMigrationRunning = originalMigrationRunning;
        PopulationService.nextMarketTownMigrationAt = originalNextMigrationAt;
        PopulationService.expireStaleMarketStores = originalExpireStaleMarketStores;
        PopulationService.marketExpiryCleanupRunning = originalExpiryRunning;
        PopulationService.nextMarketExpiryCleanupAt = originalNextExpiryAt;
    });
