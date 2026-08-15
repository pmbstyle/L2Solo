const VISIBILITY_RADIUS = 6000;
const FULL_ENTER_RADIUS = 3500;
const FULL_EXIT_RADIUS = 4000;
const PROMOTION_HOLD_MS = 8000;
const PLAYER_THREAT_HOLD_MS = 10000;
const FULL_AMBIENT_TICK_MS = 3000;
const FAR_VISIBLE_TICK_MS = 7000;
const PRELOAD_TICK_MS = 30000;
const FAR_VISIBLE_STATUS_MS = 15000;
const FULL_STATUS_MS = 3000;
const FAR_VISIBLE_TICK_BUDGET_MS = 6;

function isBotSession(session) {
    return !!session?.accountId && String(session.accountId).startsWith('bot_');
}

function isRealPlayerSession(session) {
    return !!(
        session?.actor?.fetchIsOnline?.() === true &&
        session.accountId &&
        !isBotSession(session)
    );
}

function actorId(actor) {
    return Number(actor?.fetchId?.() || 0);
}

function distance2d(first, second) {
    if (!first || !second) return Infinity;
    const dx = Number(first.fetchLocX?.()) - Number(second.fetchLocX?.());
    const dy = Number(first.fetchLocY?.()) - Number(second.fetchLocY?.());
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return Infinity;
    return Math.sqrt((dx * dx) + (dy * dy));
}

function stateFor(session) {
    session.hotActorLod ||= {
        tier: 'preload',
        reason: 'initial',
        promotedUntil: 0,
        lastPromotionReason: null,
        lastStatusAt: 0
    };
    return session.hotActorLod;
}

function stats(values) {
    if (!values.length) return { count: 0, avgMs: 0, p95Ms: 0, maxMs: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((total, value) => total + value, 0);
    return {
        count: sorted.length,
        avgMs: Math.round(sum / sorted.length),
        p95Ms: Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
        maxMs: Math.round(sorted[sorted.length - 1])
    };
}

const telemetry = {
    counters: {
        fullTicks: 0,
        visibleTicks: 0,
        preloadTicks: 0,
        deferrals: 0,
        promotions: 0,
        statusRefreshes: 0,
        packetBroadcasts: 0,
        packetSkips: 0,
        packetRecipients: 0,
        packetBytes: 0
    },
    last: {},
    tickDurations: [],
    statusDurations: [],
    subsystems: new Map()
};

function increment(name, count = 1) {
    telemetry.counters[name] = Number(telemetry.counters[name] || 0) + Math.max(0, Number(count) || 0);
}

function promote(session, reason = 'player_interaction', now = Date.now()) {
    if (!session) return false;
    const state = stateFor(session);
    const wasPromoted = Number(state.promotedUntil || 0) > now;
    const changedReason = state.lastPromotionReason !== reason;
    state.promotedUntil = Math.max(Number(state.promotedUntil || 0), now + PROMOTION_HOLD_MS);
    state.lastPromotionReason = reason;
    state.reason = reason;
    if (!wasPromoted || changedReason) increment('promotions');
    return true;
}

function playerContext(session, realPlayers, now) {
    const bot = session?.actor;
    if (!bot) return null;
    if (session.partyCompanion === true && session.followPlayerSession) return 'player_party';
    if (session.chatArrivalActive || session.inConversation || session.activeTrade || session.pendingPartyInvite) return 'player_interaction';

    const botId = actorId(bot);
    const currentTargetId = Number(session.currentTargetId || bot.fetchDestId?.() || 0);
    const incomingThreatId = Number(session.incomingThreatId || 0);
    const incomingRecent = now - Number(session.incomingThreatAt || 0) <= PLAYER_THREAT_HOLD_MS;
    for (const playerSession of realPlayers) {
        const player = playerSession.actor;
        const playerId = actorId(player);
        if (playerId && currentTargetId === playerId) return 'player_target';
        if (playerId && incomingRecent && incomingThreatId === playerId) return 'player_damage';
        if (botId && Number(player.fetchDestId?.() || 0) === botId) return 'player_selected';
    }
    return null;
}

function evaluate(session, sessions = [], now = Date.now()) {
    const bot = session?.actor;
    const state = stateFor(session);
    const realPlayers = (Array.isArray(sessions) ? sessions : []).filter(isRealPlayerSession);
    const nearestDistance = realPlayers.reduce((nearest, playerSession) => (
        Math.min(nearest, distance2d(bot, playerSession.actor))
    ), Infinity);
    const context = playerContext(session, realPlayers, now);
    if (context) promote(session, context, now);
    const visibleCombat = nearestDistance <= VISIBILITY_RADIUS && !!(
        bot?.state?.fetchHits?.() || bot?.state?.fetchCasts?.() || bot?.state?.fetchCombats?.()
    );
    if (visibleCombat) promote(session, 'visible_combat', now);

    const heldPromotion = Number(state.promotedUntil || 0) > now;
    let tier;
    let reason;
    if (heldPromotion) {
        tier = 'full';
        reason = state.lastPromotionReason || 'promotion_hold';
    } else if (nearestDistance <= FULL_ENTER_RADIUS || (state.tier === 'full' && nearestDistance <= FULL_EXIT_RADIUS)) {
        tier = 'full';
        reason = state.tier === 'full' && nearestDistance > FULL_ENTER_RADIUS ? 'distance_hysteresis' : 'near_player';
    } else if (nearestDistance <= VISIBILITY_RADIUS) {
        tier = 'visible';
        reason = 'far_visible';
    } else {
        tier = 'preload';
        reason = realPlayers.length ? 'outer_preload' : 'no_real_players';
    }
    state.tier = tier;
    state.reason = reason;
    state.nearestPlayerDistance = Number.isFinite(nearestDistance) ? Math.round(nearestDistance) : null;
    state.evaluatedAt = now;
    return { tier, reason, nearestPlayerDistance: nearestDistance, promotedUntil: Number(state.promotedUntil || 0), highRisk: heldPromotion };
}

function nextTickDelay(session, context, random = Math.random) {
    if (!context || context.tier === 'preload') return PRELOAD_TICK_MS;
    if (context.tier === 'visible') return FAR_VISIBLE_TICK_MS;
    if (context.highRisk || context.nearestPlayerDistance <= 1200) return 1000 + random() * 200;
    return FULL_AMBIENT_TICK_MS;
}

function shouldRefreshStatus(session, context, now = Date.now()) {
    if (!session || context?.tier === 'preload') return false;
    const state = stateFor(session);
    const interval = context?.tier === 'visible' ? FAR_VISIBLE_STATUS_MS : FULL_STATUS_MS;
    return !session.botStatus || now - Number(state.lastStatusAt || 0) >= interval;
}

function recordStatusRefresh(session, durationMs, now = Date.now()) {
    stateFor(session).lastStatusAt = now;
    increment('statusRefreshes');
    telemetry.statusDurations.push(Math.max(0, Number(durationMs) || 0));
    if (telemetry.statusDurations.length > 512) telemetry.statusDurations.shift();
}

function budgetExceeded(context, tickStartedAt, now = Date.now()) {
    return context?.tier === 'visible' && now - tickStartedAt >= FAR_VISIBLE_TICK_BUDGET_MS;
}

function recordDeferral() { increment('deferrals'); }

function recordTick(tier, durationMs) {
    increment(tier === 'full' ? 'fullTicks' : tier === 'visible' ? 'visibleTicks' : 'preloadTicks');
    telemetry.tickDurations.push(Math.max(0, Number(durationMs) || 0));
    if (telemetry.tickDurations.length > 1024) telemetry.tickDurations.shift();
}

function recordPacketBroadcast(recipients, bytes) {
    const count = Math.max(0, Number(recipients) || 0);
    if (!count) { increment('packetSkips'); return; }
    increment('packetBroadcasts');
    increment('packetRecipients', count);
    increment('packetBytes', Math.max(0, Number(bytes) || 0) * count);
}

function recordSubsystem(name, durationMs, items = 0) {
    const key = String(name || 'unknown');
    const entry = telemetry.subsystems.get(key) || { durations: [], items: 0 };
    entry.durations.push(Math.max(0, Number(durationMs) || 0));
    if (entry.durations.length > 512) entry.durations.shift();
    entry.items += Math.max(0, Number(items) || 0);
    telemetry.subsystems.set(key, entry);
}

function snapshot(sessions = []) {
    const population = { full: 0, visible: 0, preload: 0 };
    (Array.isArray(sessions) ? sessions : []).forEach((session) => {
        if (!isBotSession(session) || !session.actor) return;
        const tier = session.hotActorLod?.tier || 'preload';
        population[tier] = Number(population[tier] || 0) + 1;
    });
    const delta = {};
    Object.keys(telemetry.counters).forEach((key) => { delta[key] = telemetry.counters[key] - Number(telemetry.last[key] || 0); });
    telemetry.last = { ...telemetry.counters };
    const subsystems = Object.fromEntries([...telemetry.subsystems.entries()].map(([name, entry]) => [name, {
        ...stats(entry.durations),
        items: entry.items
    }]));
    const result = {
        constants: { visibilityRadius: VISIBILITY_RADIUS, fullEnterRadius: FULL_ENTER_RADIUS, fullExitRadius: FULL_EXIT_RADIUS, promotionHoldMs: PROMOTION_HOLD_MS, fullAmbientTickMs: FULL_AMBIENT_TICK_MS, farVisibleTickMs: FAR_VISIBLE_TICK_MS, preloadTickMs: PRELOAD_TICK_MS, farVisibleTickBudgetMs: FAR_VISIBLE_TICK_BUDGET_MS },
        population,
        counters: { ...telemetry.counters },
        delta,
        tick: stats(telemetry.tickDurations),
        status: stats(telemetry.statusDurations),
        subsystems
    };
    telemetry.tickDurations = [];
    telemetry.statusDurations = [];
    telemetry.subsystems = new Map();
    return result;
}

module.exports = {
    VISIBILITY_RADIUS, FULL_ENTER_RADIUS, FULL_EXIT_RADIUS, PROMOTION_HOLD_MS, FAR_VISIBLE_TICK_MS, PRELOAD_TICK_MS,
    evaluate, nextTickDelay, promote, shouldRefreshStatus, recordStatusRefresh, budgetExceeded, recordDeferral,
    recordTick, recordPacketBroadcast, recordSubsystem, snapshot, isRealPlayerSession
};
