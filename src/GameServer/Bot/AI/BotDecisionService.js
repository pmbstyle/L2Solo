const SpotService = invoke('GameServer/Bot/AI/SpotService');

const MOVE_TO_SPOT_COOLDOWN = 15000;

function now() {
    return Date.now();
}

function canMoveToSpot(session) {
    return !session.lastSpotMoveAt || (now() - session.lastSpotMoveAt) > MOVE_TO_SPOT_COOLDOWN;
}

const BotDecisionService = {
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

        if (status.mode === 'hunting' && status.nearby.attackableNpcs === 0) {
            if (!canMoveToSpot(session)) {
                return {
                    action: 'search_locally',
                    reason: 'spot_move_cooldown'
                };
            }

            const candidate = SpotService.findBestSpot(status);
            if (candidate) {
                return {
                    action: 'move_to_spot',
                    reason: 'no_targets_nearby',
                    spot: candidate.spot,
                    score: candidate.score,
                    distance: candidate.distance,
                    levelGap: candidate.levelGap
                };
            }
        }

        if (status.mode === 'hunting' && status.blockers.includes('no_targets_nearby')) {
            const candidate = canMoveToSpot(session) ? SpotService.findBestSpot(status, { minDensity: 2 }) : null;
            if (candidate) {
                return {
                    action: 'move_to_spot',
                    reason: 'search_exhausted',
                    spot: candidate.spot,
                    score: candidate.score,
                    distance: candidate.distance,
                    levelGap: candidate.levelGap
                };
            }
        }

        return {
            action: 'search_locally',
            reason: 'default'
        };
    }
};

module.exports = BotDecisionService;
