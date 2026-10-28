const assert = require('assert');

require('../src/Global');

const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const DataCache = invoke('GameServer/DataCache');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const PartyRequestPlanner = invoke('GameServer/Bot/Population/PartyRequestPlanner');
const ColdNpcPlanningCatalog = require('../src/GameServer/Bot/Population/ColdNpcPlanningCatalog');
const BotRoute = require('../src/GameServer/Bot/Population/BotRoute');
const {
    ColdSimulationCoordinator,
    npcPlanningCatalogRows
} = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');

DataCache.init();

const originalFindForState = SpotProfiles.findForState;
const originalFindCurrentSpot = SpotService.findCurrentSpot;
const originalArrivalPointForState = SpotService.arrivalPointForState;
const originalSafeFallbackForPlan = GearAcquisitionPlanner.safeFallbackForPlan;
const originalCachedState = LifeState.cachedState;
const originalEnsure = SpotProfiles.ensure;
// One search and its trip over the catalog `spots` (the route a far bot's
// step or a party run starts).
const routeFor = (state, currentSpot, party, members, spots = [], timestamp = Date.now()) =>
    BotRoute.route(state, currentSpot, party, members || [], { spots, timestamp });

try {
    const npcCatalogRows = npcPlanningCatalogRows();
    const npcCatalog = ColdNpcPlanningCatalog.createLookup(npcCatalogRows);
    assert(Object.isFrozen(npcCatalogRows), 'the coordinator NPC catalog snapshot must be immutable');
    assert(npcCatalogRows.length > 0 && npcCatalog.itemCount > 0,
        'the cold worker must receive concrete low-tier NPC equipment offers');
    assert(Buffer.byteLength(JSON.stringify(npcCatalogRows)) < 256 * 1024,
        'the compact NPC equipment catalog must fit within the bounded worker transport');

    const npcPlanFor = (level) => GearAcquisitionPlanner.planFor({
        characterId: 7000000 + level,
        level,
        adena: 500,
        currentRegion: 'Talking Island',
        stats: { classId: 0, role: 'dps' },
        inventory: { 57: { selfId: 57, amount: 500 } }
    }, {
        spots: [],
        ...npcCatalog.plannerOptions
    });
    const noGradeNpcPlan = npcPlanFor(10);
    assert.strictEqual(noGradeNpcPlan.strategy, 'market',
        'a cold no-grade bot must plan an NPC purchase instead of direct-drop farming');
    assert.strictEqual(noGradeNpcPlan.market.sourceType, 'npc');
    assert.strictEqual(
        String(DataCache.items.find((item) => Number(item.selfId) === Number(noGradeNpcPlan.target.selfId))?.etc?.rank),
        'none'
    );

    const dGradeNpcPlan = npcPlanFor(20);
    assert.strictEqual(dGradeNpcPlan.strategy, 'market',
        'a cold D-grade bot must receive the ordinary NPC bridge plan');
    assert.strictEqual(dGradeNpcPlan.market.sourceType, 'npc');
    assert.strictEqual(
        String(DataCache.items.find((item) => Number(item.selfId) === Number(dGradeNpcPlan.target.selfId))?.etc?.rank),
        'd'
    );
    assert.notStrictEqual(dGradeNpcPlan.market.town, 'Talking Island',
        'a D-grade bot in Talking Island must route to a city that actually sells its target');
    assert(MarketOpportunity.npcOffers(dGradeNpcPlan.target.selfId, dGradeNpcPlan.market.town)
        .some((offer) => offer.available), 'the selected D-grade destination must expose the persisted NPC offer');

    const currentSpot = { id: 'starter-field', name: 'Starter fields' };
    const targetSpot = {
        id: 'mid-level-field',
        name: 'Mid-level fields',
        minLevel: 16,
        maxLevel: 22,
        avgLevel: 19,
        density: 8,
        levelCounts: { 16: 2, 18: 3, 20: 2, 22: 1 },
        capacity: 2
    };
    const destinationFor = (state) => ({
        locX: 125000 + Number(state.characterId || 0),
        locY: -176000,
        locZ: -1000
    });
    SpotService.findCurrentSpot = () => currentSpot;
    SpotService.arrivalPointForState = destinationFor;
    const routeTargetForState = (state, options) => {
        if (options?.mode === 'party') {
            assert.strictEqual(state.stats.routeMode, 'party');
            assert(state.party?.partyId);
        }
        return targetSpot;
    };
    SpotProfiles.findForState = routeTargetForState;

    const coordinator = new ColdSimulationCoordinator();
    const solo = routeFor({
        characterId: 1,
        phase: 'cold',
        activity: 'hunting',
        level: 16,
        spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: {}
    }, currentSpot, null, [], [currentSpot, targetSpot]);
    assert.strictEqual(solo.mode, 'solo');
    assert.strictEqual(solo.spotId, targetSpot.id);
    assert.deepStrictEqual(solo.destinations['1'], destinationFor({ characterId: 1 }));

    // The step's own hunting leaf names the trip when the bot may hunt there;
    // otherwise (raid profile, a spot avoided by its risk marks) the bot's
    // route search decides.
    const leafHunter = { characterId: 9, phase: 'cold', activity: 'hunting', level: 18, spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 }, stats: {} };
    const leafAt = Date.now();
    const wishedTrip = BotRoute.leafChoice(leafHunter, { activity: 'hunting', spotId: targetSpot.id },
        { spots: [currentSpot, targetSpot], timestamp: leafAt });
    assert.strictEqual(wishedTrip?.spotId, targetSpot.id, 'the leaf\'s spot is the trip of its own step');
    assert.strictEqual(BotRoute.record(leafHunter, wishedTrip, null, [],
        { spots: [currentSpot, targetSpot], currentSpot, timestamp: leafAt })?.spotId, targetSpot.id);
    assert.strictEqual(BotRoute.leafChoice(leafHunter, { activity: 'hunting', spotId: 'raid:1' },
        { spots: [currentSpot, { ...targetSpot, id: 'raid:1', raidBoss: true }], timestamp: leafAt }), null,
        'a raid profile is never a solo leaf trip');
    const avoiding = { ...leafHunter, stats: { coldCompetition: { avoid: { spotId: targetSpot.id, untilStep: 10 } } } };
    assert.strictEqual(BotRoute.leafChoice(avoiding, { activity: 'hunting', spotId: targetSpot.id },
        { spots: [currentSpot, targetSpot], timestamp: leafAt }), null, 'an avoided spot is not a leaf trip');
    assert.strictEqual(BotRoute.leafChoice(leafHunter, { activity: 'resting' },
        { spots: [currentSpot, targetSpot], timestamp: leafAt }), null);

    // The kept route (BotRoute.trip on the bot's kernel record): a step that
    // moves none of its inputs walks to the kept spot even when a new search
    // would choose another; a route section, a plan / request field the
    // search reads, or a leaf trip makes the next trip start search again.
    const Sections = invoke('GameServer/Bot/Economy/DecisionSections');
    const otherSpot = { ...targetSpot, id: 'other-field', name: 'Other fields' };
    const keptSpots = [currentSpot, targetSpot, otherSpot];
    const keptHunter = { ...leafHunter, characterId: 10 };
    let searched = targetSpot;
    SpotProfiles.findForState = () => searched;
    const record = { route: null };
    const tripTo = (leaf = null) => BotRoute.trip(record, keptHunter, leaf,
        { spots: keptSpots, currentSpot, timestamp: leafAt })?.spotId;
    const stepDrops = (mask, before, after) => {
        const why = BotRoute.dropReason(mask & Sections.COMPUTED.route, before, after);
        if (why) BotRoute.drop(record, why);
        return why;
    };
    const waitPlan = { status: 'active', strategy: 'direct_drop', partyNeed: 'required', next: { spotId: 'source', npcId: 7 } };
    const openRequest = { status: 'open', priority: 'preferred' };
    const quiet = { plan: waitPlan, request: openRequest };
    // The search's answer flips, so a trip shows whether it searched or kept.
    const flipSearch = () => { searched = searched === targetSpot ? otherSpot : targetSpot; };
    assert.strictEqual(tripTo(), targetSpot.id, 'the first trip start searches');
    flipSearch();
    assert.strictEqual(stepDrops(Sections.sectionMask(['money', 'supply']), quiet, quiet), '');
    assert.strictEqual(tripTo(), targetSpot.id, 'a step that moves no route input keeps its route');
    assert.strictEqual(stepDrops(Sections.sectionMask(['occupation']), quiet, quiet), 'sections');
    assert.strictEqual(tripTo(), otherSpot.id, 'a moved route section searches again');
    flipSearch();
    assert.strictEqual(stepDrops(0, quiet, { ...quiet, plan: { ...waitPlan, next: { spotId: 'new-source', npcId: 7 } } }), 'plan');
    assert.strictEqual(tripTo(), targetSpot.id, 'a new plan destination searches again');
    flipSearch();
    assert.strictEqual(stepDrops(0, quiet, { ...quiet, request: { ...openRequest, status: 'deferred' } }), 'plan',
        'a party request deferred (the party wait starts) drops the route');
    assert.strictEqual(tripTo(), otherSpot.id);
    flipSearch();
    assert.strictEqual(stepDrops(0, quiet, { ...quiet, request: { ...openRequest, priority: 'required' } }), 'plan');
    assert.strictEqual(tripTo(), targetSpot.id);
    flipSearch();
    assert.strictEqual(tripTo({ activity: 'hunting', spotId: otherSpot.id }), otherSpot.id, 'the leaf trip goes first');
    assert.strictEqual(tripTo(), otherSpot.id, 'after a leaf trip the next trip start searches, not the old kept spot');
    const allowSpot = invoke('GameServer/Bot/AI/LevelingRoutes').isSpotAllowedForState;
    try {
        invoke('GameServer/Bot/AI/LevelingRoutes').isSpotAllowedForState = () => true;
        for (const activity of ['shopping', 'crafting', 'selling', 'improving']) {
            assert.strictEqual(tripTo({ activity, itemId: 736, town: 'Oren' }), undefined,
                `a ${activity} decision reaches its executor instead of starting a hunting detour`);
        }
        invoke('GameServer/Bot/AI/LevelingRoutes').isSpotAllowedForState = () => false;
        assert(tripTo({ activity: 'shopping', itemId: 736, town: 'Oren' }),
            'an unsafe-ground evacuation still owns safety before an ordinary purchase');
    } finally { invoke('GameServer/Bot/AI/LevelingRoutes').isSpotAllowedForState = allowSpot; }
    SpotProfiles.findForState = () => { throw Error('search failed'); };
    BotRoute.drop(record, 'test');
    assert.strictEqual(tripTo(), undefined, 'a failed search starts no trip');
    SpotProfiles.findForState = () => targetSpot;
    assert.strictEqual(tripTo(), targetSpot.id, 'a failed search is not kept: the next trip start searches');
    // ROUTE-ROOM-2: the worker's room filter refuses a leaf trip to a full
    // spot other than the bot's own (the search decides); the bot's own spot
    // is never full to it (here it stands elsewhere, displaced from it).
    const roomTrip = (hunter, hasRoom) => BotRoute.trip({ route: null }, hunter,
        { activity: 'hunting', spotId: otherSpot.id },
        { spots: keptSpots, currentSpot, timestamp: leafAt, hasRoom })?.spotId;
    assert.strictEqual(roomTrip(keptHunter, id => id !== otherSpot.id), targetSpot.id,
        'a leaf trip to a full spot is not taken: the search decides');
    assert.strictEqual(roomTrip({ ...keptHunter, spotId: otherSpot.id }, () => false), otherSpot.id,
        'the leaf trip to the bot\'s own spot is taken even when it counts as full');
    // ROUTE-ROOM-3: the kept route obeys the same filter: one to a full spot
    // other than the bot's own is dropped and the search decides; one to the
    // bot's own spot is kept.
    SpotProfiles.findForState = () => otherSpot;
    const keptRoom = (hunter, hasRoom) => {
        const owner = { route: null };
        const walk = (room) => BotRoute.trip(owner, hunter, null,
            { spots: keptSpots, currentSpot, timestamp: leafAt, hasRoom: room })?.spotId;
        assert.strictEqual(walk(null), otherSpot.id, 'fixture: the route is kept on the first search');
        SpotProfiles.findForState = () => targetSpot;
        return walk(hasRoom);
    };
    assert.strictEqual(keptRoom(keptHunter, id => id !== otherSpot.id), targetSpot.id,
        'a kept route to a spot that is full now is dropped: the search decides');
    SpotProfiles.findForState = () => otherSpot;
    assert.strictEqual(keptRoom(keptHunter, () => true), otherSpot.id, 'a kept route to a spot with room is kept');
    SpotProfiles.findForState = () => otherSpot;
    assert.strictEqual(keptRoom({ ...keptHunter, spotId: otherSpot.id }, () => false), otherSpot.id,
        'a kept route to the bot\'s own spot is kept even when it counts as full');
    SpotProfiles.findForState = routeTargetForState;

    const raidSpot = {
        id: 'raid:10103',
        name: 'Sorcerer Isirr',
        raidBoss: true,
        center: { locX: 135872, locY: 94592, locZ: -3735 }
    };
    const raidMembers = [1, 2, 3].map((characterId) => ({
        characterId,
        phase: 'cold',
        activity: 'grouped',
        spotId: raidSpot.id,
        loc: { locX: 135200 + characterId * 20, locY: 94300, locZ: -3700 },
        vitals: { hp: 100, maxHp: 100 },
        stats: {},
        party: { partyId: 'raid-party' }
    }));
    const raidParty = {
        partyId: 'raid-party',
        spotId: raidSpot.id,
        stats: { objective: { sourceKind: 'raid', spotId: raidSpot.id, raidBossTemplateId: 10103 } }
    };
    assert.strictEqual(
        routeFor(raidMembers[0], currentSpot, raidParty, raidMembers, [currentSpot, raidSpot]),
        null,
        'a cold raid party already at its virtual raid spot must not repeat the same 25-second travel'
    );
    // The worker's spot of a bot (SpotService.standingSpot over its catalog):
    // a declared raid profile, else the spot under its position, else its
    // declared spot. The position search answers the field around the raid.
    const fieldSpot = { id: 'raid-field', name: 'Field around the raid' };
    const standingCatalog = [currentSpot, raidSpot, fieldSpot];
    const originalFindCurrentSpot = SpotService.findCurrentSpot;
    SpotService.findCurrentSpot = (loc, spots) => (loc && spots === standingCatalog ? fieldSpot : null);
    try {
        assert.strictEqual(SpotService.standingSpot(raidMembers[0], standingCatalog).id, raidSpot.id,
            'the cold resolver must receive the virtual raid profile instead of its surrounding grid sector');
        assert.strictEqual(SpotService.standingSpot({ ...raidMembers[0], spotId: currentSpot.id }, standingCatalog).id, fieldSpot.id,
            'an ordinary declared spot yields to the spot under the bot');
        assert.strictEqual(SpotService.standingSpot({ ...raidMembers[0], spotId: currentSpot.id, loc: null }, standingCatalog).id,
            currentSpot.id, 'with no spot under the bot its declared spot stands');
    } finally {
        SpotService.findCurrentSpot = originalFindCurrentSpot;
    }

    const retreatAt = Date.now();
    const retreatState = { characterId: 2, phase: 'cold', activity: 'hunting', level: 16,
        spotId: currentSpot.id, loc: { locX: 1, locY: 2, locZ: 3 },
        stats: { coldCompetition: { avoid: { spotId: currentSpot.id, untilStep: 10 } } } };
    SpotProfiles.ensure = () => [currentSpot, targetSpot];
    SpotProfiles.findForState = (state, options) => {
        assert(options.excludedSpotIds.has(currentSpot.id), 'voluntary avoidance reaches the real route selector');
        assert.strictEqual(options.timestamp, retreatAt);
        return targetSpot;
    };
    const retreatRoute = coordinator.competitionActions.retreatRoute([retreatState], null, { spotId: currentSpot.id }, retreatAt);
    assert.strictEqual(retreatRoute.cause, 'competition_avoid');
    assert.strictEqual(retreatRoute.spotId, targetSpot.id);
    assert(!retreatRoute.spotBackoff, 'a social retreat does not invent PvE deaths or escalate their backoff');
    SpotProfiles.findForState = () => null;
    assert.strictEqual(coordinator.competitionActions.retreatRoute([retreatState], null, { spotId: currentSpot.id }, retreatAt), null,
        'no suitable destination means no invented successful retreat');
    SpotProfiles.ensure = originalEnsure;
    SpotProfiles.findForState = routeTargetForState;

    const batchRouteFor = (characterId) => routeFor({
        characterId,
        phase: 'cold',
        activity: 'hunting',
        level: 16,
        spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: {}
    }, currentSpot, null, [], [currentSpot, targetSpot]);
    // No place is held ahead of arrival (ARCH-08-c): every decision of one
    // spot gets the destination; its room is checked when each bot arrives
    // (test_room_at_arrival.js). The spot's capacity is 2.
    assert(batchRouteFor(20), 'the first cold decision routes to the destination');
    assert(batchRouteFor(21), 'the second cold decision routes to the destination');
    assert.strictEqual(batchRouteFor(22)?.spotId, targetSpot.id,
        'a third decision is not refused at planning: the room is checked at arrival');

    // "Was full" marks (the arrival check itself: test_room_at_arrival.js):
    // a chain of them, and the searches they clear.
    const Risk = invoke('GameServer/Bot/Population/SpotRiskPolicy');
    const atStep = (value, stepCount) => ({ ...value, stats: { ...value.stats, stepCount } });
    const markedState = Risk.withCapacityBackoff({
        characterId: 23,
        phase: 'cold',
        activity: 'hunting',
        spotId: targetSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: { equipmentPlan: { status: 'active', strategy: 'direct_drop' } }
    }, targetSpot.id);
    const refusedAt = Risk.stepCount(markedState);
    let chained = markedState;
    for (let index = 1; index < Risk.MAX_BACKOFFS; index += 1) {
        chained = Risk.withCapacityBackoff(atStep(chained, refusedAt + index), `chain_${index}`);
    }
    const chainEnd = refusedAt + Risk.MAX_BACKOFFS - 1;
    assert.strictEqual(Risk.excludedSpotIdsForStates([atStep(chained, chainEnd + 1)]).size, Risk.MAX_BACKOFFS,
        'every spot found full along a chain stays excluded, so the bot can reach a free spot');
    assert.strictEqual(Risk.excludedSpotIdsForStates([atStep(chained, chainEnd + 1 + Risk.CAPACITY_BACKOFF_STEPS)]).size, 0,
        'the whole chain expires one backoff after the last full spot');
    assert.strictEqual(markedState.stats.lastReason, 'route_capacity_full');
    assert.strictEqual(markedState.stats.spotBackoffs, undefined);
    const originalCache = SpotProfiles.cache;
    const savedFind = SpotProfiles.findForState;
    const savedPhysical = SpotService.findCurrentSpot;
    try {
        const free = { ...targetSpot, id: 'free-destination' };
        SpotProfiles.cache = [targetSpot, free];
        SpotProfiles.findForState = originalFindForState;
        SpotService.findCurrentSpot = () => null;
        const rerouted = SpotProfiles.findForState({ ...markedState, level: 16 },
            { timestamp: 3000 });
        assert.strictEqual(rerouted?.id, free.id, 'the next search after a full arrival takes a free alternative');
    } finally {
        SpotProfiles.cache = originalCache;
        SpotProfiles.findForState = savedFind;
        SpotService.findCurrentSpot = savedPhysical;
    }

    const dangerousSpot = {
        id: 'dangerous-party-room',
        name: 'Necropolis of Sacrifice',
        minLevel: 20,
        maxLevel: 24,
        avgLevel: 22,
        density: 20,
        tags: ['dungeon', 'catacomb'],
        tagsAuthoritative: true
    };
    const unqualifiedCurrentSpot = {
        id: 'dangerous-room-grid-without-area',
        name: 'Nearby ordinary fields'
    };
    SpotService.findCurrentSpot = () => unqualifiedCurrentSpot;
    SpotProfiles.findForState = () => unqualifiedCurrentSpot;
    const emergencyRoute = routeFor({
        characterId: 24,
        phase: 'cold',
        activity: 'hunting',
        level: 22,
        spotId: dangerousSpot.id,
        currentRegion: dangerousSpot.name,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: { routeMode: 'party' }
    }, unqualifiedCurrentSpot, null, [], [targetSpot]);
    assert(emergencyRoute, 'a detached solo bot must receive a route out of party-only content');
    assert.strictEqual(emergencyRoute.spotId, targetSpot.id);
    assert.strictEqual(emergencyRoute.reason, 'unsafe_ground_evacuation');

    // A large world catalog must not rebuild a bot's skills and combat stats
    // for every possible evacuation destination on the server thread.
    const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
    const originalProfileFor = ColdCombatProfile.profileFor;
    const originalAllowed = LevelingRoutes.isSpotAllowedForState;
    let profileBuilds = 0;
    const checkedSpots = [];
    ColdCombatProfile.profileFor = (...args) => {
        profileBuilds += 1;
        return originalProfileFor.apply(ColdCombatProfile, args);
    };
    LevelingRoutes.isSpotAllowedForState = (spot, ...args) => {
        checkedSpots.push(spot.id);
        return originalAllowed(spot, ...args);
    };
    try {
        const alternatives = Array.from({ length: 8 }, (_, i) => ({
            ...targetSpot, id: `evacuation-${i}`
        }));
        const outOfRange = Array.from({ length: 100 }, (_, i) => ({
            ...targetSpot, id: `out-of-range-${i}`, minLevel: 70, maxLevel: 80
        }));
        const catalog = [...outOfRange, ...alternatives];
        const evacuationState = {
            characterId: 26, phase: 'cold', activity: 'hunting', level: 22,
            spotId: dangerousSpot.id, currentRegion: dangerousSpot.name,
            loc: { locX: 1, locY: 2, locZ: 3 }, stats: { routeMode: 'party' }
        };
        const routeAgain = () => routeFor(evacuationState, unqualifiedCurrentSpot, null, [], catalog);
        const first = routeAgain();
        assert(first && alternatives.some(spot => spot.id === first.spotId),
            'evacuation must still choose a safe destination');
        assert(profileBuilds <= 3,
            `evacuation must reuse combat profiles across candidates; built ${profileBuilds}`);
        assert(!checkedSpots.some(id => id.startsWith('out-of-range-')),
            'level exclusions must run before expensive combat checks');
        const firstBuilds = profileBuilds;
        const second = routeAgain();
        assert.strictEqual(second.spotId, first.spotId);
        assert(profileBuilds > firstBuilds && profileBuilds <= firstBuilds + 3,
            'each new route decision must use fresh combat state without a catalog-sized rebuild');
    } finally {
        ColdCombatProfile.profileFor = originalProfileFor;
        LevelingRoutes.isSpotAllowedForState = originalAllowed;
    }
    SpotService.findCurrentSpot = () => currentSpot;
    SpotProfiles.findForState = routeTargetForState;

    const party = {
        partyId: 'route-party',
        leaderId: 2,
        memberIds: [2, 3],
        spotId: currentSpot.id
    };
    const members = [
        { characterId: 2, phase: 'cold', activity: 'grouped', level: 16, spotId: currentSpot.id, loc: { locX: 1, locY: 2, locZ: 3 }, stats: {} },
        { characterId: 3, phase: 'cold', activity: 'grouped', level: 16, spotId: currentSpot.id, loc: { locX: 4, locY: 5, locZ: 6 }, stats: {} }
    ];
    const partyRoute = routeFor(members[0], currentSpot, party, members, [currentSpot, targetSpot]);
    assert.strictEqual(partyRoute.mode, 'party');
    assert.strictEqual(Object.keys(partyRoute.destinations).length, 2);
    assert.deepStrictEqual(partyRoute.destinations['3'], destinationFor(members[1]));

    const dungeonPoint = { locX: 145224, locY: 120001, locZ: -4500 };
    const lair = { ...targetSpot, id: '24_20:antharas_lair', center: dungeonPoint, name: "Antharas' Lair" };
    const displacedMembers = members.map((m, i) => ({ ...m, spotId: lair.id, vitals: { hp: 100 },
        loc: { ...dungeonPoint, ...(i ? { locZ: 160 } : {}) } }));
    const displacedParty = { ...party, spotId: lair.id };
    SpotService.findCurrentSpot = loc => SpotService.containsLocation(lair, loc) ? lair : { id: '24_20' };
    SpotProfiles.findForState = () => lair;
    SpotService.arrivalPointForState = () => dungeonPoint;
    try {
        const repairedRoute = routeFor(displacedMembers[0], lair, displacedParty, displacedMembers, [lair]);
        assert(repairedRoute?.needed);
        assert.strictEqual(repairedRoute.cause, 'position_mismatch');
        assert.strictEqual(repairedRoute.reason, 'party_spot_replan');
        const Kernel = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
        const departing = require('../src/GameServer/Bot/Population/HuntingTravel').beginHuntingTrip(displacedMembers[1], repairedRoute, 1000);
        assert.strictEqual(departing.loc.locZ, 160, 'repair uses ordinary travel, not an instant move');
        assert.strictEqual(Kernel.finishPartyRouteTravelState(departing, 2000), null);
        const arrived = Kernel.finishPartyRouteTravelState(departing, 1000 + repairedRoute.travelMs);
        assert(SpotService.containsLocation(lair, arrived.loc));
        assert.strictEqual(arrived.spotId, lair.id);
        for (const patch of [{ phase: 'hot' }, { activity: 'resting' }, { stats: { pvpEncounter: { key: 'fighting' } } }]) {
            const blockedMembers = [displacedMembers[0], { ...displacedMembers[1], ...patch }];
            assert.strictEqual(routeFor(blockedMembers[0], lair, displacedParty, blockedMembers, [lair]), null);
        }
        const validMembers = displacedMembers.map(m => ({ ...m, loc: dungeonPoint }));
        assert.strictEqual(routeFor(validMembers[0], lair, displacedParty, validMembers, [lair]), null,
            'valid positions do not cause endless repair journeys');

        // The leader is already here, but two teammates still occupy another spot.
        const joiningMembers = [displacedMembers[0],
            { ...displacedMembers[1], spotId: currentSpot.id },
            { ...displacedMembers[1], characterId: 4, spotId: currentSpot.id }];
        const joiningParty = { ...displacedParty, memberIds: [2, 3, 4] };
        // No place is held at planning (ARCH-08-c): the repair brings the
        // missing members whatever the crowd; the party's room is checked at
        // its arrival (test_room_at_arrival.js).
        assert(routeFor(joiningMembers[0], lair, joiningParty, joiningMembers, [lair])?.needed,
            'repair brings the missing members without a reservation');
    } finally {
        SpotService.findCurrentSpot = () => currentSpot;
        SpotProfiles.findForState = routeTargetForState;
        SpotService.arrivalPointForState = destinationFor;
        LifeState.cachedState = originalCachedState;
    }

    const pressuredMembers = [
        members[0],
        {
            ...members[1],
            stats: {
                deaths: 2,
                fightsResolved: 5,
                spotRisk: { spotId: currentSpot.id, deathsAtEntry: 0, fightsAtEntry: 0 }
            }
        }
    ];
    const personalPressureRoute = routeFor(pressuredMembers[0], currentSpot, party, pressuredMembers,
        [currentSpot, targetSpot], 5000);
    assert(!personalPressureRoute.spotBackoff,
        'a member solo death history must not force the whole party to retreat');
    const partyRisk = require('../src/GameServer/Bot/Population/PartySpotRiskPolicy');
    const failedGroup = partyRisk.record(party, {
        debug: { fights: 5, wins: 3, spotId: currentSpot.id },
        partyPatch: { stats: { deaths: 2 } }
    }, 5000);
    const pressuredParty = { ...party, ...failedGroup.partyPatch };
    const pressuredPartyRoute = routeFor(members[0], currentSpot, pressuredParty, members,
        [currentSpot, targetSpot], 5000);
    assert.strictEqual(pressuredPartyRoute.reason, 'party_spot_replan');
    assert.strictEqual(pressuredPartyRoute.cause, 'death_pressure');
    assert.strictEqual(pressuredPartyRoute.spotBackoff.spotId, currentSpot.id,
        'group deaths must move the whole party without splitting it');
    assert.strictEqual(partyRisk.rounds(pressuredParty), partyRisk.rounds(party) + 1, 'a party resolve is one party round');
    const movedParty = partyRisk.withBackoff(pressuredParty, pressuredPartyRoute.spotBackoff, 5000);
    assert.strictEqual(movedParty.stats.partySpotRisk.spotBackoffs[0].untilStep - partyRisk.rounds(movedParty),
        Risk.BACKOFF_STEPS, 'a first group death mark lives the party\'s own rounds');

    const requestPlan = {
        status: 'active',
        strategy: 'direct_drop',
        partyNeed: 'required',
        next: { spotId: targetSpot.id, npcId: 414, itemId: 9001 },
        target: { selfId: 9001 }
    };
    const request = PartyRequestPlanner.partyRequestForPlan({
        characterId: 4,
        activity: 'hunting',
        stats: {}
    }, requestPlan, 1000, { economy: { worth: () => 0 } });
    assert.strictEqual(request.status, 'open', 'the worker must create a durable party request for a required plan');
    assert.strictEqual(request.priority, 'required');
    const config = invoke('GameServer/Bot/Population/PopulationConfig');
    const expiredRequest = PartyRequestPlanner.partyRequestForPlan({
        characterId: 4,
        activity: 'hunting',
        stats: {
            partyRequest: {
                ...request,
                status: 'open',
                requestedAt: 1000
            }
        }
    }, requestPlan, 1000 + Math.max(30000, Number(config.partyRequestMaxAgeMs) || 15 * 60 * 1000) + 1, { economy: { worth: () => 0 } });
    assert.strictEqual(expiredRequest.status, 'deferred', 'the worker request helper must preserve deferred recovery semantics');
    assert.strictEqual(expiredRequest.attempts, 1);

    const fallbackSpot = { id: 'solo-fallback', name: 'Solo fallback' };
    GearAcquisitionPlanner.safeFallbackForPlan = () => ({ spotId: fallbackSpot.id, npcId: 321 });
    const fallbackRoute = routeFor({
        characterId: 5,
        phase: 'cold',
        activity: 'hunting',
        level: 16,
        spotId: currentSpot.id,
        loc: { locX: 1, locY: 2, locZ: 3 },
        stats: { equipmentPlan: requestPlan, partyRequest: request }
    }, currentSpot, null, [], [fallbackSpot]);
    assert.strictEqual(fallbackRoute.spotId, fallbackSpot.id,
        'a bot waiting for a required party must route to a safe fallback instead of its party-only source');

    GearAcquisitionPlanner.safeFallbackForPlan = originalSafeFallbackForPlan;
    const profiles = [currentSpot, targetSpot];
    let rewardScans = 0;
    const rewards = DataCache.npcRewards;
    const originalForEach = rewards.forEach;
    rewards.forEach = function (...args) {
        rewardScans += 1;
        return originalForEach.apply(this, args);
    };
    try {
        for (const characterId of [51, 52]) {
            routeFor({
                characterId,
                phase: 'cold',
                activity: 'hunting',
                level: 16,
                spotId: currentSpot.id,
                loc: { locX: 1, locY: 2, locZ: 3 },
                stats: { equipmentPlan: {
                    status: 'active', strategy: 'direct_drop',
                    partyNeed: 'required', target: { selfId: 1 }
                }, partyRequest: request }
            }, currentSpot, null, [], profiles);
        }
        // b93aef45 keeps one static reward atlas per rewards/npcs table, so the
        // atlas built by an earlier route in this file may already serve both.
        assert(rewardScans <= 1,
            'repeated cold fallback routes must reuse the reward index across decision batches');
    } finally {
        delete rewards.forEach;
    }

    console.log('Cold worker leveling route planning checks passed');
} finally {
    SpotProfiles.findForState = originalFindForState;
    SpotService.findCurrentSpot = originalFindCurrentSpot;
    SpotService.arrivalPointForState = originalArrivalPointForState;
    GearAcquisitionPlanner.safeFallbackForPlan = originalSafeFallbackForPlan;
    LifeState.cachedState = originalCachedState;
    SpotProfiles.ensure = originalEnsure;
}
