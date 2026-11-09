'use strict';
// The bot's hunting route: where a far bot
// hunts and the trip there. Three parts:
// - huntSpot: where a solo bot hunts next, the one choice (command, leaf,
//   plan source, held earning answer, search: the solo ones SpotSearch's), held on the bot's kernel record
//   (heldHuntSpot) by its named inputs; the worker's step drops it (drop) when
//   its build's route facts moved. Published in the mind (huntSpotHeld) for main.
// - choose: the spot search with no held answer (a party's ground, a party
//   waiter's fallback, SpotSearch's leveling goal through SpotProfiles.findForState,
//   an evacuation), the bot's computed value over its route facts
//   (EconomyContext PIECE_FACTS.route: kit, party, clan, spot, risk).
// - record: the trip from where the bot stands now (destinations, travel
//   time, the reason fields), built per read and never kept.
// leafChoice: the spot the step's own decision names, when it may go there
// (leafFitReader: the one fit test, the economy's leaf reads it too). The
// trip keeps the leaf's ground and matchup verdict on the same record, keyed
// on what it reads (heldVerdict).
// Callers: the worker's trip start (planLifecycle: trip) and publish (huntSpotHeld),
// the party run (the worker's partyRoute, ColdSimulationKernel: its held spot answer,
// searched only when the party's spot decision is woken). Worker-safe: every spot
// lookup reads the catalog the caller passes (`spots`, the spot profile array: the
// worker's planning catalog, SpotProfiles.ensure() on main).
const FailureLog = invoke('FailureLog');
const SpotIndex = invoke('GameServer/Bot/AI/SpotIndex');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const LevelingRoutes = invoke('GameServer/Bot/AI/LevelingRoutes');
const BotTargetMatchup = invoke('GameServer/Bot/AI/BotTargetMatchup');
const SpotProfiles = invoke('GameServer/Bot/Population/SpotProfiles');
const SpotRiskPolicy = invoke('GameServer/Bot/Population/SpotRiskPolicy');
const PartyWaitFallback = invoke('GameServer/Bot/Population/PartyWaitFallback');
const GearAcquisitionPlanner = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Situations = require('../Situations');
const Trace = require('../DecisionTrace');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const ClanPartyDuty = invoke('GameServer/Bot/Population/ClanPartyDuty');
const BotCrystallization = invoke('GameServer/Bot/Economy/BotCrystallization');
const EquipmentIncomeRoute = invoke('GameServer/Bot/Economy/EquipmentIncomeRoute');
const BotHuntingGroundPolicy = invoke('GameServer/Bot/AI/BotHuntingGroundPolicy');
const PartySpotRiskPolicy = require('./PartySpotRiskPolicy');
const SpotRecords = require('./SpotRecords');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
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

// The spot the bot stands on now (SpotService.standingSpot, the one rule), its party's
// spot declared over its own: an arrived party's raid profile, else the spot under it,
// else the declared spot once the body has arrived there. A body far from its declared
// spot (in town after a rest) stands on none, so a trip to that spot starts.
function currentSpotId(state, party, spots) {
    try {
        return SpotService.standingSpot({ spotId: party?.spotId || state.spotId || null, loc: state.loc }, spots)?.id || null;
    } catch (error) { FailureLog.note('route.current_spot', error); return null; }
}

// The search options of one routed bot or party at this timestamp. Solo
// checks judge this bot, as the only capacity state; its combat profiles
// depend on the bot, not the spot: built once per frame (solo()), as is the
// unsafe-ground verdict. One frame serves one trip start (leafChoice or
// choose, then record): the caller builds it once and passes it to each.
// No search reads the crowd: a spot is chosen by fit and met at arrival
// (SpotContest); a solo bot's search skips a camp known held against it
// (repelled: SpotRecords.reader, a hold it heard of in town).
function frameFor(state, party, partyMembers = [], timestamp) {
    const partyRoute = !!party;
    const routedMembers = partyRoute ? partyMembers : [state];
    const excludedSpotIds = partyRoute ? PartySpotRiskPolicy.excludedSpotIds(party, timestamp)
        : SpotRiskPolicy.excludedSpotIdsForStates(routedMembers, timestamp);
    const role = partyRoute ? PartyComposition.roleForState(state) : null;
    const options = { capacityStates: routedMembers, excludedSpotIds, timestamp,
        ...(partyRoute ? { mode: 'party', role } : { repelled: SpotRecords.reader(state, BotPersona.of(state)) }) };
    let soloProfiles = null;
    const solo = () => {
        soloProfiles = soloProfiles || BotTargetMatchup.stateProfiles(state, { ...options, mode: 'solo' });
        return { ...options, mode: 'solo', matchupProfiles: soloProfiles };
    };
    // owner: the solo trip's kernel record, where its spot verdicts are kept (heldVerdict).
    return { partyRoute, routedMembers, excludedSpotIds, role, options, solo, unsafe: undefined, owner: null };
}

// Ground a solo bot may not hunt alone (party-only ground): the one ground rule
// (LevelingRoutes.groundVerdict), as the hot body's flight asks it (HuntingState),
// over the ground it stands on (currentSpot: SpotService.standingSpot, the caller's).
// A body on no ground (in town after a visit) flees nothing.
// Ground whose spawns admit none of its fights is the round's (spot_empty in the
// route's ready view), not a flight: a C4 player in a mixed camp hunts the mobs he
// can and leaves when none is for him.
function unsafeSoloGround(state, currentSpot, frame) {
    if (frame.unsafe !== undefined) return frame.unsafe;
    const ground = !frame.partyRoute ? currentSpot : null;
    frame.unsafe = !!ground && !LevelingRoutes.groundVerdict(ground, state, { mode: 'solo' }).allowed;
    return frame.unsafe;
}

// A solo bot's ground and matchup verdict over its leaf's catalog spot, read
// ready, kept on its kernel record (frame.owner, the trip's: owner.spotFit)
// while what the verdict reads stands: the spot (the catalog's object), the
// bot's side (BotTargetMatchup.soloVerdictKey: kit, shot kind, servitor) and
// the matchup's safety target level (LevelingRoutes.safetyOptions: the
// recovery penalty). It reads no crowd and no exclusion. Party-only ground
// (BotHuntingGroundPolicy) also reads the worn gear: there a solo bot is
// judged each time, a grouped one keeps it. No owner (the economy's read, a
// party route, main) or no key: judged each time. Counted as
// route:spot_fit:leaf_kept|leaf_judged.
function heldVerdict(frame, spot, state, judge) {
    const owner = frame.owner;
    if (!owner || !spot) return judge();
    const grouped = BotHuntingGroundPolicy.isParty(state, { mode: 'solo' });
    if (!grouped && BotHuntingGroundPolicy.isDangerousSoloGround(spot, { tags: LevelingRoutes.tagsForSpot(spot) })) return judge();
    const side = BotTargetMatchup.soloVerdictKey(state, frame.options.timestamp, true);
    if (side === null) return judge();
    const key = `${side}|${LevelingRoutes.safetyOptions(state, { mode: 'solo' }).maxTargetLevel ?? ''}|${grouped ? 1 : 0}`;
    const held = owner.spotFit;
    if (held?.spot === spot && held.key === key) {
        EconomyDiagnostics.count('route', 'spot_fit', 'leaf_kept');
        return held.allowed;
    }
    const allowed = judge();
    owner.spotFit = { spot, key, allowed };
    EconomyDiagnostics.count('route', 'spot_fit', 'leaf_judged');
    return allowed;
}

// The search: { spotId (null: none found), npcId (a party waiter's planned
// fallback: the NPC its plan farms there, PartyWaitFallback.spotFor),
// materialRoute, materialSources } or null when the bot may not be routed now
// or the search threw (nothing to keep: the next trip start searches again).
// Reads no leaf and no focus.
function choose(state, currentSpot, party, partyMembers = [], { spots, timestamp, frame = null }) {
    if (!routable(state, party, partyMembers)) return null;
    frame = frame || frameFor(state, party, partyMembers, timestamp);
    const { partyRoute, excludedSpotIds, role, options } = frame;
    const currentId = currentSpotId(state, party, spots);
    let fallback = null;
    if (!partyRoute && PartyWaitFallback.waiting(state, state.stats?.equipmentPlan, state.stats?.partyRequest)) {
        try {
            fallback = PartyWaitFallback.spotFor(state, state.stats?.equipmentPlan, spots,
                { excludedSpotIds, timestamp });
        } catch (error) { FailureLog.note('route.wait_fallback', error); fallback = null; }
    }
    const fallbackSpot = fallback?.spot || null;
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
        // A party-mode search of a lone member builds no profiles at all. A solo pick is the route's
        // answer: its habit counted (countHabit).
        if (!selected) selected = SpotProfiles.findForState(routeState, !partyRoute
            && LevelingRoutes.modeForState(routeState, options) !== 'party'
            ? { ...options, profiles: spots, matchupProfiles: frame.solo().matchupProfiles, countHabit: true }
            : { ...options, profiles: spots });
    } catch (error) { FailureLog.note('route.search', error); return null; }
    if (unsafe && selected) {
        const repeatsCurrentGround = String(selected.id || '') === String(currentId || '');
        if (repeatsCurrentGround || !LevelingRoutes.isSpotAllowedForState(selected, state, frame.solo())) selected = null;
    }
    if (!selected && unsafe) selected = evacuationSpot(state, currentId, spots, frame);
    // A party search with no spot elsewhere (none allowed or matched) keeps the party
    // on its current ground while that ground stands for it (partyGround). None:
    // the ground itself no longer stands for it (the party dissolves).
    if (partyRoute && !selected) {
        const ground = currentId ? SpotIndex.spotById(spots, currentId) : null;
        if (partyGround(ground, state, frame)) {
            EconomyDiagnostics.count('route', 'party', 'kept');
            selected = ground;
        } else EconomyDiagnostics.count('route', 'party', 'none');
    }
    return { spotId: selected ? selected.id : null, ...(objectiveEnded ? { objectiveEnded: true } : {}),
        ...(selected && selected === fallbackSpot && fallback.npcId ? { npcId: fallback.npcId } : {}),
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
        return heldVerdict(frame, spot, state,
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
// the bot may hunt there (leafFitReader), full or not (the crowd is met at
// arrival). Null: the
// kept route decides. owner: the bot's kernel record, where the verdict is
// kept (heldVerdict; the trip's frame carries it).
function leafChoice(state, leaf, { spots, timestamp, frame = null, owner = null }) {
    if (leaf?.activity !== 'hunting' || !leaf.spotId || !routable(state, null, [])) return null;
    if (!frame) { frame = frameFor(state, null, [], timestamp); frame.owner = owner; }
    const verdict = leafFitReader(state, { spots, timestamp, frame })(leaf.spotId);
    if (verdict === 'missing') { EconomyDiagnostics.count('route', 'trip', 'leaf_missing'); return null; }
    if (verdict === 'unfit') { EconomyDiagnostics.count('route', 'trip', 'leaf_unfit'); return null; }
    if (verdict !== 'fit') return null;
    return { spotId: SpotIndex.spotById(spots, leaf.spotId).id };
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
    const currentId = currentSpotId(state, party, spots);
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

// The party run's trip: to its held spot answer
// (held: { spotId }, Situations.partyHeld), else one search, its answer given to
// out.answer ({ spotId (null: none) , materialRoute, materialSources }: the party
// spot decision the run takes; none given when the party may not be routed now).
function route(state, currentSpot, party, partyMembers = [], { spots, timestamp, held = null, out = null }) {
    if (!routable(state, party, partyMembers)) return null;
    // A held answer searches nothing: its frame is built by record, only for a trip.
    const frame = held ? null : frameFor(state, party, partyMembers, timestamp);
    const chosen = held ? { spotId: held.spotId } : choose(state, currentSpot, party, partyMembers, { spots, timestamp, frame });
    if (!held && chosen && out) out.answer = chosen;
    return record(state, chosen, party, partyMembers, { spots, currentSpot, timestamp, frame });
}

// Does the bot's accepted non-hunting leaf hold it where it stands: only on its
// ground (the catalogue spot under it) while it may still hunt there, where its
// errand starts at the fight's edge. A bot with no ground under it (a town after a
// visit), on ground its marks exclude (excludedSpotIds: SpotRiskPolicy, a contest
// lost or displaced, a dangerous or unreachable spot), or on ground raised empty for
// it (emptyGround: the stay's spot_empty, the cold round's or the body's) while the
// spot it goes to when sent to hunt (heldSpotId, the held choice) is another, goes
// hunting at its held choice and the errand starts from the field, as a C4 player
// pushed off his camp, finding nothing to fight there, or done in town, walks to his
// camp. One rule for the cold trip (trip) and the hot body (BotDecisionService).
function occupationHolds(leaf, ground, excludedSpotIds, { emptyGround = null, heldSpotId = null } = {}) {
    if (!leaf?.activity || leaf.activity === 'hunting' || !ground) return false;
    const id = String(ground.id);
    return !excludedSpotIds.has(id) && !(String(emptyGround ?? '') === id && heldSpotId != null && String(heldSpotId) !== id);
}

// The solo trip of a step: to the spot the bot's one choice names (heldHuntSpot,
// kept on `owner`, the bot's kernel record), built from where it stands now; null:
// no trip. What the trip adds is the executor's part: an accepted occupation leaf
// holds the bot on ground it still hunts (occupationHolds: no field trip before the errand
// runs), ground the bot may not hunt alone (party-only ground, unsafeSoloGround)
// that the choice leaves it on is fled (the search's evacuation, choose, nothing
// kept; ground whose spawns admit none of its fights is the round's spot_empty), and with no spot it may take and no ground under it the bot asks the
// earning decision again once per answer (Situations.spotAsk on the record: the
// route carries spot_empty to the step, stepTrip; an answer to that ask with none
// either leaves it where it is, counted earning:no_spot), and so does a bot standing on
// ground its marks exclude (huntSpot sends it to the leveling goal first). Counted as
// route:trip:held_choice|evacuate|occupation. The held choice is read first, whatever
// the trip does, and given to out.held (the step publishes it: huntSpotKeyOf).
function trip(owner, state, leaf, { spots, currentSpot = null, timestamp, out = null }) {
    const held = heldHuntSpot(owner, state, leaf, { spots, timestamp });
    if (out) out.held = held;
    if (!routable(state, null, [])) return null;
    const frame = frameFor(state, null, [], timestamp);
    frame.owner = owner || null;
    // The accepted occupation owns this round on the bot's camp. A routine hunting
    // replan must not turn a pending purchase/craft/sale into another field trip
    // before the native economy executor gets to carry it out (occupationHolds).
    if (occupationHolds(leaf, currentSpot, frame.excludedSpotIds, { emptyGround: state.stats?.emptyGround, heldSpotId: held?.spotId })
        && !unsafeSoloGround(state, currentSpot, frame)) {
        EconomyDiagnostics.count('route', 'trip', 'occupation');
        return null;
    }
    let chosen = held;
    if (unsafeSoloGround(state, currentSpot, frame)
        && (!chosen?.spotId || String(chosen.spotId) === String(currentSpotId(state, null, spots) || ''))) {
        EconomyDiagnostics.count('route', 'trip', 'evacuate');
        chosen = choose(state, currentSpot, null, [], { spots, timestamp, frame });
    } else {
        EconomyDiagnostics.count('route', 'trip', 'held_choice');
        if (chosen?.spotId) { if (owner?.spotAsk) owner.spotAsk = null; }
        // Ground its marks exclude (pushed off it: a contest lost) is no ground to stay on: it asks as a bot on none.
        else if ((!currentSpot || frame.excludedSpotIds.has(String(currentSpot.id)))
            && Situations.spotAsk(owner || {}, state.stats.earning, state.characterId) === 'ask') {
            return { needed: false, ask: 'spot_empty' };
        }
    }
    return record(state, chosen, null, [], { spots, currentSpot, timestamp, frame });
}

// A solo bot's held earning answer as a choice: the answer's spot, read, never
// searched (the same after a worker restart: the answer is in the mind). { spotId:
// null }: none it may take (none found, its marks exclude it, or ground it may not
// hunt alone now, LevelingRoutes.groundVerdict: no walk into a flight): it stays
// until a situation re-decides (pushed off its ground with none: huntSpot's leveling goal). undefined: no answer yet (its first decision pending), a
// protected starter field or a party waiter: the search decides (choose).
function heldChoice(state, spots, frame) {
    // A waiter for a required party hunts its safe fallback (PartyWaitFallback, in
    // choose) before its answer: temporary until the party aggregate.
    if (state.stats?.earning === undefined || SpotProfiles.isProtectedStarterCohort(state)
        || PartyWaitFallback.waiting(state, state.stats?.equipmentPlan, state.stats?.partyRequest)) return undefined;
    const spot = EquipmentIncomeRoute.heldSpot(state, spots);
    if (!spot || frame.excludedSpotIds.has(String(spot.id))
        || !LevelingRoutes.groundVerdict(spot, state, { mode: 'solo' }).allowed) return { spotId: null };
    return { spotId: spot.id };
}

// The gear plan's source as the bot's spot: the one search's source goal over the plan's item
// (GearAcquisitionPlanner.bestSourceForPlan: its sources by value, the habit band), under the
// bot's exclusions, each source judged as the bot would hunt it solo (the source route reader: its
// ground, level and kit against the source's species; a clan raid plan's raid ground by the ground and
// matchup verdict); with none picked, the plan's own source only when the item's list misses it (unlisted).
// None for a plan in leveling recovery (the leveling pick routes it) or a craft plan whose material is in
// the bag. Null: no active plan source the bot may take (its held answer decides).
function planSource(state, spots, frame) {
    const plan = state.stats?.equipmentPlan;
    if (plan?.status !== 'active' || !plan.next?.spotId) return null;
    const timestamp = frame.options.timestamp, solo = frame.solo();
    const route = GearAcquisitionPlanner.sourceRouteReader(state, { timestamp, spots, matchupProfiles: solo.matchupProfiles });
    let ready = null;
    // A camp heard held against the bot (repelled, SpotRecords) is no source it takes: asked as
    // the route's verdict, counted spot:repelled as SpotSearch.rank's filter counts it.
    const repelled = frame.options.repelled;
    const allowed = source => {
        const spot = SpotIndex.spotById(spots, source.spotId);
        if (!spot) return false;
        if (repelled?.(spot.id)) { Situations.note('spot:repelled'); return false; }
        return spot.raidBoss === true ? (ready ||= LevelingRoutes.readySpotReaderFor(state, solo))(spot) : route(spot, source.npcId);
    };
    // The pick is the route's answer: its habit counted (countHabit).
    const source = GearAcquisitionPlanner.bestSourceForPlan(state, plan, spots, { excludedSpotIds: frame.excludedSpotIds, timestamp,
        mode: 'solo', matchupProfiles: solo.matchupProfiles, sourceAllowed: allowed, unlisted: true, countHabit: true,
        allowRaidSources: plan.next.sourceKind === 'raid' && GearAcquisitionPlanner.isClanOwnedPlan(plan) });
    return source ? SpotIndex.spotById(spots, source.spotId) : null;
}

// Where this solo bot hunts next: the one choice, for its trip (trip) and for every
// reader that sends it to hunt from wherever it stands (a town or hall visit's end, a
// body that must leave its ground: the mind key, huntSpotHeld). In order: a player's
// command (its spot whatever the bot's own marks: only a spot the catalogue lost or a
// raid refuses it), the spot its hunting leaf names when it fits (leafChoice), the gear
// plan's source (planSource; not for a protected starter or a party waiter), its held earning answer (heldChoice),
// else the search (choose: a party waiter's fallback, a protected starter's field, the
// leveling goal, also for a bot pushed off its ground whose answer names none). The bot is judged as
// if it hunted now, under its exclusions (marks, death marks, death pressure). Our
// choice, as a C4 player picks a camp: by level, gear goal and income he knows, the
// crowd met only on arrival. { spotId (null: none found or none it may take), npcId (a
// party waiter's planned fallback: the NPC its plan farms there, PartyWaitFallback.spotFor) },
// null for a party member (its hunt is its party's), undefined when the route may not
// take the bot now (a clan party wait, a crystal exchange ready) or its search threw
// (nothing kept: asked again at the next read). Worker-only: the catalogue
// (spots) is the trip's.
function huntSpot(state, leaf, { spots, timestamp, owner = null }) {
    if (!state || state.party?.partyId || state.partyId) return null;
    const hunter = { ...state, phase: 'cold', activity: 'hunting', stats: { ...state.stats, travel: null } };
    if (!routable(hunter, null, [])) return undefined;
    const earning = hunter.stats.earning;
    if (EquipmentIncomeRoute.isCommanded(earning)) {
        const spot = SpotIndex.spotById(spots, earning.spotId);
        return { spotId: spot && spot.raidBoss !== true ? String(spot.id) : null };
    }
    const frame = frameFor(hunter, null, [], timestamp);
    frame.owner = owner;
    const wished = leafChoice(hunter, leaf, { spots, timestamp, frame });
    if (wished) return { spotId: String(wished.spotId) };
    // A protected starter keeps its field and a party waiter its fallback before a plan's source (choose).
    const plan = hunter.stats.equipmentPlan;
    const source = SpotProfiles.isProtectedStarterCohort(hunter) || PartyWaitFallback.waiting(hunter, plan, hunter.stats.partyRequest)
        ? null : planSource(hunter, spots, frame);
    if (source) return { spotId: String(source.id) };
    let chosen = heldChoice(hunter, spots, frame);
    // Pushed off its spot (its marks exclude it) while its earning answer names none: the
    // leveling goal decides (choose, which never keeps excluded ground), as for a bot with no
    // answer; a C4 player who lost his camp and knows no better one goes to level elsewhere,
    // not back to it. Its reads are in the held key (the answer's spot, the exclusions, the spot).
    if (chosen === undefined || chosen.spotId == null && hunter.stats.earning?.spotId == null
        && hunter.spotId != null && frame.excludedSpotIds.has(String(hunter.spotId))) {
        chosen = choose(hunter, null, null, [], { spots, timestamp, frame });
    }
    // A search that threw keeps nothing: asked again at the next read.
    if (!chosen) return undefined;
    return { spotId: chosen.spotId != null ? String(chosen.spotId) : null, ...(chosen.npcId ? { npcId: chosen.npcId } : {}) };
}
// The choice (huntSpot) held on the bot's kernel record (owner.huntSpot = { key, value },
// worker-only), chosen again only when one of its inputs on the row moves: the leaf
// (activity, spot), the plan and party request fields the search reads (planKey: the
// gear plan's source and party need, the request's status, priority, material party and
// suspension), the earning answer's spot and command, the level, the party, the
// exclusions' revision and the spot it stands on (the search keeps the current spot).
// The rest it reads (the kit, shots and servitor of the ground and matchup verdicts,
// relations, risk deaths, recovery) moves the build's route facts, whose drop (drop)
// clears it; the catalogue's crowd is read when it chooses and wakes nothing. A changed
// choice is traced as hunt_spot decided by the route. The value, or null / undefined as
// huntSpot (neither kept).
function heldHuntSpot(owner, state, leaf, { spots, timestamp }) {
    const stats = state.stats || {};
    const key = `${leaf?.activity || ''}|${leaf?.spotId ?? ''}|${planKey(stats.equipmentPlan, stats.partyRequest)}`
        + `|${stats.earning?.spotId ?? ''}|${EquipmentIncomeRoute.isCommanded(stats.earning) ? 1 : 0}`
        + `|${Number(state.level) || 0}|${state.party?.partyId || state.partyId || ''}`
        + `|${SpotRiskPolicy.exclusionVersion(state).revision}|${state.spotId ?? ''}`;
    const held = owner?.huntSpot;
    if (held?.key === key) return held.value;
    const value = huntSpot(state, leaf, { spots, timestamp, owner });
    if (!value) return value;
    const was = held?.value?.spotId ?? stats.huntSpot?.spotId ?? null;
    if (Trace.on() && was !== value.spotId) {
        Trace.record({ kind: 'decided', bot: state.characterId, decision: 'hunt_spot', caller: 'route', how: 'taken',
            ...(value.spotId == null ? {} : { answer: value.spotId }), ...(was == null ? {} : { was: String(was) }) });
    }
    if (owner) owner.huntSpot = { key, value };
    return value;
}
// The mind key a worker step or near decision publishes (null: unchanged): stats.huntSpot
// = { spotId: the held choice's spot (null: none) }, ~20 bytes per row, read by main
// (DecisionEvents.heldSpotOf). Written whenever the row's value differs from the one
// chosen (a refused commit, a restart: written again at the next step). A party member
// (null) or a step the route may not take the bot on (undefined) writes nothing: the
// next step asks again.
function huntSpotHeld(owner, state, leaf, options) {
    return huntSpotKeyOf(state, heldHuntSpot(owner, state, leaf, options));
}
// The mind key of a held choice already read (trip's out.held): huntSpotHeld without a second read.
function huntSpotKeyOf(state, value) {
    if (!value) return null;
    return state.stats?.huntSpot?.spotId === value.spotId ? null : { huntSpot: { spotId: value.spotId } };
}

// The held choice goes: chosen again at the next read. Counted as route:drop:<why> when
// one was held.
function drop(owner, why) {
    if (!owner?.huntSpot) return;
    EconomyDiagnostics.count('route', 'drop', why);
    owner.huntSpot = null;
}

// The plan and party request fields the search reads (the party wait,
// PartyWaitFallback.waiting and spotFor; the plan's destination).
function planKey(plan, request) {
    return `${plan?.status}|${plan?.strategy}|${plan?.next?.spotId}|${plan?.next?.npcId}|${plan?.partyNeed}|`
        + `${plan?.requiresParty}|${request?.status}|${request?.priority}|${!!request?.materialParty}|${!!request?.suspendedFor}`;
}

module.exports = { choose, record, leafChoice, leafFitReader, soloLevelFits, route, trip, occupationHolds, huntSpot, heldHuntSpot, huntSpotHeld, huntSpotKeyOf, drop };
