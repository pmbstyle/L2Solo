'use strict';
// The bot's hunting route (docs/architecture.md §2 route): where a far bot
// hunts and the trip there. Two parts:
// - choose: the spot search, the bot's computed value over COMPUTED.route
//   (build, relations, occupation, sources). trip keeps its result in the
//   bot's kernel record; the worker's step drops it (drop, dropReason) when
//   its mask hits those sections, it wrote other plan / request fields the
//   search reads, a leaf trip starts, or the trip finds the kept spot full
//   (ROUTE-ROOM-3); it reads no leaf and no focus.
// - record: the trip from where the bot stands now (destinations, travel
//   time, the reason fields), built per read and never kept.
// leafChoice: the spot the step's own decision names, when it may go there
// (leafFitReader: the one fit test, the economy's leaf reads it too).
// Callers: the worker's trip start (planLifecycle: trip), the party run (the
// worker's partyRoute, ColdSimulationKernel), the competition retreat on main
// (ColdSimulationCoordinator retreatRoute). Worker-safe: every spot lookup
// reads the catalog the caller passes (`spots`, the spot profile array: the
// worker's planning catalog, SpotProfiles.ensure() on main).
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const BotTargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const ClanPartyDuty = invoke('GameServer/Bot/Population/ClanPartyDuty');
const BotCrystallization = invoke('GameServer/Bot/Economy/BotCrystallization');
const EquipmentIncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const PartySpotRiskPolicy = require('./PartySpotRiskPolicy');
const PartyHuntingAssembly = require('./PartyHuntingAssembly');
const CraftMaterialParty = require('./CraftMaterialParty');
const CraftMaterialPartyRoute = require('./CraftMaterialPartyRoute');
const ColdTrip = require('./ColdTrip');
const PveEncounter = require('./ColdPveEncounter');
const EconomyDiagnostics = require('../Economy/EconomyDiagnostics');

// The gates: a bot that may be routed now. Checked by choose and again by
// record at every read (activity, travel and the duties move step by step).
function routable(state, party, partyMembers, timestamp) {
    if (!state || state.phase !== 'cold' || state.stats?.travel) return false;
    // A fight under way ends first: a trip would drop it (HuntingTravel).
    if (PveEncounter.pending(party || state, timestamp)) return false;
    if (!party && ClanPartyDuty.waiting(state)) return false;
    if (!(state.activity === 'hunting' || (party && state.activity === 'grouped'))) return false;
    if (!party && BotCrystallization.ready(state)) return false;
    return !(party && partyMembers.some((member) => ['resting', 'traveling', 'dead'].includes(member.activity)));
}

// The spot the bot stands on now. Virtual raid profiles share the ordinary
// world grid with their surrounding field. Once the party has arrived, its
// persisted raid spot is the semantic destination; preferring the grid id
// here would schedule another 25-second trip to the same coordinates forever.
function currentSpotId(state, currentSpot, party, spots) {
    let physical = null;
    try { physical = SpotService.findCurrentSpot(state.loc, spots); } catch (_) { physical = null; }
    const declaredSpotId = party?.spotId || state.spotId || null;
    const declaredSpot = declaredSpotId ? SpotIndex.spotById(spots, declaredSpotId) : null;
    return declaredSpot?.raidBoss === true ? declaredSpot.id : physical?.id || currentSpot?.id || declaredSpotId;
}

// Match the combat resolver: an indexed coordinate sector only describes the
// current ground when it agrees with the persisted spot. Legacy dungeon
// sectors can keep their qualified id/name after the rebuilt spawn index
// exposes the same grid as an ordinary field.
function groundOf(state, currentSpot) {
    if (currentSpot && (!state.spotId || String(state.spotId) === String(currentSpot.id))) return currentSpot;
    return (state.spotId || state.currentRegion) ? {
        id: state.spotId || null,
        name: state.currentRegion || null,
        area: state.area || state.stats?.area || null
    } : currentSpot;
}

// The search options of one routed bot or party at this timestamp. Solo
// checks judge this bot, as the only capacity state; its combat profiles
// depend on the bot, not the spot: built once per frame (solo()), as is the
// unsafe-ground verdict. One frame serves one trip start (leafChoice or
// choose, then record): the caller builds it once and passes it to each.
// hasRoom: the worker's room filter for the spot search (ROUTE-ROOM): the
// solo trip's for the bot, the party run's for the whole party; main passes
// none (a search on main reads main's world index for the routed members in
// SpotProfiles.findForState, ROUTE-ROOM-4). spotHunters: the worker's hunters
// count for the search's spot values (ColdSimulationKernel.spotHunters; main
// passes none: SpotEconomics reads main's).
function frameFor(state, party, partyMembers = [], timestamp, hasRoom = null, spotHunters = null) {
    const partyRoute = !!party;
    const routedMembers = partyRoute ? partyMembers : [state];
    const excludedSpotIds = partyRoute ? PartySpotRiskPolicy.excludedSpotIds(party, timestamp)
        : SpotRiskPolicy.excludedSpotIdsForStates(routedMembers, timestamp);
    const role = partyRoute ? PartyComposition.roleForState(state) : null;
    const options = { capacityStates: routedMembers, excludedSpotIds, timestamp,
        ...(partyRoute ? { mode: 'party', role } : {}), ...(hasRoom ? { hasRoom } : {}), ...(spotHunters ? { spotHunters } : {}) };
    let soloProfiles = null;
    const solo = () => {
        soloProfiles = soloProfiles || BotTargetMatchup.stateProfiles(state, { ...options, mode: 'solo' });
        return { ...options, mode: 'solo', matchupProfiles: soloProfiles };
    };
    return { partyRoute, routedMembers, excludedSpotIds, role, options, solo, unsafe: undefined };
}

function unsafeSoloGround(state, currentSpot, frame) {
    if (frame.unsafe !== undefined) return frame.unsafe;
    const ground = !frame.partyRoute ? groundOf(state, currentSpot) : null;
    frame.unsafe = !!ground && !LevelingRoutes.isSpotAllowedForState(ground, state, frame.solo());
    return frame.unsafe;
}

// The search: { spotId (null: none found), materialRoute, materialSources }
// or null when the bot may not be routed now or the search threw (nothing
// to keep: the next trip start searches again). Reads no leaf and no focus.
function choose(state, currentSpot, party, partyMembers = [], { spots, timestamp, frame = null }) {
    if (!routable(state, party, partyMembers, timestamp)) return null;
    frame = frame || frameFor(state, party, partyMembers, timestamp);
    const { partyRoute, excludedSpotIds, role, options } = frame;
    const currentId = currentSpotId(state, currentSpot, party, spots);
    let fallbackSpot = null;
    if (!partyRoute && PartyWaitFallback.waiting(state, state.stats?.equipmentPlan, state.stats?.partyRequest)) {
        try {
            fallbackSpot = PartyWaitFallback.spotFor(state, state.stats?.equipmentPlan, spots,
                { excludedSpotIds, timestamp, hasRoom: options.hasRoom, spotHunters: options.spotHunters })?.spot || null;
        } catch (_) { fallbackSpot = null; }
    }
    const routeState = partyRoute
        ? {
            ...state,
            spotId: party.spotId || state.spotId,
            party: { ...(state.party || {}), partyId: party.partyId, role },
            stats: { ...(state.stats || {}), routeMode: 'party' }
        }
        : fallbackSpot
            ? { ...state, spotId: null }
            : state;
    const unsafe = unsafeSoloGround(state, currentSpot, frame);
    // The party's objective spot rule: a clan objective's spot, unless excluded.
    const sharedSpot = party?.stats?.objective?.spotId;
    let selected = partyRoute && sharedSpot && !excludedSpotIds.has(String(sharedSpot))
        ? SpotIndex.spotById(spots, sharedSpot) : fallbackSpot;
    let materialRoute = null;
    if (!selected && partyRoute && CraftMaterialParty.isObjective(party.stats?.objective)) {
        materialRoute = CraftMaterialPartyRoute.select(party, partyMembers, spots, options);
        selected = materialRoute?.spot || null;
    }
    try {
        // A party-mode search of a lone member builds no profiles at all.
        if (!selected) selected = SpotProfiles.findForState(routeState, !partyRoute
            && LevelingRoutes.modeForState(routeState, options) !== 'party'
            ? { ...options, profiles: spots, matchupProfiles: frame.solo().matchupProfiles }
            : { ...options, profiles: spots });
    } catch (_) { return null; }
    if (unsafe && selected) {
        const repeatsCurrentGround = String(selected.id || '') === String(currentId || '');
        if (repeatsCurrentGround || !LevelingRoutes.isSpotAllowedForState(selected, state, frame.solo())) selected = null;
    }
    if (!selected && unsafe) selected = evacuationSpot(state, currentId, spots, frame);
    // A party search with no spot (no room for the whole party, or none
    // allowed or matched): the party stays where it is; the next run searches
    // again.
    if (partyRoute && !selected) EconomyDiagnostics.count('route', 'party', 'none');
    return { spotId: selected ? selected.id : null,
        ...(materialRoute ? { materialRoute: true, materialSources: materialRoute.sources } : {}) };
}

// No suitable field: a detached party member must not poll a blocked dungeon
// forever. Only for this rare safety evacuation, choose the least-bad allowed
// field near its level; the room there is checked at arrival, which lets it
// exceed a full spot by one (ARCH-08-a).
function evacuationSpot(state, currentId, spots, frame) {
    const level = Number(state.level || 1);
    const emergencyOptions = frame.solo();
    const nearLevel = SpotProfiles.spotsNearLevel(spots, level)
        .filter((profile) => String(profile.id) !== String(currentId || ''))
        .filter((profile) => !frame.excludedSpotIds.has(String(profile.id)));
    const emergencyCandidates = nearLevel.filter((profile) => (
        LevelingRoutes.isSpotAllowedForState(profile, state, emergencyOptions)
    ));
    const suitable = emergencyCandidates.filter((profile) => SpotService.isSuitable(profile, level, frame.options));
    return emergencyCandidates.length ? LevelingRoutes.bestSpot(
        suitable.length ? suitable : emergencyCandidates, state, emergencyOptions)?.spot || null : null;
}

// The one fit test of a solo bot's hunting-leaf spot, read by leafChoice and
// by the economy that names the leaf (EconomyContext.foundation): a reader
// spotId -> 'fit' or why not: 'missing' (not in the catalog), 'raid' (a raid
// profile), 'excluded' (the bot's risk exclusions, read once in the frame),
// 'unfit' (its ground, its matchup, or its level: SpotService.isSuitable, or
// an economic hunt within 15 levels). One frame and one ground and matchup
// reader serve every spot it is asked about.
function leafFitReader(state, { spots, timestamp, frame = null }) {
    frame = frame || frameFor(state, null, [], timestamp);
    const level = Number(state.level || 1);
    let allowed = null;
    return (spotId) => {
        const spot = SpotIndex.spotById(spots, spotId);
        if (!spot) return 'missing';
        if (spot.raidBoss === true) return 'raid';
        if (frame.excludedSpotIds.has(String(spot.id))) return 'excluded';
        allowed ||= LevelingRoutes.spotAllowedReaderFor(state, frame.solo());
        return allowed(spot) && (SpotService.isSuitable(spot, level, frame.options)
            || EquipmentIncomeRoute.economicHunt(state) && Number(spot.avgLevel || spot.minLevel || 1) >= level - 15)
            ? 'fit' : 'unfit';
    };
}

// The spot a solo bot's own hunting leaf names, as a choice for record, when
// the bot may hunt there (leafFitReader). With the worker's room filter
// (frame.options.hasRoom, ROUTE-ROOM-2) a fitting spot other than the bot's
// own with no room for it is no leaf trip either: returned with full: true
// (counted as route:trip:leaf_full), the kept route decides and its trip
// stands in for it (trip); the room is checked again at arrival. Null: the
// kept route decides.
function leafChoice(state, leaf, { spots, timestamp, frame = null }) {
    if (leaf?.activity !== 'hunting' || !leaf.spotId || !routable(state, null, [], timestamp)) return null;
    frame = frame || frameFor(state, null, [], timestamp);
    const verdict = leafFitReader(state, { spots, timestamp, frame })(leaf.spotId);
    if (verdict === 'missing') { EconomyDiagnostics.count('route', 'trip', 'leaf_missing'); return null; }
    if (verdict === 'unfit') { EconomyDiagnostics.count('route', 'trip', 'leaf_unfit'); return null; }
    if (verdict !== 'fit') return null;
    const wished = SpotIndex.spotById(spots, leaf.spotId);
    const hasRoom = frame.options.hasRoom;
    if (hasRoom && String(wished.id) !== String(state.spotId || '') && !hasRoom(wished.id)) {
        EconomyDiagnostics.count('route', 'trip', 'leaf_full');
        return { spotId: wished.id, full: true };
    }
    return { spotId: wished.id };
}

// The trip to a chosen spot from where the bot stands now, in the shape
// beginHuntingTrip reads, or null: not routable now, the spot left the
// catalog, the bot is already there, or no arrival point. The reason fields
// are read here, at the trip's start: a kept choice is read later, from
// another place (its death pressure and its ground are those of the start).
function record(state, chosen, party, partyMembers = [], { spots, currentSpot = null, timestamp, frame = null }) {
    if (!chosen?.spotId || !routable(state, party, partyMembers, timestamp)) return null;
    const selected = SpotIndex.spotById(spots, chosen.spotId);
    if (!selected) return null;
    const partyRoute = !!party;
    const currentId = currentSpotId(state, currentSpot, party, spots);
    const repairingPartyPosition = partyRoute && String(selected.id) === String(party.spotId || '')
        && partyMembers.every(member => member.phase === 'cold' && member.vitals?.hp > 0
            && !member.stats?.pvpEncounter && !member.stats?.travel)
        && (!PartyHuntingAssembly.nearby(partyMembers)
            || partyMembers.some(member => !SpotService.containsLocation(selected, member.loc)));
    const sharedSpot = party?.stats?.objective?.spotId;
    const materialEvacuation = partyRoute && !chosen.materialRoute
        && CraftMaterialParty.isObjective(party.stats?.objective) && String(selected.id) !== String(sharedSpot);
    if (String(selected.id) === String(currentId || '') && !repairingPartyPosition
        && !chosen.materialRoute && !materialEvacuation
        && (!partyRoute || String(party.spotId || '') === String(selected.id))) return null;

    const members = partyRoute ? partyMembers : [state];
    const destinations = partyRoute ? SpotService.arrivalPointsForParty(members, selected) : {};
    if (!destinations) return null;
    for (const member of partyRoute ? [] : members) {
        let destination = null;
        try { destination = SpotService.arrivalPointForState(member, selected); } catch (_) { destination = null; }
        if (!destination) return null;
        destinations[String(member.characterId)] = destination;
    }
    frame = frame || frameFor(state, party, partyMembers, timestamp);
    const spotBackoff = partyRoute ? PartySpotRiskPolicy.backoff(party, currentId, timestamp)
        : SpotRiskPolicy.backoffForStates(frame.routedMembers, currentId, timestamp);
    const unsafe = unsafeSoloGround(state, currentSpot, frame);
    const activeEquipmentPlan = state.stats?.equipmentPlan?.status === 'active';
    return {
        needed: true,
        mode: partyRoute ? 'party' : 'solo',
        currentSpotId: currentId,
        spotId: selected.id,
        regionName: selected.name || state.currentRegion || 'Hunting Ground',
        // The routed bot's trip time; a party's members all take it.
        travelMs: ColdTrip.spotTripMs(state, destinations[String(state.characterId)] || selected.center),
        reason: partyRoute
            ? 'party_spot_replan'
            : unsafe ? 'unsafe_ground_evacuation'
                : spotBackoff ? 'death_pressure_replan'
                    : activeEquipmentPlan ? 'equipment_source_replan' : 'level_replan',
        ...(spotBackoff ? { cause: 'death_pressure', spotBackoff }
            : repairingPartyPosition ? { cause: 'position_mismatch' } : {}),
        to: destinations[String(state.characterId)] || null,
        destinations,
        ...(chosen.materialRoute ? { materialSources: chosen.materialSources }
            : materialEvacuation ? { materialEvacuation: true } : {})
    };
}

// One search and its trip, nothing kept: the party run (the worker's room
// filter in hasRoom) and the retreat (main: none, the search reads main's index).
function route(state, currentSpot, party, partyMembers = [], { spots, timestamp, hasRoom = null, spotHunters = null }) {
    if (!routable(state, party, partyMembers, timestamp)) return null;
    const frame = frameFor(state, party, partyMembers, timestamp, hasRoom, spotHunters);
    return record(state, choose(state, currentSpot, party, partyMembers, { spots, timestamp, frame }), party, partyMembers,
        { spots, currentSpot, timestamp, frame });
}

// No solo ground (decision 10-30, T106): a solo bot hunts ground its level
// does not fit. The spot search keeps a fitting current spot and walks the
// fitting spots first, so the spot it leaves the bot on fails that same level
// fit (SpotService.isSuitable at the search's solo target level) only when
// its solo gate admitted no spot near the level. A bot whose own spot fits
// has ground; else the search decides (T126: a levelled-up healer on its old
// spot whose search moves it to fitting ground has ground): the route kept on
// its record (`owner`, the worker's kernel record), else one search kept
// there, so the trip start reads it and never searches again. Without an
// owner (no search inputs), its own spot decides. A gear plan's own source is
// an errand there. search: { owner, timestamp, hasRoom, spotHunters } as trip's.
function soloGroundMissing(state, spots, search = null) {
    if (!state?.spotId || state.party?.partyId || state.stats?.travel) return false;
    const plan = state.stats?.equipmentPlan;
    if (plan?.status === 'active' && String(plan.next?.spotId || '') === String(state.spotId)) return false;
    const spot = SpotIndex.spotById(spots, state.spotId);
    const level = LevelingRoutes.targetLevelForState(state, { mode: 'solo' });
    if (!spot || spot.raidBoss === true || SpotService.isSuitable(spot, level)) return false;
    if (!search?.owner) return true;
    const { owner, timestamp = Date.now(), hasRoom = null, spotHunters = null } = search;
    const chosen = owner.route || choose(state, SpotService.standingSpot(state, spots), null, [],
        { spots, timestamp, frame: frameFor(state, null, [], timestamp, hasRoom, spotHunters) });
    // No search now (choose: a bot on a rest, a trip, a duty): no verdict. Only
    // a search that found nothing, { spotId: null }, means no ground.
    if (chosen === null) return false;
    if (!owner.route) owner.route = chosen;
    const routed = chosen?.spotId ? SpotIndex.spotById(spots, chosen.spotId) : null;
    return !routed || routed.raidBoss === true || !SpotService.isSuitable(routed, level);
}

// The solo trip of a step: to the spot the step's own leaf names when the
// bot may hunt there (a trip there drops the kept route: it was searched
// from the ground the bot leaves), else to the route kept on `owner` (the
// bot's kernel record), searched here when it holds none (null: dropped or
// never computed; not saved, so the first read after a restart searches).
// A kept route to a spot other than the bot's own that hasRoom (the search's
// room filter, ROUTE-ROOM-3) refuses is dropped first (route:drop:full): the
// room-filtered search decides, as it does for a leaf trip. The trip is
// built from where the bot stands now; null: no trip. Counted as
// route:trip:leaf|kept|search. When the leaf's hunting spot is full now
// (leafChoice), a kept or searched level / gear trip stands in for it and
// names it (leafSpotId, read by DecisionSections.occupationPlanned; counted
// as route:trip:detour); a flight (death pressure, unsafe ground) names none:
// it stays an event, as does a trip away from a spot the bot may not hunt
// and the detour of a leaf that hunts a material at its monster (only that
// monster brings the material in).
const DETOUR_REASONS = new Set(['level_replan', 'equipment_source_replan']);
function trip(owner, state, leaf, { spots, currentSpot = null, timestamp, hasRoom = null, spotHunters = null }) {
    if (!routable(state, null, [], timestamp)) return null;
    const frame = frameFor(state, null, [], timestamp, hasRoom, spotHunters);
    // The accepted occupation owns this round. A routine hunting replan
    // must not turn a pending purchase/craft/sale into another field trip
    // before the native economy executor gets to carry it out.
    if (leaf?.activity && leaf.activity !== 'hunting' && !unsafeSoloGround(state, currentSpot, frame)) {
        EconomyDiagnostics.count('route', 'trip', 'occupation');
        return null;
    }
    const wished = leafChoice(state, leaf, { spots, timestamp, frame });
    if (wished && !wished.full) {
        EconomyDiagnostics.count('route', 'trip', 'leaf');
        const started = record(state, wished, null, [], { spots, currentSpot, timestamp, frame });
        if (started) drop(owner, 'leaf');
        return started;
    }
    const kept = owner?.route;
    if (hasRoom && kept?.spotId && String(kept.spotId) !== String(state.spotId || '') && !hasRoom(kept.spotId)) {
        drop(owner, 'full');
    }
    EconomyDiagnostics.count('route', 'trip', owner?.route ? 'kept' : 'search');
    const chosen = owner?.route || choose(state, currentSpot, null, [], { spots, timestamp, frame });
    if (owner && !owner.route) owner.route = chosen;
    const started = record(state, chosen, null, [], { spots, currentSpot, timestamp, frame });
    if (!started || !wished?.full || !DETOUR_REASONS.has(started.reason) || ColdEconomyDecision.materialHunt(leaf)) return started;
    EconomyDiagnostics.count('route', 'trip', 'detour');
    return { ...started, leafSpotId: wished.spotId };
}

// The kept route goes; the next trip start searches again. Counted as
// route:drop:<why> when one was kept.
function drop(owner, why) {
    if (!owner?.route) return;
    EconomyDiagnostics.count('route', 'drop', why);
    owner.route = null;
}

// The plan and party request fields the search reads (the party wait,
// PartyWaitFallback.waiting and spotFor; the plan's destination).
function planKey(plan, request) {
    return `${plan?.status}|${plan?.strategy}|${plan?.next?.spotId}|${plan?.next?.npcId}|${plan?.partyNeed}|`
        + `${plan?.requiresParty}|${request?.status}|${request?.priority}|${!!request?.materialParty}|${!!request?.suspendedFor}`;
}

// Why a step drops the kept route, read at the writer of the step's plan:
// its build moved a route section (DecisionSections.COMPUTED.route), or it
// wrote other plan / party request fields the search reads. '': kept.
function dropReason(sectionsMoved, before = {}, after = {}) {
    if (sectionsMoved) return 'sections';
    return planKey(before.plan, before.request) !== planKey(after.plan, after.request) ? 'plan' : '';
}

module.exports = { choose, record, leafChoice, leafFitReader, route, trip, drop, dropReason, soloGroundMissing };
