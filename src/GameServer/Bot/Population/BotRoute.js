'use strict';
// The bot's hunting route (docs/architecture.md §2 route): where a far bot
// hunts and the trip there. Two parts:
// - choose: the spot search, the bot's computed value over its route facts
//   (EconomyContext PIECE_FACTS.route: kit, party, clan, spot, risk). trip keeps
//   its result in the bot's kernel record; the worker's step drops it (drop,
//   dropReason) when its build's route facts moved, it wrote other plan / request fields the
//   search reads, a leaf trip starts, or the trip finds the kept spot full
//   (ROUTE-ROOM-3); it reads no leaf and no focus.
// - record: the trip from where the bot stands now (destinations, travel
//   time, the reason fields), built per read and never kept.
// leafChoice: the spot the step's own decision names, when it may go there
// (leafFitReader: the one fit test, the economy's leaf reads it too). The
// trip keeps its ground and matchup verdicts on the same record, each keyed
// on what it reads (heldVerdict).
// Callers: the worker's trip start (planLifecycle: trip), the party run (the
// worker's partyRoute, ColdSimulationKernel: its held spot answer, searched only
// when the party's spot decision is woken). Worker-safe: every spot lookup
// reads the catalog the caller passes (`spots`, the spot profile array: the
// worker's planning catalog, SpotProfiles.ensure() on main).
const FailureLog = invoke('FailureLog');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const BotTargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const Situations = require('../Situations');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const ClanPartyDuty = invoke('GameServer/Bot/Population/ClanPartyDuty');
const BotCrystallization = invoke('GameServer/Bot/Economy/BotCrystallization');
const EquipmentIncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');
const ColdEconomyDecision = invoke('GameServer/Bot/Population/ColdEconomyDecision');
const PartySpotRiskPolicy = require('./PartySpotRiskPolicy');
const PartyHuntingAssembly = require('./PartyHuntingAssembly');
const CraftMaterialParty = require('./CraftMaterialParty');
const CraftMaterialPartyRoute = require('./CraftMaterialPartyRoute');
const ColdTrip = require('./ColdTrip');
const PartyRequestPlanner = require('./PartyRequestPlanner');
const EconomyDiagnostics = require('../Economy/EconomyDiagnostics');

// The gates: a bot that may be routed now. Checked by choose and again by
// record at every read (activity, travel and the duties move step by step).
function routable(state, party, partyMembers) {
    if (!state || state.phase !== 'cold' || state.stats?.travel) return false;
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
    try { physical = SpotService.findCurrentSpot(state.loc, spots); } catch (error) { FailureLog.note('route.current_spot', error); }
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
    // owner: the solo trip's kernel record, where its spot verdicts are kept (heldVerdict).
    return { partyRoute, routedMembers, excludedSpotIds, role, options, solo, unsafe: undefined, owner: null };
}

function unsafeSoloGround(state, currentSpot, frame) {
    if (frame.unsafe !== undefined) return frame.unsafe;
    const ground = !frame.partyRoute ? groundOf(state, currentSpot) : null;
    frame.unsafe = !!ground && !heldVerdict(frame, 'ground', ground === currentSpot ? ground : null, state, false,
        () => LevelingRoutes.isSpotAllowedForState(ground, state, frame.solo()));
    return frame.unsafe;
}

// A solo bot's ground and matchup verdict over one catalog spot (the leaf's
// spot read ready, slot 'leaf'; the ground it stands on as it is, 'ground'),
// kept on its kernel record (frame.owner, the trip's: owner.spotFit[slot])
// while what the verdict reads stands: the spot (the catalog's object), the
// bot's side (BotTargetMatchup.soloVerdictKey: kit, shot kind, servitor) and
// the matchup's safety target level (LevelingRoutes.safetyOptions: the
// recovery penalty). It reads no crowd and no exclusion. Party-only ground
// (BotHuntingGroundPolicy) also reads the worn gear: there a solo bot is
// judged each time, a grouped one keeps it. No owner (the economy's read, a
// party route, main) or no key: judged each time. Counted as
// route:spot_fit:<slot>_kept|<slot>_judged.
function heldVerdict(frame, slot, spot, state, ready, judge) {
    const owner = frame.owner;
    if (!owner || !spot) return judge();
    const grouped = BotHuntingGroundPolicy.isParty(state, { mode: 'solo' });
    if (!grouped && BotHuntingGroundPolicy.isDangerousSoloGround(spot, { tags: LevelingRoutes.tagsForSpot(spot) })) return judge();
    const side = BotTargetMatchup.soloVerdictKey(state, frame.options.timestamp, ready);
    if (side === null) return judge();
    const key = `${side}|${LevelingRoutes.safetyOptions(state, { mode: 'solo' }).maxTargetLevel ?? ''}|${grouped ? 1 : 0}`;
    const held = owner.spotFit?.[slot];
    if (held?.spot === spot && held.key === key) {
        EconomyDiagnostics.count('route', 'spot_fit', `${slot}_kept`);
        return held.allowed;
    }
    const allowed = judge();
    owner.spotFit = { ...owner.spotFit, [slot]: { spot, key, allowed } };
    EconomyDiagnostics.count('route', 'spot_fit', `${slot}_judged`);
    return allowed;
}

// The search: { spotId (null: none found), materialRoute, materialSources }
// or null when the bot may not be routed now or the search threw (nothing
// to keep: the next trip start searches again). Reads no leaf and no focus.
function choose(state, currentSpot, party, partyMembers = [], { spots, timestamp, frame = null }) {
    if (!routable(state, party, partyMembers)) return null;
    frame = frame || frameFor(state, party, partyMembers, timestamp);
    const { partyRoute, excludedSpotIds, role, options } = frame;
    const currentId = currentSpotId(state, currentSpot, party, spots);
    let fallbackSpot = null;
    if (!partyRoute && PartyWaitFallback.waiting(state, state.stats?.equipmentPlan, state.stats?.partyRequest)) {
        try {
            fallbackSpot = PartyWaitFallback.spotFor(state, state.stats?.equipmentPlan, spots,
                { excludedSpotIds, timestamp, hasRoom: options.hasRoom, spotHunters: options.spotHunters })?.spot || null;
        } catch (error) { FailureLog.note('route.wait_fallback', error); fallbackSpot = null; }
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
    // The party's objective spot: a clan objective's spot unless excluded; a spot the
    // party only asked to meet at (PartyRequestPlanner.meetsAtSpot) while it stands for
    // the party as any party ground (partyGround), else that objective ends here
    // (objectiveEnded: the party routes as any other).
    const objective = party?.stats?.objective, sharedSpot = objective?.spotId;
    const meeting = partyRoute && !!sharedSpot && PartyRequestPlanner.meetsAtSpot(objective);
    const shared = partyRoute && sharedSpot && !excludedSpotIds.has(String(sharedSpot)) ? SpotIndex.spotById(spots, sharedSpot) : null;
    const objectiveEnded = meeting && !partyGround(shared, state, frame);
    let selected = objectiveEnded ? null : shared || fallbackSpot;
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
    } catch (error) { FailureLog.note('route.search', error); return null; }
    if (unsafe && selected) {
        const repeatsCurrentGround = String(selected.id || '') === String(currentId || '');
        if (repeatsCurrentGround || !LevelingRoutes.isSpotAllowedForState(selected, state, frame.solo())) selected = null;
    }
    if (!selected && unsafe) selected = evacuationSpot(state, currentId, spots, frame);
    // A party search with no spot elsewhere (no room for the whole party, or none
    // allowed or matched) keeps the party on its current ground while that ground
    // stands for it (partyGround): no room elsewhere is no reason to break up. None:
    // the ground itself no longer stands for it (the party dissolves).
    if (partyRoute && !selected) {
        const ground = currentId ? SpotIndex.spotById(spots, currentId) : null;
        if (partyGround(ground, state, frame)) {
            EconomyDiagnostics.count('route', 'party', 'kept');
            selected = ground;
        } else EconomyDiagnostics.count('route', 'party', 'none');
    }
    return { spotId: selected ? selected.id : null, ...(objectiveEnded ? { objectiveEnded: true } : {}),
        ...(materialRoute ? { materialRoute: true, materialSources: materialRoute.sources } : {}) };
}

// Ground that stands for a party (state: its leader): in the catalog, no raid, not
// excluded by its marks or deaths (the party's risk exclusions), its level fits the
// party (SpotService.isSuitable at the party's target level) and its leader has not
// outleveled it (the spot_outleveled fact: monsters past the deep-blue gap).
function partyGround(spot, state, frame) {
    return !!spot && spot.raidBoss !== true && !frame.excludedSpotIds.has(String(spot.id))
        && SpotService.isSuitable(spot, LevelingRoutes.targetLevelForState(state, { mode: 'party' }), frame.options)
        && !Situations.outleveledSpot(spot.id, Number(state.level) || 1);
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
        if (!soloLevelFits(state, spot, level, frame.options)) return 'unfit';
        // The ground and matchup clause, the costly one, last; kept on the
        // trip's record (heldVerdict).
        return heldVerdict(frame, 'leaf', spot, state, true,
            () => (allowed ||= LevelingRoutes.readySpotReaderFor(state, frame.solo()))(spot)) ? 'fit' : 'unfit';
    };
}

// A solo bot's level fit of a spot, one rule for its leaf (leafFitReader) and a
// support's ground (PartyRequestPlanner.supportWithoutGround): the spot suits the level
// (SpotService.isSuitable), or the bot hunts for gain (EquipmentIncomeRoute.economicHunt)
// on monsters at most 15 levels below its own.
function soloLevelFits(state, spot, level, options = {}) {
    return SpotService.isSuitable(spot, level, options)
        || EquipmentIncomeRoute.economicHunt(state) && Number(spot.avgLevel || spot.minLevel || 1) >= Number(state.level || 1) - 15;
}

// The spot a solo bot's own hunting leaf names, as a choice for record, when
// the bot may hunt there (leafFitReader). With the worker's room filter
// (frame.options.hasRoom, ROUTE-ROOM-2) a fitting spot other than the bot's
// own with no room for it is no leaf trip either: returned with full: true
// (counted as route:trip:leaf_full), the kept route decides and its trip
// stands in for it (trip); the room is checked again at arrival. Null: the
// kept route decides. owner: the bot's kernel record, where the verdict is
// kept (heldVerdict; the trip's frame carries it).
function leafChoice(state, leaf, { spots, timestamp, frame = null, owner = null }) {
    if (leaf?.activity !== 'hunting' || !leaf.spotId || !routable(state, null, [])) return null;
    if (!frame) { frame = frameFor(state, null, [], timestamp); frame.owner = owner; }
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
    if (!chosen?.spotId || !routable(state, party, partyMembers)) return null;
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
        try { destination = SpotService.arrivalPointForState(member, selected); } catch (error) { FailureLog.note('route.arrival', error); }
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
        travelMs: ColdTrip.spotPlan(state, destinations[String(state.characterId)] || selected.center).durationMs,
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

// The party run's trip (the worker's room filter in hasRoom): to its held spot answer
// (held: { spotId }, Situations.partyHeld), else one search, its answer given to
// out.answer ({ spotId (null: none) , materialRoute, materialSources }: the party
// spot decision the run takes; none given when the party may not be routed now).
function route(state, currentSpot, party, partyMembers = [], { spots, timestamp, hasRoom = null, spotHunters = null, held = null, out = null }) {
    if (!routable(state, party, partyMembers)) return null;
    // A held answer searches nothing: its frame is built by record, only for a trip.
    const frame = held ? null : frameFor(state, party, partyMembers, timestamp, hasRoom, spotHunters);
    const chosen = held ? { spotId: held.spotId } : choose(state, currentSpot, party, partyMembers, { spots, timestamp, frame });
    if (!held && chosen && out) out.answer = chosen;
    return record(state, chosen, party, partyMembers, { spots, currentSpot, timestamp, frame });
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
    if (!routable(state, null, [])) return null;
    const frame = frameFor(state, null, [], timestamp, hasRoom, spotHunters);
    frame.owner = owner || null;
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
    // A solo bot holding an earning answer goes to its spot (heldChoice), unless its
    // own ground is unsafe and the answer leaves it there: the search's evacuation
    // (choose, nothing kept). With no spot it may take and no ground under it, it
    // asks the decision again once per answer (Situations.spotAsk on the record:
    // the route carries spot_empty to the step, stepTrip); an answer to that ask
    // with none either leaves it where it is (counted earning:no_spot).
    let chosen = heldChoice(state, spots, frame);
    if (chosen && unsafeSoloGround(state, currentSpot, frame)
        && (!chosen.spotId || String(chosen.spotId) === String(currentSpotId(state, currentSpot, null, spots) || ''))) {
        EconomyDiagnostics.count('route', 'trip', 'evacuate');
        chosen = choose(state, currentSpot, null, [], { spots, timestamp, frame });
    } else if (chosen !== undefined) {
        EconomyDiagnostics.count('route', 'trip', 'held');
        if (chosen.spotId) { if (owner?.spotAsk) owner.spotAsk = null; }
        else if (!currentSpot && Situations.spotAsk(owner || {}, state.stats.earning, state.characterId) === 'ask') {
            return { needed: false, ask: 'spot_empty' };
        }
    } else {
        const kept = owner?.route;
        if (hasRoom && kept?.spotId && String(kept.spotId) !== String(state.spotId || '') && !hasRoom(kept.spotId)) {
            drop(owner, 'full');
        }
        EconomyDiagnostics.count('route', 'trip', owner?.route ? 'kept' : 'search');
        chosen = owner?.route || choose(state, currentSpot, null, [], { spots, timestamp, frame });
        if (owner && !owner.route) owner.route = chosen;
    }
    const started = record(state, chosen, null, [], { spots, currentSpot, timestamp, frame });
    if (!started || !wished?.full || !DETOUR_REASONS.has(started.reason) || ColdEconomyDecision.materialHunt(leaf)) return started;
    EconomyDiagnostics.count('route', 'trip', 'detour');
    return { ...started, leafSpotId: wished.spotId };
}

// A solo bot's route while it holds an earning answer (situations.md B12): the
// answer's spot, read, never searched and kept nowhere (the same after a worker
// restart: the answer is in the mind). { spotId: null }: none it may take (none
// found, its marks exclude it, or no room: ROUTE-ROOM-2): it stays until a
// situation re-decides. undefined: no answer yet (its first decision pending), a
// gear plan's source, a protected starter field or a party waiter: the search
// decides (choose).
function heldChoice(state, spots, frame) {
    const plan = state.stats?.equipmentPlan;
    // A waiter for a required party hunts its safe fallback (PartyWaitFallback, in
    // choose) before its answer: temporary until the party aggregate (step 8, debt.md).
    if (state.stats?.earning === undefined || SpotProfiles.isProtectedStarterCohort(state)
        || plan?.status === 'active' && plan.next?.spotId
        || PartyWaitFallback.waiting(state, plan, state.stats?.partyRequest)) return undefined;
    const spot = EquipmentIncomeRoute.heldSpot(state, spots);
    if (!spot || frame.excludedSpotIds.has(String(spot.id))) return { spotId: null };
    const hasRoom = frame.options.hasRoom;
    if (hasRoom && String(spot.id) !== String(state.spotId || '') && !hasRoom(spot.id)) return { spotId: null };
    return { spotId: spot.id };
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
// its build's route facts moved (EconomyContext.forState routeMoved), or it
// wrote other plan / party request fields the search reads. '': kept.
function dropReason(routeMoved, before = {}, after = {}) {
    if (routeMoved) return 'sections';
    return planKey(before.plan, before.request) !== planKey(after.plan, after.request) ? 'plan' : '';
}

module.exports = { choose, record, leafChoice, leafFitReader, soloLevelFits, route, trip, drop, dropReason };
