const World = invoke('GameServer/World/World');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const BotSupportPlanner = invoke('GameServer/Bot/AI/BotSupportPlanner');
const PartyAwareness = invoke('GameServer/Bot/AI/PartyAwareness');

const PULL_SEARCH_RADIUS = 2200;
const PULL_CONTACT_DISTANCE = 260;
const PULL_RETURN_DISTANCE = 180;
const PULL_AGGRO_TIMEOUT_MS = 8000;

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

function npcById(id) {
    if (!id) return null;
    return (World.npc?.spawns || []).find((npc) => Number(npc.fetchId?.()) === Number(id)) || null;
}

function clearFinishedTarget(leaderSession) {
    const state = pullState(leaderSession);
    const npc = npcById(state.targetId);
    if (!state.targetId) return null;
    if (!npc || npc.isDead?.()) {
        leaderSession.partyPullState = {};
        return null;
    }
    return npc;
}

function beginTarget(leaderSession, puller, target, source) {
    const state = pullState(leaderSession);
    if (Number(state.targetId) === Number(target.fetchId())) return state;

    leaderSession.partyPullState = {
        targetId: target.fetchId(),
        pullerId: puller?.actor?.fetchId?.() || null,
        source,
        phase: source === 'bot' ? 'approach' : 'return',
        startedAt: Date.now(),
        announced: false
    };
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
    const members = PartyAwareness.partySessions(leaderSession);
    if (members.some((memberSession) => (
        memberSession !== leaderSession && (
            memberSession.actor?.state?.fetchSeated?.() ||
            memberSession.plan === 'resting' ||
            memberSession.plan === 'getting_buffed'
        )
    ))) {
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

function attackRange(actor, target) {
    const role = BotRoles.inferRole(actor);
    const combat = BotCombatUtility.select(actor, target, role);
    if (Number.isFinite(Number(combat?.range))) return Number(combat.range);

    // This is the same fallback used by BotAI.executeCombat: archers pass a
    // ranged basic attack, while every other role uses the native melee
    // attack, whose scheduled range is zero.
    return role === 'archer' ? 700 : 0;
}

function targetIsEngageable(leaderSession, target, puller) {
    if (!target) return false;
    return PartyAwareness.partyActors(leaderSession)
        // A leader pull has no return phase to synchronize. Release only when
        // a companion can actually strike the player-designated target.
        .filter((actor) => actor !== leaderSession.actor && actor !== puller?.actor)
        .some((actor) => distance(point(actor), point(target)) <= attackRange(actor, target));
}

function nearestFreeMonster(bot) {
    return World.fetchNpcsInRadius(bot.fetchLocX(), bot.fetchLocY(), PULL_SEARCH_RADIUS)
        .filter((npc) => npc.fetchAttackable?.() && !npc.isDead?.())
        .filter((npc) => !npc.fetchDestId?.())
        .sort((a, b) => distance(point(bot), point(a)) - distance(point(bot), point(b)))[0] || null;
}

function moveTo(session, bot, target) {
    bot.moveTo({ from: point(bot), to: point(target) });
}

function aggroActionInFlight(bot) {
    return !!(
        bot.state?.fetchTowards?.() ||
        bot.state?.fetchHits?.() ||
        bot.state?.fetchCasts?.()
    );
}

function tickBotPuller(session, bot, leaderSession, settings, Generics, BotAI) {
    const puller = resolvePuller(leaderSession, settings);
    if (!puller || puller.session !== session) return { handled: false, puller };

    const pause = pauseReason(leaderSession, puller);
    if (pause) {
        const state = pullState(leaderSession);
        // A rest/buff pause can happen while the puller is still travelling
        // towards an untouched mob.  Stop that movement immediately instead
        // of letting its existing automation carry it out of the group.
        if (state.phase === 'approach') {
            bot.automation?.abortAll?.(bot);
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

    let target = clearFinishedTarget(leaderSession);
    if (!target) {
        target = nearestFreeMonster(bot);
        if (!target) return { handled: true, puller, idle: true };
        beginTarget(leaderSession, puller, target, 'bot');
    }

    const state = pullState(leaderSession);
    if (state.phase === 'approach') {
        if (distance(point(bot), point(target)) > PULL_CONTACT_DISTANCE) {
            moveTo(session, bot, target);
            return { handled: true, puller, action: 'approach', target };
        }

        // The approach movement has its own scheduled action. Stop it before
        // starting the native attack; otherwise its later completion can race
        // the cast and the return move would cancel the hit before it lands.
        bot.automation?.abortAll?.(bot);
        bot.select({ id: target.fetchId() });
        const aggression = BotRoles.inferRole(bot) === 'tank' ? BotSkillCapabilities.aggressionSkill(bot) : null;
        if (aggression && bot.fetchMp() >= aggression.fetchConsumedMp()) {
            Generics.skillExec(session, bot, { id: target.fetchId(), selfId: aggression.fetchSelfId(), ctrl: true });
        } else {
            BotAI.executeCombat(session, bot, target, Generics);
        }
        // AttackExec/SkillExec schedules the native hit asynchronously.  Do
        // not issue moveTo yet: MoveTo aborts automation and would cancel the
        // very hit that is supposed to put the mob into combat.
        state.phase = 'aggro';
        state.aggroRequestedAt = Date.now();
        if (!state.announced) {
            state.announced = true;
            BotAI.say(session, `Pulling ${target.fetchName()} to the party!`);
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
            return { handled: true, puller, action: 'retry_aggro', target };
        }
        state.phase = 'return';
    }

    if (state.phase === 'return' && distance(point(bot), point(leaderSession.actor)) > PULL_RETURN_DISTANCE) {
        moveTo(session, bot, leaderSession.actor);
        return { handled: true, puller, action: 'return', target };
    }

    if (state.phase === 'return') {
        // The puller is back at the camp. The mob is now delivered even when
        // melee formation offsets put every companion just outside its first
        // attack radius; normal assist movement can finish the engagement.
        state.phase = 'engage';
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
    // A bot-pulled mob must not release the party merely because it is within
    // the puller's own attack range.  Only tickBotPuller may promote it to the
    // engage phase after returning to the group.
    const engageable = state.source === 'bot'
        ? state.phase === 'engage'
        : targetIsEngageable(leaderSession, target, puller);
    return {
        enabled: true,
        puller,
        target,
        paused: pauseReason(leaderSession, puller),
        engageable,
        phase: state.phase || null
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
    attackRange,
    PULL_AGGRO_TIMEOUT_MS
};
