const SpotService = invoke('GameServer/Bot/AI/SpotService');
const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
const DecisionSections = invoke('GameServer/Bot/Economy/DecisionSections');
const TownTransitPolicy = invoke('GameServer/Bot/AI/TownTransitPolicy');
const RestPolicy = invoke('GameServer/Bot/AI/RestPolicy');
// lazy: BotRoute loads the route's population modules, which load this one.
let route = null;
const Route = () => (route ||= invoke('GameServer/Bot/Population/BotRoute'));

const EMPTY_HUNT_SCANS = 3;

function occupationKey(leaf) {
    return JSON.stringify([leaf.activity, leaf.rootKey, leaf.kind, leaf.itemId, leaf.npcId,
        leaf.town, leaf.spotId, leaf.recipeId, leaf.sourceType]);
}

// A hot solo hunter's look at its ground, the cold round's rule (BackgroundResolver:
// a spot whose spawns admit none of its fights raises unhuntable): once the scans of
// the whole spot found no fight (EMPTY_HUNT_SCANS), it asks once per empty streak
// whether any spawn group admits one at its whole bar (TargetMatchup.spotShares), as
// it stands and in the route's view (actorReadyProfiles: its pet up and whole;
// self-buffs unread, the route judges spots unbuffed); none in both: it raises the
// ground and the worker chooses another ('raised'). Short only of what the route
// counts whole, it gets ready as the cold round does (getReady): a summoner with no
// pet raises it out of the fight ('summon', C4: before it engages); short of the
// summon's MP, or with a pet only its regeneration makes whole, it sits ('rest');
// a summon or a pet heal on its reuse waits on its feet (''). Each looks again
// after a fresh streak of empty scans; a second summon or wait on the stay that
// changed nothing raises (groundReadying). When nothing it can do helps, it raises.
// stats.emptyGround, the stay's memory the cold round shares: one raise per stay,
// cleared by a streak's end. A spot only emptied for now (killed out, other
// hunters) admits its spawns: the bot waits there ('').
function groundLook(session, spot) {
    const stats = DecisionEvents.statsFor(session);
    if (Number(session.noTargetTicks || 0) < EMPTY_HUNT_SCANS) {
        session.groundLookedAt = null;
        if (stats.emptyGround != null) DecisionEvents.replaceStats(session, { ...stats, emptyGround: null });
        return '';
    }
    if (!spot?.id || !session.actor || session.hotBackgroundPartyId || session.followPlayerSession
        || session.partyCompanion === true || session.huntTargetScanPending || session.groundLookedAt === spot.id
        || String(stats.emptyGround ?? '') === String(spot.id)) return '';
    session.groundLookedAt = spot.id;
    const Matchup = invoke('GameServer/Bot/AI/BotTargetMatchup'), actor = session.actor, options = { soloSafety: true };
    if (!Matchup.admitsNone(Matchup.spotShares(Matchup.actorProfiles([actor]), spot, options))) {
        session.groundReadying = null;
        return '';
    }
    if (!Matchup.admitsNone(Matchup.spotShares(Matchup.actorReadyProfiles(actor), spot, options))) {
        const look = readyLook(actor), tried = session.groundReadying;
        // A summon or a wait that left it as it was (no pet came; silenced, a zone
        // or a condition holds the cast) ends the stay's readying: the ground is
        // raised. Each look comes after a fresh streak of empty scans.
        const again = (look === 'summon' || look === 'wait') && String(tried?.spotId) === String(spot.id) && tried.look === look;
        if (look && !again) {
            session.groundReadying = look === 'rest' ? null : { spotId: spot.id, look, at: Date.now() };
            session.groundLookedAt = null;
            session.noTargetTicks = 0;
            return look === 'wait' ? '' : look;
        }
    }
    session.groundReadying = null;
    DecisionEvents.replaceStats(session, { ...stats, emptyGround: String(spot.id) });
    DecisionEvents.raiseDecision(session, 'spot_empty');
    return 'raised';
}
// What gets the body ready (groundLook): 'summon', 'rest', 'wait' (a summon or
// its pet heal on its reuse) or '' (nothing it can do).
function readyLook(actor) {
    const Tactics = invoke('GameServer/Bot/AI/SummonerTactics');
    const pet = Tactics.petRestView(actor);
    // A pet its owner heals: the heal between fights ran before the scan, so one
    // still wanted waits on its reuse.
    if (pet) return !RestPolicy.petRested(pet) ? 'rest' : Tactics.petHealWaits(actor) ? 'wait' : '';
    const skills = Tactics.summonSkills(actor);
    if (!skills.length) return '';
    if (Tactics.summonSkill(actor)) return 'summon';
    const mp = Number(actor.fetchMp?.() || 0);
    // A rest that gets up before its MP is back (RestPolicy.restWaitsForMana) would not refill it: it waits standing.
    return skills.every(skill => Number(skill.fetchConsumedMp?.() || 0) > mp) && RestPolicy.restWaitsForMana(actor) ? 'rest' : 'wait';
}

function physicalLocation(status, session) {
    const actor = session.actor;
    const loc = { locX: Number(actor?.fetchLocX?.()), locY: Number(actor?.fetchLocY?.()), locZ: Number(actor?.fetchLocZ?.()) };
    return Object.values(loc).every(Number.isFinite) ? loc : status.loc;
}

const BotDecisionService = {
    occupationKey,
    suggest(status, session) {
        if (!status || !status.available) {
            return {
                action: 'idle',
                reason: 'missing_status'
            };
        }

        if (status.blockers.includes('dead')) {
            return {
                action: 'wait_for_revive',
                reason: 'dead'
            };
        }

        if (status.mode === 'resting') {
            return {
                action: 'recover',
                reason: 'already_resting'
            };
        }

        if (status.blockers.includes('low_hp') || status.blockers.includes('low_mp')) {
            return {
                action: 'rest',
                reason: status.blockers.includes('low_hp') ? 'low_hp' : 'low_mp'
            };
        }

        if (status.mode === 'following') {
            if (status.blockers.includes('too_far_from_leader')) {
                return {
                    action: 'catch_up_to_leader',
                    reason: 'too_far_from_leader',
                    leader: status.party?.leader || null
                };
            }

            if (status.target) {
                return {
                    action: 'assist_leader',
                    reason: 'leader_has_target',
                    target: status.target
                };
            }

            return {
                action: status.party?.stance === 'stay' ? 'hold_position' : 'follow_leader',
                reason: 'party_stance'
            };
        }

        if (status.target && status.target.dead === false) {
            return {
                action: status.mode === 'pk_hunting' ? 'attack_player' : 'attack_target',
                reason: 'active_target',
                target: status.target
            };
        }

        // Main never chooses a spot: the body walks to the spot the
        // worker's one choice names (DecisionEvents.heldSpotId) or raises the earning spot's
        // situation and waits for the background thread's answer.
        if (status.mode === 'hunting') {
            const economy = DecisionEvents.held(session);
            const leaf = economy?.network.activity;
            const stats = DecisionEvents.statsFor(session);
            // A player's command waits for its answer: the card still names the spot it replaced.
            if (DecisionEvents.commandPending(session)) return { action: 'search_locally', reason: 'awaiting_command_answer' };
            const loc = physicalLocation(status, session);
            const physical = SpotService.findCurrentSpot(loc);
            // An errand holds the body only on its ground while it may hunt there
            // (BotRoute.occupationHolds over SpotService.standingSpot and its marks, the cold
            // trip's rule and reads); with none under it (a town after a visit) or pushed off
            // it it goes hunting as a finished visit does (completedVisit below), the errand
            // kept for the field.
            const occupied = !!leaf?.activity && leaf.activity !== 'hunting';
            const standing = occupied ? SpotService.standingSpot({ spotId: session.currentSpot?.id, loc }) : null;
            if (standing && Route().occupationHolds(leaf, standing, DecisionEvents.excludedSpotIds(session))) {
                // A deferred errand keeps its wish, but cannot pin a hunter
                // forever to ground that admits none of its fights: the same
                // look as a hunt's (groundLook: spot_empty once a stay, or it
                // gets ready), and once the ground is empty for it, it walks to
                // the spot it goes to when sent to hunt when that is another spot.
                if (session.deferredOccupation === occupationKey(leaf) && session.huntingTargetScan) {
                    const ground = standing;
                    const look = groundLook(session, ground);
                    if (look === 'rest') return { action: 'rest', reason: 'ground_needs_rest' };
                    if (look === 'summon') return { action: 'summon', reason: 'ground_needs_pet' };
                    // groundLook replaces the stats it writes: read them after it.
                    const heldId = ground && String(DecisionEvents.statsFor(session).emptyGround ?? '') === String(ground.id)
                        ? DecisionEvents.heldSpotId(session) : null;
                    const spot = heldId && heldId !== 'pending' && heldId !== String(ground.id) ? SpotService.findById(heldId) : null;
                    if (spot) return { action: 'move_to_spot', reason: 'deferred_occupation_hunt',
                        spot, deferredOccupation: session.deferredOccupation };
                }
                return { action: 'continue_occupation', reason: 'selected_occupation', activity: leaf.activity };
            }
            const plannedOn = spotId => DecisionSections.occupationPlanned({ activity: 'hunting', spotId, stats }, leaf);
            // An accepted empty decision is different from awaiting the first
            // worker answer. Once a town visit has ended, the bot returns to the
            // spot it goes to when sent to hunt; an empty target scan in the field stays local.
            const completedVisit = occupied || !leaf && economy?.decided === true
                && (session.pendingFarmDepartureAnnouncement || TownTransitPolicy.townAt(loc));
            const hunt = leaf?.activity === 'hunting';
            // Where it hunts is the worker's one choice (its leaf's spot when it may hunt
            // there), published in its mind; a raise the worker has not answered yet may
            // choose another spot: it waits for the answer rather than walk and turn.
            const heldId = hunt || completedVisit ? DecisionEvents.heldSpotId(session) : null;
            if (heldId === 'pending') return { action: 'search_locally', reason: 'awaiting_hunt_answer' };
            const spot = heldId ? SpotService.findById(heldId) : null;
            // On its spot by the arrival rule (SpotService.arrivedAt: its ground or the arrival
            // radius), not an exact cell: a body that arrived on a neighbouring cell stays.
            // With none published, the ground its leaf plans holds it.
            const arrived = spot && SpotService.arrivedAt(spot, loc) ? spot : null;
            if (hunt && (arrived || (spot ? String(physical?.id ?? '') === String(spot.id) : plannedOn(physical?.id ?? null)))) {
                const look = groundLook(session, arrived || physical);
                if (look === 'rest') return { action: 'rest', reason: 'ground_needs_rest' };
                if (look === 'summon') return { action: 'summon', reason: 'ground_needs_pet' };
                return { action: 'search_locally', reason: look === 'raised' ? 'ground_unhuntable' : 'selected_hunting_ground' };
            }
            if (completedVisit) {
                // Its answer names no spot it may take: it asks once more (spot_empty), and
                // if that answer names none either it rests in town until a situation brings one.
                if (!spot) return DecisionEvents.needSpot(session) === 'none' ? { action: 'rest', reason: 'no_hunting_spot' }
                    : { action: 'search_locally', reason: 'no_hunting_route' };
                DecisionEvents.spotHeld(session);
            }
            if (!spot) {
                return { action: 'search_locally', reason: economy?.decided === false
                    ? 'awaiting_occupation_decision' : 'selected_hunting_ground' };
            }
            return { action: 'move_to_spot', reason: completedVisit ? 'return_to_hunting' : 'selected_hunting_ground', spot,
                // The errand's key keeps the walk (HuntingState defers an errand off ground).
                ...(occupied ? { deferredOccupation: occupationKey(leaf) } : {}) };
        }

        return {
            action: 'search_locally',
            reason: 'default'
        };
    }
};

module.exports = BotDecisionService;
