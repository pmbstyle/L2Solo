const assert = require('assert');

require('../src/Global');
invoke('GameServer/DataCache').init();

const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const GearPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const MarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
const Warehouse = invoke('GameServer/Bot/Economy/BotWarehouseService');
const originalWarehouseRelease = Warehouse.releaseCold;
const GoalService = invoke('GameServer/Bot/Goals/GoalService');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const GlobalChat = invoke('GameServer/Bot/Population/BotGlobalChat');
const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
const Decision = require('../src/GameServer/Bot/Population/ColdEconomyDecision');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');
const Selection = invoke('GameServer/Bot/AI/GearPlanSelection');
const originalSelect = Selection.selectAcquisitionPlan;

const originals = {
    ensure: SpotProfiles.ensure,
    findForState: SpotProfiles.findForState,
    findCurrentSpot: SpotService.findCurrentSpot,
    arrivalPointForState: SpotService.arrivalPointForState,
    planFor: GearPlanner.planFor,
    cachedState: LifeState.cachedState,
    applyResolve: LifeState.applyResolve,
    upsertState: LifeState.upsertState,
    resolveListing: ListingService.resolve,
    tryPurchase: MarketService.tryPurchase,
    current: GoalService.current,
    review: GoalService.review,
    recordMany: LifeEvents.recordMany,
    globalAnnounce: GlobalChat.maybeAnnounce
};

const oldSpot = { id: 'old_ground', name: 'Old Ground', center: { locX: 10, locY: 20, locZ: 30 } };
const newSpot = { id: 'new_ground', name: 'New Ground', center: { locX: 9000, locY: 9000, locZ: 30 } };

function hunter(characterId, stats = {}) {
    return {
        characterId,
        name: `CommandHunter${characterId}`,
        phase: 'cold',
        activity: 'hunting',
        level: 40,
        adena: 1000,
        spotId: oldSpot.id,
        currentRegion: oldSpot.name,
        loc: { ...oldSpot.center },
        inventory: {},
        vitals: { hp: 1000, maxHp: 1000, mp: 600, maxMp: 600 },
        timing: { lastResolvedAt: Date.now() - 30000 },
        stats
    };
}

// The worker fought at its own spot; its patch carries no travel key.
const workerFight = () => ({
    patch: { activity: 'hunting', spotId: oldSpot.id, loc: { ...oldSpot.center }, stats: {} },
    events: [],
    materialize: { exp: 100, sp: 0, adena: 50, items: [] },
    nextResolveAt: Date.now() + 30000,
    debug: { fights: 2, wins: 2 }
});

async function run() {
    // Main's own spot search prefers another ground (e.g. a new gear source).
    SpotProfiles.ensure = () => [oldSpot, newSpot];
    SpotProfiles.findForState = () => newSpot;
    SpotService.findCurrentSpot = () => oldSpot;
    SpotService.arrivalPointForState = (value, spot) => ({ ...spot.center });
    GearPlanner.planFor = () => ({ status: 'complete', strategy: 'none', grade: 'none' });
    LifeState.cachedState = () => null;
    Selection.selectAcquisitionPlan = () => { throw Error('main command wish build'); };
    const applied = [];
    LifeState.applyResolve = (value, result) => {
        applied.push(value);
        return Promise.resolve({ ...value, activity: result.patch.activity, spotId: result.patch.spotId,
            loc: result.patch.loc, stats: { ...value.stats, ...result.patch.stats } });
    };
    LifeState.upsertState = (value) => Promise.resolve(value);
    ListingService.resolve = (value) => Promise.resolve({ state: value, closed: false });
    MarketService.tryPurchase = (value) => Promise.resolve({ state: value, purchased: false });
    GoalService.current = () => Promise.resolve(null);
    GoalService.review = () => Promise.resolve(null);
    LifeEvents.recordMany = () => Promise.resolve(null);
    GlobalChat.maybeAnnounce = () => null;

    // The worker's context carries the coordinator's choice: no trip, the
    // bot fights on its old ground.
    const commanded = await PopulationService.resolveColdState(hunter(7401),
        { precomputedResult: workerFight(), context: { spot: oldSpot, route: null } });
    assert.strictEqual(commanded.ok, true);
    assert.strictEqual(applied.length, 1, 'the worker fight is applied');
    assert.notStrictEqual(applied[0].activity, 'traveling', 'main begins no hunting trip under a worker result');
    assert.strictEqual(applied[0].stats.travel, undefined);
    assert.strictEqual(commanded.state.activity, 'hunting');
    assert.strictEqual(commanded.state.stats.travel, undefined, 'no trip object is left on a hunting bot');

    // A worker command sends the full packet and holds its materials while
    // the town/market tail changes timestamps and other native state fields.
    const packet = { wishFocus: ['power:391', 1], dormantWishes: [], money: [30000, .00001, 1000, 30000], decisionSeq: 29, activityLeaf: 173 };
    const commandState = hunter(7405, { equipmentPlan: { status: 'complete', strategy: 'none' } });
    const commandDecision = Decision.capture({ projection: { values: new Map() }, network: { activity: null,
        queue: [{ object: { materials: [{ selfId: 1864, amount: 2 }] } }] } }, commandState);
    let passedPacket, tailReads = 0;
    LifeState.applyResolve = async (value, result, options) => {
        passedPacket = options.statsPacket;
        return { ...value, activity: result.patch.activity, updatedAt: 5000,
            stats: { ...value.stats, classId: 2 } };
    };
    ListingService.resolve = async value => {
        assert(Coordinator.economyDecisions.decided(value), 'hold remains readable after commit changed its key');
        assert.deepStrictEqual(invoke('GameServer/Bot/Economy/ColdSafeEnchantService').warehouseRequests(value,
            [{ selfId: 1864, amount: 9 }]), [{ selfId: 1864, amount: 2, reason: 'craft' }]);
        tailReads++;
        return { state: value, closed: false };
    };
    const request = { precomputedResult: workerFight(), context: { spot: oldSpot, route: null },
        precomputedPlan: { previousPlan: commandState.stats.equipmentPlan, acquisitionPlan: commandState.stats.equipmentPlan,
            statsPacket: packet, economyDecision: commandDecision } };
    assert.strictEqual((await PopulationService.resolveColdState(commandState, request)).ok, true);
    assert.deepStrictEqual(passedPacket, packet);
    assert.strictEqual(tailReads, 1);
    assert.strictEqual(Coordinator.economyDecisions.decided(commandState), null, 'finally releases and keeps stale record');
    assert.strictEqual(Coordinator.economyDecisions.byId.get(7405).stale, true);
    ListingService.resolve = async () => { throw Error('command tail failure'); };
    await assert.rejects(PopulationService.resolveColdState(commandState, request), /command tail failure/);
    assert.strictEqual(Coordinator.economyDecisions.byId.get(7405).held, false, 'finally releases on a rejected tail');
    ListingService.resolve = value => Promise.resolve({ state: value, closed: false });
    LifeState.applyResolve = (value, result) => { applied.push(value); return Promise.resolve({ ...value,
        activity: result.patch.activity, spotId: result.patch.spotId, loc: result.patch.loc,
        stats: { ...value.stats, ...result.patch.stats } }); };
    const prior = { status: 'complete', strategy: 'none', target: { selfId: 391 } };
    const deferredBefore = Number(PopulationService.planDeferred || 0);
    const deferred = await PopulationService.resolveColdState(hunter(7406, { equipmentPlan: prior }),
        { precomputedResult: workerFight(), context: { spot: oldSpot, route: null } });
    assert.strictEqual(deferred.state.stats.equipmentPlan, prior, 'no worker plan keeps previous plan');
    assert.strictEqual(PopulationService.planDeferred, deferredBefore + 1);
    Coordinator.economyDecisions.forget(7405);

    const visitOrder = [];
    Warehouse.releaseCold = async (value, options) => {
        assert.strictEqual(options.inTown, true);
        visitOrder.push('warehouse'); return { state: value, released: false };
    };
    ListingService.resolve = async value => { visitOrder.push('listings'); return { state: value, closed: false }; };
    const town = { ...hunter(7420), activity: 'shopping', currentRegion: 'Giran',
        loc: { locX: 83396, locY: 147904, locZ: -3400 } };
    const townResult = { ...workerFight(), patch: { activity: 'shopping', loc: town.loc, stats: {} } };
    assert.strictEqual((await PopulationService.resolveColdState(town,
        { precomputedResult: townResult, context: { spot: oldSpot, route: null } })).ok, true);
    assert.deepStrictEqual(visitOrder, ['warehouse', 'listings'], 'one town release precedes listing');
    visitOrder.length = 0;
    await PopulationService.resolveColdState(hunter(7421),
        { precomputedResult: workerFight(), context: { spot: oldSpot, route: null } });
    assert.deepStrictEqual(visitOrder, ['listings'], 'field command never releases the warehouse');
    Warehouse.releaseCold = originalWarehouseRelease;
    ListingService.resolve = value => Promise.resolve({ state: value, closed: false });

    // Without a worker result main still starts and resolves the trip itself.
    applied.length = 0;
    const unworked = await PopulationService.resolveColdState(hunter(7402));
    assert.strictEqual(unworked.ok, true);
    assert.strictEqual(applied[0].activity, 'traveling');
    assert.strictEqual(applied[0].stats.travel.spotId, newSpot.id);

    // Bots already stranded: the next resolve drops the leftover trip; a trip
    // in progress or started by the resolve is kept.
    invoke('GameServer/DataCache').init();
    const profile = { classId: 0, classProgressionLevel: 40, classProgressionClassId: 0,
        coldCombat: { version: 1, classId: 0, base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25 },
            equipment: { weaponKind: 'Weapon.Sword', pAtk: 80, pAtkRnd: 0, mAtk: 40, atkSpd: 379, critical: 0,
                accur: 100, pDef: 120, mDef: 50, evasion: 0, bonusMp: 0, shieldPDef: 0 }, skills: [], effects: [] } };
    const project = { persist: false, timestamp: Date.now(), projectClassProgression: true };
    const trip = { from: { ...oldSpot.center }, to: { ...newSpot.center }, startedAt: Date.now() - 3600000,
        arrivalAt: Date.now() - 3570000, spotId: newSpot.id, arrivalActivity: 'hunting', reason: 'equipment_source_replan' };
    const fightWith = (activity, stats = {}) => ({ ...workerFight(), patch: { activity, stats } });
    for (const activity of ['hunting', 'resting']) {
        const stranded = { ...hunter(7410), activity, stats: { ...profile, travel: trip } };
        const repaired = await LifeState.prepareResolve(stranded, fightWith(activity, { travel: trip }), project);
        assert.strictEqual(repaired.stats.travel, null, `a ${activity} bot sheds a leftover trip`);
    }
    const onTheWay = { ...hunter(7411), activity: 'traveling', stats: { ...profile, travel: trip } };
    assert.deepStrictEqual((await LifeState.prepareResolve(onTheWay, fightWith('traveling', { travel: trip }), project))
        .stats.travel, trip, 'a bot on its way keeps its trip');
    assert.deepStrictEqual((await LifeState.prepareResolve(hunter(7412, profile), fightWith('traveling', { travel: trip }), project))
        .stats.travel, trip, 'a trip the resolve starts is kept');

    console.log('Cold command hunting travel checks passed');
}

run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Object.assign(SpotProfiles, { ensure: originals.ensure, findForState: originals.findForState });
    Object.assign(SpotService, { findCurrentSpot: originals.findCurrentSpot, arrivalPointForState: originals.arrivalPointForState });
    GearPlanner.planFor = originals.planFor;
    Selection.selectAcquisitionPlan = originalSelect;
    Object.assign(LifeState, { cachedState: originals.cachedState, applyResolve: originals.applyResolve, upsertState: originals.upsertState });
    Warehouse.releaseCold = originalWarehouseRelease;
    ListingService.resolve = originals.resolveListing;
    MarketService.tryPurchase = originals.tryPurchase;
    Object.assign(GoalService, { current: originals.current, review: originals.review });
    LifeEvents.recordMany = originals.recordMany;
    GlobalChat.maybeAnnounce = originals.globalAnnounce;
});
