const World = invoke('GameServer/World/World');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');
const PartyCombatState = invoke('GameServer/Bot/AI/PartyCombatState');
const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');

const PULL_SEARCH_RADIUS = 2200;
const PULL_CONTACT_DISTANCE = 260;
const PULL_RETURN_DISTANCE = 180;
const PULL_AGGRO_TIMEOUT_MS = 8000;
const PULL_MOVE_TARGET_DRIFT = 200;
const PULL_ABANDON_DISTANCE = 5000;
// This is a delivery radius, not the exact native hit range.  Once an
// incoming mob is this close to a melee companion, releasing the shared
// target lets the normal combat action close the final few steps instead of
// holding the entire party for coordinate-perfect overlap.
const PULL_DELIVERY_MELEE_DISTANCE = 250;
const PULL_DELIVERY_CAMP_DISTANCE = 350;
const PULL_UNREACHABLE_RETRY_MS = 30000;
const PULL_ROUTE_SEARCH_BATCH = 5;
const PULL_ROUTE_SEARCH_COOLDOWN_MS = 5000;
const PULL_SOCIAL_RISK_RADIUS = 320;

function point(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function distance(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    const dz = (a.locZ || 0) - (b.locZ || 0);
    return Math.sqrt((dx * dx) + (dy * dy) + (dz * dz));
}

function distance2d(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function enabled(settings) {
    return settings?.pullMode === 'bot' || settings?.pullMode === 'leader';
}

function pullerRank(actor) {
    const role = BotRoles.inferRole(actor);
    if (role === 'tank') return 0;
    if (role === 'dagger') return 1;
    if (role === 'dps') return 2;
    return Number.MAX_SAFE_INTEGER;
}

function resolvePuller(leaderSession, settings) {
    if (!enabled(settings) || !leaderSession?.actor) return null;
    if (settings.pullMode === 'leader') {
        return { session: leaderSession, actor: leaderSession.actor, kind: 'leader' };
    }

    const companions = PartyAwareness.partySessions(leaderSession)
        .filter((memberSession) => memberSession !== leaderSession)
        .filter((memberSession) => pullerRank(memberSession.actor) < Number.MAX_SAFE_INTEGER)
        .sort((a, b) => (
            pullerRank(a.actor) - pullerRank(b.actor) ||
            Number(a.actor.fetchId()) - Number(b.actor.fetchId())
        ));
    if (companions.length === 0) return null;

    const assignedId = Number(settings.pullerId || 0);
    const assigned = assignedId
        ? companions.find((memberSession) => Number(memberSession.actor.fetchId()) === assignedId)
        : companions[0];
    // A player-selected puller is an explicit order.  Do not silently hand it
    // to another melee companion when that bot leaves or dies.
    if (!assigned) return null;
    const selected = assigned;
    return { session: selected, actor: selected.actor, kind: 'bot' };
}

function pullState(leaderSession) {
    if (!leaderSession.partyPullState) leaderSession.partyPullState = {};
    return leaderSession.partyPullState;
}

function traceEncounter(leaderSession, event, details = {}) {
    const state = pullState(leaderSession);
    const fields = Object.entries({
        leader: leaderSession?.actor?.fetchName?.() || leaderSession?.actor?.fetchId?.(),
        encounter: state.encounterId,
        event,
        phase: state.phase,
        target: state.targetId,
        ...details
    }).filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : value}`)
        .join(' ');
    console.info('PartyEncounter :: %s', fields);
}

function npcById(id) {
    if (!id) return null;
    return (World.npc?.spawns || []).find((npc) => Number(npc.fetchId?.()) === Number(id)) || null;
}

function clearFinishedTarget(leaderSession) {
    const state = pullState(leaderSession);
    const npc = npcById(state.targetId);
    if (!state.targetId) return null;
    // The leader can relocate (teleport, town respawn, zone transfer) while a
    // pull target remains alive in the old region. Do not let that orphaned
    // id keep the party in combat or make a bot attack a despawned entity.
    if (!npc || npc.isDead?.() || distance(point(leaderSession.actor), point(npc)) > PULL_ABANDON_DISTANCE) {
        leaderSession.partyPullState = {};
        return null;
    }
    return npc;
}

function beginTarget(leaderSession, puller, target, source, selection = null) {
    const state = pullState(leaderSession);
    if (Number(state.targetId) === Number(target.fetchId())) return state;

    leaderSession.partyPullState = {
        targetId: target.fetchId(),
        pullerId: puller?.actor?.fetchId?.() || null,
        source,
        phase: source === 'bot' ? 'approach' : 'return',
        startedAt: Date.now(),
        announced: false,
        encounterId: `${leaderSession.actor.fetchId()}:${target.fetchId()}:${Date.now()}`,
        selectionScore: selection?.score ?? null,
        selectionReasons: selection?.reasons || []
    };
    traceEncounter(leaderSession, selection?.event || 'selected', {
        source,
        score: selection?.score,
        reasons: selection?.reasons || []
    });
    return leaderSession.partyPullState;
}

function observeLeaderTarget(leaderSession, settings, targetId) {
    const puller = resolvePuller(leaderSession, settings);
    if (!puller || puller.kind !== 'leader' || !targetId) return null;
    const target = npcById(targetId);
    if (!target || !target.fetchAttackable?.() || target.isDead?.()) return null;
    beginTarget(leaderSession, puller, target, 'leader');
    return target;
}

function supportMembers(leaderSession, puller) {
    return PartyAwareness.partySessions(leaderSession).map((memberSession) => ({
        actor: memberSession.actor,
        leader: memberSession === leaderSession,
        puller: memberSession.actor === puller?.actor
    }));
}

// The human leader is a recipient, not an autonomous provider.  They may
// know support skills, but only companion sessions run the support AI.
function supportProviders(leaderSession) {
    return PartyAwareness.partySessions(leaderSession)
        .filter((memberSession) => memberSession !== leaderSession)
        .map((memberSession) => memberSession.actor)
        .filter(Boolean);
}

function pauseReason(leaderSession, puller) {
    const state = pullState(leaderSession);
    if (invoke('GameServer/Bot/AI/PartyCompanionService').regroupActive(leaderSession)) return 'party_regrouping';
    if (leaderSession?.actor?.isDead?.()) return 'party_revival';
    const recovery = leaderSession?.partyRecoveryCast;
    if (Number(recovery?.expiresAt || 0) > Date.now()) return 'party_recharging';
    if (recovery) delete leaderSession.partyRecoveryCast;
    // Do not select a new target while the camp is already handling an add.
    // The current shared pull target is the sole exception: it remains the
    // party's intended fight from first aggro until it dies.
    const combat = PartyCombatState.combatState(leaderSession, {
        ignoreTravellingPuller: true,
        ignoreTargetIds: state.targetId ? [state.targetId] : []
    });
    if (combat.active) return 'party_under_attack';

    const members = PartyAwareness.partySessions(leaderSession);
    const seatedMembers = members.filter((memberSession) => (
        memberSession.actor?.state?.fetchSeated?.() === true
    ));
    const pullerIsSeated = puller?.actor?.state?.fetchSeated?.() === true;
    // A single support companion may sit briefly without halting the camp.
    // Stop only when the designated puller is regenerating or a material
    // fraction of the whole party is seated at the same time. Plans and low
    // HP/MP are intentionally not signals here: both can outlive the action.
    if (pullerIsSeated || (members.length > 0 && seatedMembers.length / members.length > 0.4)) {
        return 'party_recovering';
    }

    const membersForSupport = supportMembers(leaderSession, puller);
    if (BotSupportPlanner.hasPendingAction(
        membersForSupport,
        supportProviders(leaderSession)
    )) {
        return 'party_buffing';
    }
    return null;
}

function cancelForRevival(leaderSession) {
    if (!leaderSession?.partyPullState || Object.keys(leaderSession.partyPullState).length === 0) return false;
    leaderSession.partyPullState = {};
    return true;
}

function attackRange(actor, target) {
    const role = BotRoles.inferRole(actor);
    const combat = BotCombatUtility.select(actor, target, role);
    const skillRange = Number(combat?.range);
    // This predicate decides whether normal combat may begin, rather than
    // whether its first selected skill can land in place.  A melee skill may
    // have a native 40-50 range, but once the mob reaches the delivery radius
    // BotAI.executeCombat will close that final distance itself.  Otherwise a
    // ready Power Strike can make the party hold a successfully delivered mob
    // forever. Preserve longer spell/archer ranges for actual ranged combat.
    const baselineRange = role === 'archer' ? 700 : PULL_DELIVERY_MELEE_DISTANCE;
    return Number.isFinite(skillRange) ? Math.max(baselineRange, skillRange) : baselineRange;
}

function actorCanEngage(actor, target) {
    // Combat ranges are horizontal.  World/map Z may temporarily differ while
    // a mob is traversing a slope, and treating that as distance made a mob at
    // the camp remain permanently "not delivered".
    return !!actor && !!target && distance2d(point(actor), point(target)) <= attackRange(actor, target);
}

function canDeliverPull(actor, target) {
    // Support roles use only their basic attack once the target is delivered,
    // but they still need to release a player-led pull when they are the only
    // companions in range.
    return actorCanEngage(actor, target);
}

function targetIsEngageable(leaderSession, target, puller, { includePuller = false } = {}) {
    if (!target) return false;
    return PartyAwareness.partyActors(leaderSession)
        // A leader pull has no return phase to synchronize. Release only when
        // a companion can actually strike the player-designated target.
        .filter((actor) => actor !== leaderSession.actor && (includePuller || actor !== puller?.actor))
        .some((actor) => canDeliverPull(actor, target));
}

function targetDeliveredToCamp(leaderSession, target) {
    return !!leaderSession?.actor && !!target &&
        distance2d(point(leaderSession.actor), point(target)) <= PULL_DELIVERY_CAMP_DISTANCE;
}

function travellingPullerAwayFromCamp(leaderSession, pulling) {
    return pulling?.enabled === true &&
        pulling.puller?.kind === 'bot' &&
        ['approach', 'aggro', 'return'].includes(pulling.phase) &&
        !!leaderSession?.actor &&
        distance2d(point(pulling.puller.actor), point(leaderSession.actor)) > PULL_RETURN_DISTANCE;
}

function hasDeadPartyMember(leaderSession) {
    return (World.user?.sessions || []).some((memberSession) => (
        PartyAwareness.isPartySession(memberSession, leaderSession) &&
        memberSession.actor?.isDead?.() === true
    ));
}

function rejectedTargetUntil(leaderSession, targetId) {
    return Number(leaderSession.partyPullRejectedTargets?.[targetId] || 0);
}

function rejectTarget(leaderSession, target) {
    const now = Date.now();
    const rejected = leaderSession.partyPullRejectedTargets || {};
    Object.keys(rejected).forEach((targetId) => {
        if (Number(rejected[targetId]) <= now) delete rejected[targetId];
    });
    rejected[target.fetchId()] = now + PULL_UNREACHABLE_RETRY_MS;
    leaderSession.partyPullRejectedTargets = rejected;
    leaderSession.partyPullState = {};
}

function partyReferenceLevel(leaderSession) {
    const levels = PartyAwareness.partyActors(leaderSession)
        .map((actor) => Number(actor.fetchLevel?.() || 0))
        .filter((level) => level > 0)
        .sort((a, b) => a - b);
    if (levels.length === 0) return Number(leaderSession?.actor?.fetchLevel?.() || 1);
    return levels[Math.floor((levels.length - 1) / 2)];
}

function socialRisk(target) {
    const clan = String(target.fetchClanName?.() || '').trim();
    const helpRadius = Math.max(0, Number(target.fetchClanHelpRadius?.()) || 0);
    const radius = Math.max(PULL_SOCIAL_RISK_RADIUS, helpRadius);
    const nearby = World.fetchNpcsInRadius(target.fetchLocX(), target.fetchLocY(), radius)
        .filter((npc) => npc !== target && npc.fetchAttackable?.() && !npc.isDead?.() && !npc.fetchDestId?.());
    const socialAllies = clan && helpRadius > 0
        ? nearby.filter((npc) => (
            String(npc.fetchClanName?.() || '').trim() === clan &&
            distance2d(point(target), point(npc)) <= helpRadius
        )).length
        : 0;
    const crowd = nearby.filter((npc) => distance2d(point(target), point(npc)) <= PULL_SOCIAL_RISK_RADIUS).length;
    return { socialAllies, crowd };
}

function scorePullTarget(bot, leaderSession, npc) {
    const referenceLevel = partyReferenceLevel(leaderSession);
    const targetLevel = Number(npc.fetchLevel?.() || referenceLevel);
    const levelGap = Math.abs(targetLevel - referenceLevel);
    const risk = socialRisk(npc);
    const campDistance = distance2d(point(leaderSession.actor), point(npc));
    const approachDistance = distance2d(point(bot), point(npc));
    const score = Math.round(1000 - levelGap * 110 - risk.socialAllies * 240 - risk.crowd * 60 - campDistance / 6 - approachDistance / 12);
    const reasons = [
        `level_gap:${levelGap}`,
        `social:${risk.socialAllies}`,
        `crowd:${risk.crowd}`,
        `camp:${Math.round(campDistance)}`
    ];
    return { target: npc, score, reasons };
}

function freeMonsters(bot) {
    return World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), PULL_SEARCH_RADIUS)
        .filter((npc) => npc.fetchAttackable?.() && !npc.isDead?.())
        .filter((npc) => !npc.fetchDestId?.())
        .sort((a, b) => distance(point(bot), point(a)) - distance(point(bot), point(b)));
}

function nearestFreeMonster(bot, leaderSession) {
    const now = Date.now();
    return freeMonsters(bot)
        .filter((npc) => rejectedTargetUntil(leaderSession, npc.fetchId()) <= now)
        .map((npc) => scorePullTarget(bot, leaderSession, npc))
        .sort((a, b) => b.score - a.score || distance(point(bot), point(a.target)) - distance(point(bot), point(b.target)))[0] || null;
}

function incomingMobOnPuller(bot) {
    return (World.npc?.spawns || [])
        .filter((npc) => npc.fetchAttackable?.() && !npc.isDead?.())
        .filter((npc) => Number(npc.fetchDestId?.()) === Number(bot.fetchId()))
        .filter((npc) => distance(point(bot), point(npc)) <= PULL_ABANDON_DISTANCE)
        .sort((a, b) => distance(point(bot), point(a)) - distance(point(bot), point(b)))[0] || null;
}

function announceNoReachableTargets(session) {
    return BotPartyChat.announce(session, {
        priority: 'coordination',
        dedupeMs: 30000,
        key: `pull-no-route:${session.actor.fetchId()}`,
        templates: [
            "I can't find a safe route to the nearby mobs. Holding here.",
            'No reachable pull target from here. Waiting for a better route.'
        ]
    });
}

function shouldKeepPullMove(session, bot, state, phase, target) {
    if (!state?.moveTarget || state.movePhase !== phase) return false;
    if (!(session.moveTimer || bot.state?.fetchTowards?.())) return false;
    // Follow-state samples are intentionally coarse and can report a moving
    // puller as "stuck" between path waypoints.  Replanning from that stale
    // sample aborts the current route and makes the client snap backwards.
    // Pull movement is server-stepped, so retain it until it stops or the
    // target has materially moved.
    if (session.stuckTicks) {
        session.stuckTicks = 0;
        session.lastStuckSampleAt = Date.now();
    }
    // The leader can cover more than the normal target-drift threshold while
    // a puller is returning. Replanning mid-route aborts the server movement
    // after the client has already rendered it, which looks like a snap back.
    // Finish the active return leg, then take a fresh formation target.
    if (phase === 'return') return true;
    return distance(state.moveTarget, point(target)) <= PULL_MOVE_TARGET_DRIFT;
}

function moveTo(session, bot, state, phase, target) {
    if (shouldKeepPullMove(session, bot, state, phase, target)) {
        return { started: false, unreachable: false };
    }
    // FollowingState leaves active pull movement to this coordinator. A new
    // route is only needed after the old one stopped or its target drifted.
    state.movePhase = phase;
    state.moveTarget = point(target);
    const previousDiagnostics = session.lastPathfinding;
    if (phase === 'approach') {
        bot.moveTo({ from: point(bot), to: point(target), previewOnly: true });
    }
    const diagnostics = session.lastPathfinding;
    const requestedDistance = distance(point(bot), point(target));
    const unreachable = phase === 'approach' &&
        requestedDistance > PULL_CONTACT_DISTANCE &&
        diagnostics && diagnostics !== previousDiagnostics &&
        diagnostics?.lowLodWarp !== true &&
        diagnostics?.routeUsable === false;
    if (!unreachable) {
        bot.moveTo({ from: point(bot), to: point(target) });
    }
    return { started: true, unreachable };
}

function clearPullMove(state) {
    delete state.movePhase;
    delete state.moveTarget;
}

function aggroActionInFlight(bot) {
    return !!(
        bot.state?.fetchTowards?.() ||
        bot.state?.fetchHits?.() ||
        bot.state?.fetchCasts?.()
    );
}

function tickBotPuller(session, bot, leaderSession, settings, Generics, BotAI, searchAttempts = 0) {
    const puller = resolvePuller(leaderSession, settings);
    if (!puller || puller.session !== session) return { handled: false, puller };

    let target = clearFinishedTarget(leaderSession);
    let state = pullState(leaderSession);
    // Any mob that has already committed to the travelling puller is a valid
    // delivery. Adopt it and return immediately instead of treating its aggro
    // as a reason to freeze beside the original target.
    const incoming = ['approach', 'aggro'].includes(state.phase)
        ? incomingMobOnPuller(bot)
        : null;
    if (incoming) {
        const switchedTarget = Number(incoming.fetchId()) !== Number(target?.fetchId?.());
        if (switchedTarget) {
            beginTarget(leaderSession, puller, incoming, 'bot', { event: 'adopted_incoming_add', reasons: ['already_targeting_puller'] });
            state = pullState(leaderSession);
            target = incoming;
        }
        bot.attack?.abortCast?.(session, bot);
        bot.attack?.clearTimers?.();
        bot.state?.setHits?.(false);
        bot.state?.setCasts?.(false);
        bot.automation?.abortAll?.(bot);
        clearPullMove(state);
        state.phase = 'return';
        if (!state.announced) {
            state.announced = true;
            BotPartyChat.announce(session, {
                priority: 'coordination',
                key: `pull-aggro:${incoming.fetchId()}`,
                templates: [
                    `${incoming.fetchName()} is on me. Bringing it back.`,
                    `Got aggro from ${incoming.fetchName()} — returning to camp.`
                ]
            });
        }
    }
    // A native basic attack repeats until explicitly stopped. Once the
    // opening hit has transferred aggro to the puller, returning to camp must
    // win over an unrelated add pause; otherwise the tank keeps auto-attacking
    // at the pull spot while the rest of the party handles the add.
    const aggroConfirmed = state.phase === 'aggro' && target &&
        Number(target.fetchDestId?.()) === Number(bot.fetchId());
    if (aggroConfirmed) {
        bot.attack?.clearTimers?.();
        bot.state?.setHits?.(false);
        clearPullMove(state);
        state.phase = 'return';
        traceEncounter(leaderSession, 'aggro_confirmed');
    }

    // Recovery/add pauses may cancel an approach or an unconfirmed opening
    // hit, but must never interrupt a confirmed return leg.
    const pause = state.phase === 'return' ? null : pauseReason(leaderSession, puller);
    if (pause) {
        // A rest/buff pause can happen while the puller is still travelling
        // towards an untouched mob.  Stop that movement immediately instead
        // of letting its existing automation carry it out of the group.
        if (state.phase === 'approach') {
            bot.automation?.abortAll?.(bot);
            clearPullMove(state);
        }
        // An aggro request has not landed yet, so it must not finish while the
        // party is paused.  Once it has landed, preserve the shared target and
        // let the party resume its return/engage flow after recovery.
        if (state.phase === 'aggro') {
            const target = npcById(state.targetId);
            const aggroConfirmed = Number(target?.fetchDestId?.()) === Number(bot.fetchId());
            if (!aggroConfirmed) {
                bot.attack?.abortCast?.(session, bot);
                bot.attack?.clearTimers?.();
                bot.state?.setHits?.(false);
                bot.state?.setCasts?.(false);
                bot.automation?.abortAll?.(bot);
                state.phase = 'approach';
                state.aggroRequestedAt = undefined;
            }
        }
        return { handled: true, puller, paused: pause };
    }

    if (!target) {
        // Do not let the puller win the scheduler race immediately after a
        // resurrection. The next revival target must be selected before the
        // party starts another encounter, while an already active encounter is
        // still allowed to finish normally.
        if (hasDeadPartyMember(leaderSession)) {
            return { handled: true, puller, action: 'party_revival' };
        }
        if (Number(leaderSession.partyPullSearchRetryAt || 0) > Date.now()) {
            return { handled: true, puller, action: 'route_search_cooldown' };
        }
        const selection = nearestFreeMonster(bot, leaderSession);
        target = selection?.target || null;
        if (!target) {
            const rejectedNearby = freeMonsters(bot)
                .some((npc) => rejectedTargetUntil(leaderSession, npc.fetchId()) > Date.now());
            if (rejectedNearby) {
                leaderSession.partyPullSearchRetryAt = Date.now() + PULL_ROUTE_SEARCH_COOLDOWN_MS;
                announceNoReachableTargets(session);
                return { handled: true, puller, action: 'no_reachable_targets' };
            }
            return { handled: true, puller, idle: true };
        }
        leaderSession.partyPullSearchRetryAt = undefined;
        beginTarget(leaderSession, puller, target, 'bot', selection);
        state = pullState(leaderSession);
    }

    if (state.phase === 'approach') {
        if (distance(point(bot), point(target)) > PULL_CONTACT_DISTANCE) {
            const movement = moveTo(session, bot, state, 'approach', target);
            if (movement.unreachable) {
                bot.automation?.abortAll?.(bot);
                rejectTarget(leaderSession, target);
                if (searchAttempts + 1 < PULL_ROUTE_SEARCH_BATCH) {
                    return tickBotPuller(session, bot, leaderSession, settings, Generics, BotAI, searchAttempts + 1);
                }
                return { handled: true, puller, action: 'searching_reachable_target', target };
            }
            return { handled: true, puller, action: 'approach', target };
        }

        // The approach movement has its own scheduled action. Stop it before
        // starting the native attack; otherwise its later completion can race
        // the cast and the return move would cancel the hit before it lands.
        bot.automation?.abortAll?.(bot);
        clearPullMove(state);
        bot.select({ id: target.fetchId() });
        // The opening pull hit favors a reliable instant attack over damage or
        // taunt. A failed/cooldown skill must not delay the mob starting to
        // chase the puller.
        BotAI.executeCombat(session, bot, target, Generics, { basicAttackOnly: true });
        // AttackExec schedules the native hit asynchronously. Do
        // not issue moveTo yet: MoveTo aborts automation and would cancel the
        // very hit that is supposed to put the mob into combat.
        state.phase = 'aggro';
        state.aggroRequestedAt = Date.now();
        traceEncounter(leaderSession, 'aggro_requested');
        if (!state.announced) {
            state.announced = true;
            BotPartyChat.announce(session, {
                priority: 'coordination',
                key: `pull:${target.fetchId()}`,
                templates: [
                    `Pulling ${target.fetchName()} to camp.`,
                    `Bringing ${target.fetchName()} back — hold camp.`
                ]
            });
        }
        return { handled: true, puller, action: 'aggro', target };
    }

    if (state.phase === 'aggro') {
        const aggroConfirmed = Number(target.fetchDestId?.()) === Number(bot.fetchId());
        const waitingForHit = Date.now() - Number(state.aggroRequestedAt || 0) < PULL_AGGRO_TIMEOUT_MS;
        if (!aggroConfirmed && (aggroActionInFlight(bot) || waitingForHit)) {
            return { handled: true, puller, action: 'wait_for_aggro', target };
        }
        if (!aggroConfirmed) {
            // An interrupted/missed attempt must not make the puller abandon
            // the mob. Re-enter approach and issue a new native attack.
            state.phase = 'approach';
            clearPullMove(state);
            return { handled: true, puller, action: 'retry_aggro', target };
        }
        state.phase = 'return';
        traceEncounter(leaderSession, 'aggro_confirmed');
    }

    if (state.phase === 'return' && distance(point(bot), point(leaderSession.actor)) > PULL_RETURN_DISTANCE) {
        moveTo(session, bot, state, 'return', leaderSession.actor);
        return { handled: true, puller, action: 'return', target };
    }

    if (state.phase === 'return') {
        // The puller is back at the camp. The mob is now delivered even when
        // melee formation offsets put every companion just outside its first
        // attack radius; normal assist movement can finish the engagement.
        clearPullMove(state);
        state.phase = 'engage';
        traceEncounter(leaderSession, 'delivered', {
            durationMs: Date.now() - Number(state.startedAt || Date.now())
        });
        return { handled: false, puller, target };
    }

    if (state.phase === 'engage') {
        // The shared target has been delivered. Fall through to the ordinary
        // party combat logic on every subsequent tick so the puller keeps
        // attacking and holding aggro until the mob dies.
        return { handled: false, puller, target };
    }

    return { handled: true, puller, action: 'wait_for_mob', target };
}

function current(leaderSession, settings) {
    const puller = resolvePuller(leaderSession, settings);
    if (!puller) return { enabled: false, puller: null, target: null, paused: null };
    const target = clearFinishedTarget(leaderSession);
    const state = pullState(leaderSession);
    // Keep the formation around the leader until an aggroed mob itself reaches
    // the camp. Once it is there, the party must attack immediately rather
    // than wait for the puller to complete a separate return tick: otherwise
    // the delivered mob can hit the leader before anyone reacts.
    const pullerBackAtCamp = puller.actor && leaderSession?.actor &&
        distance2d(point(puller.actor), point(leaderSession.actor)) <= PULL_RETURN_DISTANCE;
    const engageable = state.source === 'bot'
        ? state.phase === 'engage' || (
            state.phase === 'return' &&
            pullerBackAtCamp &&
            targetDeliveredToCamp(leaderSession, target)
        )
        : targetIsEngageable(leaderSession, target, puller);
    return {
        enabled: true,
        puller,
        target,
        paused: pauseReason(leaderSession, puller),
        engageable,
        phase: state.phase || null,
        selectionScore: state.selectionScore ?? null,
        selectionReasons: state.selectionReasons || []
    };
}

module.exports = {
    enabled,
    resolvePuller,
    supportMembers,
    supportProviders,
    observeLeaderTarget,
    tickBotPuller,
    current,
    targetIsEngageable,
    targetDeliveredToCamp,
    travellingPullerAwayFromCamp,
    actorCanEngage,
    canDeliverPull,
    hasDeadPartyMember,
    attackRange,
    scorePullTarget,
    cancelForRevival,
    PULL_AGGRO_TIMEOUT_MS
};
