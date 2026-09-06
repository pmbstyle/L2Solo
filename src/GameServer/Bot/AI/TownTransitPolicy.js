const TownPathfinder = invoke('GameServer/Bot/AI/TownPathfinder');
const TownRespawn = invoke('GameServer/World/TownRespawn');
const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');

const RETRY_MS = 60000;
const STUCK_MS = 120000;
const ESCAPE_COOLDOWN_MS = 600000;
const townNames = new Set(Object.values(TownRespawn.towns).map((town) => town.name));

function pointOf(actor) {
    return {
        locX: Number(actor?.fetchLocX?.() ?? actor?.locX),
        locY: Number(actor?.fetchLocY?.() ?? actor?.locY),
        locZ: Number(actor?.fetchLocZ?.() ?? actor?.locZ)
    };
}

function townAt(actor) {
    const point = pointOf(actor);
    if (!Object.values(point).every(Number.isFinite)) return null;
    const measured = TownPathfinder.getTown(point);
    if (measured && Math.abs(point.locZ - measured.center.locZ) <= 512) return measured.name;
    // Unmapped settlements use conservative cores and actual service spawns,
    // never the 7500-unit nearest-gatekeeper radius (which includes fields).
    for (const town of Object.values(TownRespawn.towns)) {
        if (Math.hypot(point.locX - town.locX, point.locY - town.locY) <= 1500
            && Math.abs(point.locZ - town.locZ) <= 256) return town.name;
    }
    for (const npc of TownServiceCatalog.rows()) {
        if (Math.hypot(point.locX - npc.locX, point.locY - npc.locY) <= 512
            && Math.abs(point.locZ - npc.locZ) <= 128) return npc.town;
    }
    return null;
}

function defer(session, bot, reason, now = Date.now()) {
    session.townTravelRetryAt = now + RETRY_MS + Math.abs(Number(bot?.fetchId?.() || 0) % 5000);
    session.lastTownTravelFailure = { reason, at: now, retryAt: session.townTravelRetryAt };
    bot?.automation?.abortAll?.(bot);
}

function observeRecovery(session, bot, key, suspended = false, now = Date.now()) {
    const point = pointOf(bot);
    let state = session.townTravelRecovery;
    if (!state || state.key !== key || now - state.seenAt > ESCAPE_COOLDOWN_MS
        || Math.hypot(point.locX - state.anchor.locX, point.locY - state.anchor.locY) >= 96
        || Math.abs(point.locZ - state.anchor.locZ) >= 64 || suspended) {
        state = { key, anchor: point, stalledAt: now, failures: 0 };
        session.townTravelRecovery = state;
    }
    state.seenAt = now;
    return state;
}

function escapeAfterFailure(session, bot, key, attempt, now = Date.now()) {
    const state = observeRecovery(session, bot, key, false, now);
    if (state.lastAttempt !== attempt) {
        state.lastAttempt = attempt;
        state.failures++;
    }
    return state.failures >= 3 && now - state.stalledAt >= STUCK_MS
        && (!session.townEmergencyEscapeAt || now - session.townEmergencyEscapeAt >= ESCAPE_COOLDOWN_MS);
}

function routeTown(from, to) {
    const origin = townAt(from);
    if (origin) return origin;
    // Service errands in towns without measured polygons still use the same
    // navigation engine. This routing hint does not classify fields as town
    // for travel/SoE policy, and geodata remains authoritative for every leg.
    if (townNames.has(to?.town) && Math.hypot(from.locX - to.locX, from.locY - to.locY) <= 7500) return to.town;
    return null;
}

// Called again on every AI tick: moving away, combat, or changing NPC resets
// the interaction rather than letting a delayed callback teleport remotely.
function interact(state, bot, ready, now = Date.now()) {
    if (!ready) {
        delete state.interactionReadyAt;
        return false;
    }
    if (!state.interactionReadyAt) {
        bot?.automation?.abortAll?.(bot);
        const id = Math.abs(Number(bot?.fetchId?.() || 0));
        state.interactionReadyAt = now + 700 + (Math.imul(id, 2654435761) >>> 0) % 900;
        return false;
    }
    return now >= state.interactionReadyAt;
}

module.exports = { RETRY_MS, STUCK_MS, ESCAPE_COOLDOWN_MS, pointOf, townAt, routeTown, defer, interact, observeRecovery, escapeAfterFailure };
