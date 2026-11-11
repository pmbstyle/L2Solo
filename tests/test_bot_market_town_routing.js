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

// The town a seller standing in its sale town sells in: there, with no trip across the
// town and no second arrival (ColdTrip.townPlan's here).
const townOf = next => {
    assert(next.activity === 'shopping' && !next.stats.travel && next.stats.townVisit?.town === next.currentRegion,
        'a seller standing in its sale town sells there: no trip, no second arrival');
    return next.currentRegion;
};
assert.strictEqual(townOf(travel), 'Gludio', 'D-grade sellers must use the Gludio market instead of Giran');
// Outside the town the same seller travels there and shops on arrival.
const fieldTravel = GoalExecutor.beginMarketTravel({ ...state, loc: { locX: -4736, locY: 122816, locZ: -3114 } }, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, 1000);
assert.strictEqual(fieldTravel.activity, 'traveling', 'a seller outside its sale town travels there');
assert.strictEqual(fieldTravel.stats.travel.townName, 'Gludio');
assert.strictEqual(fieldTravel.stats.travel.arrivalActivity, 'shopping');
// A bot with karma enters no town but Floran (ColdTrip.townPlan), though it stands in another: it walks there.
const karmaTravel = GoalExecutor.beginMarketTravel({ ...state, stats: { karma: 1000 } }, {
    type: 'sell_inventory',
    plan: { expectedBenefit: 'market_sale_inventory' }
}, 1000);
assert.deepStrictEqual([karmaTravel.activity, karmaTravel.stats.travel.townName, karmaTravel.stats.travel.method],
    ['traveling', 'Floran Village', 'walk'], 'a seller with karma standing in Gludio walks to Floran to sell');
const gearGoal = { type: 'upgrade_gear', status: 'active', target: { itemId: dWeapon.selfId, amount: 1 },
    plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Gludio' } };
assert.strictEqual(GoalExecutor.beginMarketTravel(state, gearGoal, 1000).activity, 'shopping', 'a buyer standing in Gludio shops there');
assert.strictEqual(GoalExecutor.beginMarketTravel({ ...state, stats: { karma: 1000 } }, gearGoal, 1000), null,
    'a buyer with karma standing in Gludio does not shop there');
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
// The legacy market-town migration of physical stalls is gone with the
// stalls: the old world's bot stores closed once and relist.
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
assert.strictEqual(townOf(dionTravel), 'Dion', 'D-grade overflow must use the Dion market instead of overfilling Gludio');
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
assert.strictEqual(townOf(orcTravel), 'Orc Village', 'Orc Village sellers must travel to their local market instead of falling back to Giran');
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
assert.strictEqual(townOf(dwarvenTravel), 'Dwarven Village', 'Dwarven Village sellers must travel to their local market instead of falling back to Giran');
const dwarvenStall = ShopPlaces.take('Dwarven Village', 'test:dwarvenStall');
assert(ShopPlaces.isStallArea('Dwarven Village', dwarvenStall), 'Dwarven Village no-grade listings must remain inside the captured trading square');

// The stall migration and stall expiry timers are gone with the stalls
// with the board: its records expire in the board's own queue.
assert.strictEqual(PopulationService.maybeMigrateLegacyMarketTowns, undefined);
assert.strictEqual(PopulationService.maybeExpireStaleMarketStores, undefined);
console.log('Bot market town routing checks passed');
