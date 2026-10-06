const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const BotAfkMarketService = invoke('GameServer/Bot/Economy/BotAfkMarketService');

DataCache.init();

// Live pattern: the NPC kit plan picks an affordable item, the bot posts a
// WTB for it and the bid moves into the order's escrow. The next plan saw
// only the wallet, dropped the target, the order was withdrawn with its
// escrow refunded, and the same target came back: one order every ~6 min.
// The bot holds a usable weapon: an unarmed bot would bridge a weapon first.
const weapon = invoke('GameServer/Bot/AI/BotGear').planFor({ classId: 1, level: 30 }).items.find((item) => Number(item.slot) === 7);
const state = {
    characterId: 7, phase: 'cold', level: 30, activity: 'hunting',
    inventory: { [weapon.selfId]: { selfId: Number(weapon.selfId), amount: 1, equippedCount: 1, equipped: 1 } },
    stats: { classId: 1, build: { grade: 'd', classId: 1, level: 30 }, equipment: [] }
};
const posting = GearAcquisitionPlanner.staticNpcUpgradePlan({ ...state, adena: 120000 });
assert.strictEqual(posting?.strategy, 'market', 'the fixture must plan an NPC-kit purchase');
const price = Number(posting.market.price);
const target = posting.target.name;
assert(price > 0 && price < 120000, 'the fixture target must be affordable before posting');

const afterPosting = { ...state, adena: 120000 - price };
assert.notStrictEqual(GearAcquisitionPlanner.staticNpcUpgradePlan(afterPosting)?.target?.name, target,
    'the wallet alone no longer covers the target once its bid sits in escrow');
assert.strictEqual(GearAcquisitionPlanner.staticNpcUpgradePlan(afterPosting, { buyOrderEscrow: price })?.target?.name,
    target, 'the bot\'s own buy-order escrow keeps the target funded');
assert.strictEqual(GearAcquisitionPlanner.planFor(afterPosting, { spots: [], buyOrderEscrow: price })?.target?.name,
    target, 'the full plan keeps the target while its order is open');

// The reserve is kept from the same budget: posting an order must not free
// spendable Adena. At 100k the reserve (10%) holds the bot on Iron Plate
// Gaiters; a reserve from the wallet alone let the posted order switch the
// plan to the Ring Mail Breastplate that the reserve forbids.
const kit = GearAcquisitionPlanner.staticNpcUpgradePlan({ ...state, adena: 100000 });
const kitPrice = Number(kit?.market?.price);
assert(kitPrice > 0, 'the fixture must plan an NPC-kit purchase at 100k');
const kitAfterPosting = GearAcquisitionPlanner.staticNpcUpgradePlan({ ...state, adena: 100000 - kitPrice },
    { buyOrderEscrow: kitPrice });
assert.strictEqual(kitAfterPosting?.target?.name, kit.target.name, 'posting the order keeps the target');
assert.strictEqual(kitAfterPosting.market.reserve, kit.market.reserve, 'posting the order keeps the reserve');
assert.strictEqual(GearAcquisitionPlanner.operationalAdenaReserve({ ...state, adena: 100000 - kitPrice },
    kitPrice), GearAcquisitionPlanner.operationalAdenaReserve({ ...state, adena: 100000 }));

const originalProjection = AfkTrade.ownerRecords;
try {
    AfkTrade.ownerRecords = () => [{ kind: 'buy_ad', storeType: AfkTrade.BUY, escrowAdena: price, lines: [] }];
    assert.strictEqual(BotAfkMarketService.buyOrderEscrow(7), price, 'a buy order reports its escrow');
    AfkTrade.ownerRecords = () => [{ kind: 'shop', storeType: AfkTrade.SELL, escrowAdena: price, lines: [] }];
    assert.strictEqual(BotAfkMarketService.buyOrderEscrow(7), 0, 'a sell shop holds no purchase budget');
} finally {
    AfkTrade.ownerRecords = originalProjection;
}

// Every other funding check counts the same escrow: the funded re-price, the
// resume after a rest, and the worker's lifecycle routing.
const reserve = Number(posting.market.reserve);
const walletAfterBid = { ...state, adena: reserve };
assert.strictEqual(GearAcquisitionPlanner.fundedMarketPlanForTarget(walletAfterBid, posting.target.selfId), null);
assert(GearAcquisitionPlanner.fundedMarketPlanForTarget({ ...state, adena: 120000 - price }, posting.target.selfId,
    { buyOrderEscrow: price }), 'the funded re-price counts the escrow');
const weaponState = { ...walletAfterBid, stats: { ...state.stats, equipmentPlan: { ...posting, target: { ...posting.target, slot: 7 } } } };
const { lifecycleKind } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
assert.notStrictEqual(lifecycleKind(weaponState), 'command');
assert.strictEqual(lifecycleKind(weaponState, { buyOrderEscrow: price }), 'command', 'the worker routing counts the escrow');
// A plan buying from another bot keeps its WTB (it buys remotely): its escrow
// does not send the bot to town.
const botPlanState = { ...weaponState, stats: { ...weaponState.stats, equipmentPlan: { ...weaponState.stats.equipmentPlan,
    market: { ...posting.market, sourceType: 'afk_bot_store' } } } };
assert.notStrictEqual(lifecycleKind(botPlanState, { buyOrderEscrow: price }), 'command', 'a kept order is no trip');
const PopulationServiceForResume = invoke('GameServer/Bot/Population/PopulationService');
const savedProjection = AfkTrade.ownerRecords;
try {
    assert.strictEqual(PopulationServiceForResume.canResumeAffordableMarketPlan(weaponState), false);
    AfkTrade.ownerRecords = () => [{ kind: 'buy_ad', storeType: AfkTrade.BUY, escrowAdena: price, lines: [] }];
    assert.strictEqual(PopulationServiceForResume.canResumeAffordableMarketPlan(weaponState), true,
        'the resume after a rest counts the escrow');
    assert.strictEqual(PopulationServiceForResume.canResumeAffordableMarketPlan(botPlanState), false,
        'a kept order is no reason to leave for town');
} finally {
    AfkTrade.ownerRecords = savedProjection;
}

// A dual-sword plan buying its missing blade keeps the same reserve once its
// bid sits in escrow (the blade route reads the escrow from the plan options).
const DualSwords = invoke('GameServer/Items/C4DualSwordCombinations');
const saberRevolution = DualSwords.resolveByProductId(2523);
const dualState = (adena) => ({ characterId: 42, name: 'DualProbe', phase: 'cold', level: 40, adena,
    activity: 'hunting', currentRegion: 'Giran', loc: { locX: 83000, locY: 148000, locZ: -3400 },
    inventory: { 123: { selfId: 123, name: 'Saber', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [7], slot: 7, rank: 'd', kind: 'Weapon.Sword' } },
    stats: { classId: 2, role: 'dps', forcedRecipeId: saberRevolution.recipeId } });
const bladeOptions = { recipeId: saberRevolution.recipeId, spots: [],
    findMarketOffer: (item) => Number(item.selfId) === 129 ? { selfId: 129, price: 100000, town: 'Giran', sourceType: 'npc' } : null };
const bladeBefore = GearAcquisitionPlanner.planFor(dualState(5000000), bladeOptions);
const bladeAfter = GearAcquisitionPlanner.planFor(dualState(4000000), { ...bladeOptions, buyOrderEscrow: 1000000 });
assert.strictEqual(bladeBefore?.target?.selfId, 129, 'fixture: the plan buys the missing blade');
assert.strictEqual(bladeAfter.market.reserve, bladeBefore.market.reserve, 'the blade plan keeps its reserve after posting');

// The shared party refresh planner receives the member's own escrow (the worker's party review is checked in test_cold_worker_buy_order_escrow).
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const PartyState = invoke('GameServer/Bot/Population/BackgroundPartyState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');

(async () => {
    const saved = {
        planFor: GearAcquisitionPlanner.planFor,
        replacementPlanFor: GearAcquisitionPlanner.replacementPlanFor,
        cachedStatesForParties: LifeState.cachedStatesForParties,
        upsertState: LifeState.upsertState,
        createOrUpdate: PartyState.createOrUpdate,
        ensure: SpotProfiles.ensure,
        currentOccupancy: SpotProfiles.currentOccupancy,
        ownerRecords: AfkTrade.ownerRecords,
        cachedState: LifeState.cachedState,
        npcEquipmentBridgePlan: GearAcquisitionPlanner.npcEquipmentBridgePlan,
        replanContextFor: GearAcquisitionPlanner.replanContextFor,
        fundedMarketPlanForTarget: GearAcquisitionPlanner.fundedMarketPlanForTarget,
        bestSourceForPlan: GearAcquisitionPlanner.bestSourceForPlan
    };
    try {
        const plannedWith = [];
        const memberPlan = posting;
        GearAcquisitionPlanner.planFor = (_state, options) => { plannedWith.push(options.buyOrderEscrow); return memberPlan; };
        GearAcquisitionPlanner.replacementPlanFor = (_state, _previous, _spots, options) => {
            plannedWith.push(options.buyOrderEscrow); return memberPlan;
        };
        AfkTrade.ownerRecords = () => [{ kind: 'buy_ad', storeType: AfkTrade.BUY, escrowAdena: price, lines: [] }];
        SpotProfiles.ensure = () => [];
        SpotProfiles.currentOccupancy = () => ({});
        PartyState.createOrUpdate = async (party) => party;
        LifeState.upsertState = async (state) => state;
        const member = (characterId, equipmentPlan) => ({ ...afterPosting, characterId, name: `Member${characterId}`,
            partyId: 'bgp-escrow', stats: { ...afterPosting.stats, equipmentPlan } });
        LifeState.cachedStatesForParties = () => Promise.resolve(new Map([['bgp-escrow', [
            member(7, memberPlan),
            member(8, { status: 'blocked', strategy: 'direct_drop', target: { selfId: 1 } })
        ]]]));
        const Economy = invoke('GameServer/Bot/Economy/EconomyContext'), originalContext = Economy.forState;
        Economy.forState = state => ({ inputKey: 'escrow-fixture', network: {
            queue: [{ key: 'gear', funded: true, object: { slot: 7, itemId: state.stats.equipmentPlan.target.selfId } }],
            focus: ['gear'], activity: { rootKey: 'gear', activity: 'shopping', key: 'buy-gear' } } });
        try {
            for (const state of [member(7, memberPlan), member(8, { status: 'blocked', strategy: 'direct_drop', target: { selfId: 1 } })]) {
                require('../src/GameServer/Bot/Population/PartyRequirementRefresh').plan(state, {
                    spots: [], occupancy: {}, timestamp: Date.now(), planningOptions: { buyOrderEscrow: price } });
            }
        } finally { Economy.forState = originalContext; }
        assert.deepStrictEqual(plannedWith, [price, price], 'the party refresh plans both paths with the member\'s escrow');

        // Without a worker plan, the main thread plans a solo bot itself:
        // the bridge plan, the open party request check and the plan.
        const soloOptions = [];
        const sentinel = new Error('planned');
        LifeState.cachedState = () => null;
        GearAcquisitionPlanner.npcEquipmentBridgePlan = (_state, options) => { soloOptions.push(['bridge', options?.buyOrderEscrow]); return null; };
        GearAcquisitionPlanner.planFor = (_state, options) => { soloOptions.push(['plan', options.buyOrderEscrow]); throw sentinel; };
        await assert.rejects(async () => PopulationService.resolveColdState({ ...afterPosting, name: 'Solo7' }),
            (error) => error === sentinel);
        assert.deepStrictEqual(soloOptions, [['plan', price]], 'the armed solo fixture counts its escrow without a weapon bridge');
        soloOptions.length = 0;
        GearAcquisitionPlanner.replanContextFor = () => ({ routeCurrent: true, failure: null });
        GearAcquisitionPlanner.fundedMarketPlanForTarget = (_state, _target, options) => {
            soloOptions.push(['funded', options?.buyOrderEscrow]); throw sentinel;
        };
        // The plan selection keeps an open party request only for a route
        // whose source is still available.
        GearAcquisitionPlanner.bestSourceForPlan = () => ({ spotId: 'x', npcId: 1 });
        const waiting = { ...afterPosting, name: 'Solo7', stats: { ...afterPosting.stats,
            equipmentPlan: { ...posting, strategy: 'direct_drop', next: { spotId: 'x', npcId: 1 } },
            partyRequest: { status: 'open', reviewAt: Date.now() + 600000 } } };
        await assert.rejects(async () => PopulationService.resolveColdState(waiting), (error) => error === sentinel);
        assert.deepStrictEqual(soloOptions, [['funded', price]],
            'keeping an open party request checks the funded purchase with the escrow');
    } finally {
        GearAcquisitionPlanner.planFor = saved.planFor;
        GearAcquisitionPlanner.replacementPlanFor = saved.replacementPlanFor;
        LifeState.cachedStatesForParties = saved.cachedStatesForParties;
        LifeState.upsertState = saved.upsertState;
        PartyState.createOrUpdate = saved.createOrUpdate;
        SpotProfiles.ensure = saved.ensure;
        SpotProfiles.currentOccupancy = saved.currentOccupancy;
        AfkTrade.ownerRecords = saved.ownerRecords;
        LifeState.cachedState = saved.cachedState;
        GearAcquisitionPlanner.npcEquipmentBridgePlan = saved.npcEquipmentBridgePlan;
        GearAcquisitionPlanner.replanContextFor = saved.replanContextFor;
        GearAcquisitionPlanner.fundedMarketPlanForTarget = saved.fundedMarketPlanForTarget;
        GearAcquisitionPlanner.bestSourceForPlan = saved.bestSourceForPlan;
    }

    console.log('Bot plan buy-order escrow checks passed');
    process.exit(0);
})().catch((error) => { console.error(error); process.exit(1); });
