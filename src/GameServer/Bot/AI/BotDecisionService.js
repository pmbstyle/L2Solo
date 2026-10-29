const SpotService = invoke('GameServer/Bot/AI/SpotService');
const DecisionEvents = invoke('GameServer/Bot/AI/DecisionEvents');
const DecisionSections = invoke('GameServer/Bot/Economy/DecisionSections');
const TownTransitPolicy = invoke('GameServer/Bot/AI/TownTransitPolicy');
const Karma = invoke('GameServer/Karma');

const MOVE_TO_SPOT_COOLDOWN = 15000;
const EMPTY_HUNT_SCANS = 3;

function occupationKey(leaf) {
    return JSON.stringify([leaf.activity, leaf.rootKey, leaf.kind, leaf.itemId, leaf.npcId,
        leaf.town, leaf.spotId, leaf.recipeId, leaf.sourceType]);
}

function now() {
    return Date.now();
}

function canMoveToSpot(session) {
    return !session.lastSpotMoveAt || (now() - session.lastSpotMoveAt) > MOVE_TO_SPOT_COOLDOWN;
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

        if (status.mode === 'hunting') {
            const economy = DecisionEvents.held(session);
            const leaf = economy?.network.activity;
            if (leaf?.activity && leaf.activity !== 'hunting') {
                // A deferred errand keeps its wish, but cannot pin a hunter
                // forever to ground where the expanded live scan found no
                // fight. Choose recovery ground using the actual body/kit.
                if (session.deferredOccupation === occupationKey(leaf) && Number(session.noTargetTicks || 0) >= EMPTY_HUNT_SCANS
                    && session.huntingTargetScan && !session.huntTargetScanPending
                    && canMoveToSpot(session)) {
                    session.lastSpotMoveAt = now();
                    const loc = physicalLocation(status, session);
                    const recoveryStatus = { ...status, loc, spot: SpotService.findCurrentSpot(loc) };
                    const recoveryOptions = {
                        spotRetryAfter: session.spotRetryAfter,
                        walkOnly: Karma.closesTowns(session.actor?.fetchKarma?.()),
                        allowEasierSpots: true,
                        equipment: session.actor?.backpack?.fetchItems?.(),
                        matchupProfiles: session.actor ? invoke('GameServer/Bot/AI/BotTargetMatchup').actorProfiles([session.actor]) : undefined
                    };
                    let candidate = SpotService.findBestSpot(recoveryStatus, recoveryOptions);
                    if (!candidate?.spot) {
                        candidate = SpotService.findBestSpot(recoveryStatus, { ...recoveryOptions,
                            minLevelGap: 1 - status.level, allowEasierSpots: false });
                    }
                    if (candidate?.spot) return { action: 'move_to_spot', reason: 'deferred_occupation_hunt',
                        spot: candidate.spot, deferredOccupation: session.deferredOccupation };
                }
                return { action: 'continue_occupation', reason: 'selected_occupation', activity: leaf.activity };
            }
            const loc = physicalLocation(status, session);
            const physical = SpotService.findCurrentSpot(loc);
            const stats = DecisionEvents.statsFor(session);
            const plannedOn = spotId => DecisionSections.occupationPlanned({ activity: 'hunting', spotId, stats }, leaf);
            // The cold planner may already have accepted a capacity detour.
            // Both arrival and a later return from town use that same ground;
            // a remembered currentSpot or an old status location is no arrival.
            if (leaf?.activity === 'hunting' && plannedOn(physical?.id ?? null)) {
                return { action: 'search_locally', reason: 'selected_hunting_ground' };
            }
            const standIn = stats.standIn;
            let spot = leaf?.activity === 'hunting' && standIn?.ground != null && plannedOn(standIn.ground)
                ? SpotService.findById(standIn.ground) : null;
            spot ||= leaf?.spotId ? SpotService.findById(leaf.spotId) : null;
            let reason = 'selected_hunting_ground';
            // An accepted empty decision is different from awaiting the first
            // worker answer. Once a town visit has ended, select the default
            // farm route; an empty target scan in the field still stays local.
            const completedVisit = !leaf && economy?.decided === true
                && (session.pendingFarmDepartureAnnouncement || TownTransitPolicy.townAt(loc));
            if (completedVisit) {
                if (!canMoveToSpot(session)) return { action: 'search_locally', reason: 'spot_move_cooldown' };
                const candidate = SpotService.findBestSpot({ ...status, loc, spot: physical }, {
                    spotRetryAfter: session.spotRetryAfter,
                    walkOnly: Karma.closesTowns(session.actor?.fetchKarma?.()),
                    allowEasierSpots: true,
                    equipment: session.actor?.backpack?.fetchItems?.(),
                    matchupProfiles: session.actor ? invoke('GameServer/Bot/AI/BotTargetMatchup').actorProfiles([session.actor]) : undefined
                });
                spot = candidate?.spot || null;
                reason = 'return_to_hunting';
                if (!spot) return { action: 'search_locally', reason: 'no_hunting_route' };
            }
            if (!spot) {
                return { action: 'search_locally', reason: economy?.decided === false
                    ? 'awaiting_occupation_decision' : 'selected_hunting_ground' };
            }
            if (Number(session.spotRetryAfter?.[spot.id] || 0) > now()) {
                return { action: 'search_locally', reason: 'planned_route_unavailable' };
            }
            if (!canMoveToSpot(session)) {
                return { action: 'search_locally', reason: 'spot_move_cooldown' };
            }
            return { action: 'move_to_spot', reason, spot };
        }

        return {
            action: 'search_locally',
            reason: 'default'
        };
    }
};

module.exports = BotDecisionService;
