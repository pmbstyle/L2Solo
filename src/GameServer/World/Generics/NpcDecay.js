const NpcVisibility = invoke('GameServer/World/NpcVisibility');

const DEFAULT_REAPER_INTERVAL_MS = 1000;
const MAX_SWEEP_FAILURES = 3;

function logWarning(message, error) {
    const detail = error?.message || error || 'unknown error';
    if (typeof utils?.infoWarn === 'function') {
        utils.infoWarn('NpcDecay', `${message}: ${detail}`);
    }
}

function clearTimer(npc) {
    if (!npc?.corpseDecayTimer) return;
    clearTimeout(npc.corpseDecayTimer);
    npc.corpseDecayTimer = undefined;
}

function numericDelay(delayMs) {
    const value = Number(delayMs);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function schedule(world, sourceSession, npc, delayMs) {
    if (!world?.npc?.spawns || !npc?.fetchId) return false;
    if (npc.corpseDecayState === 'removed') return false;

    clearTimer(npc);
    const delay = numericDelay(delayMs);
    npc.corpseDecayState = 'scheduled';
    npc.corpseDecaySession = sourceSession || null;
    npc.corpseDecayAt = Date.now() + delay;
    npc.corpseDecaySweepFailures = 0;
    npc.corpseDecayTimer = setTimeout(() => {
        try {
            decay(world, npc);
        }
        catch (error) {
            // Leave the scheduled state intact so the reaper can retry an
            // unexpected failure on the next pass.
            logWarning('timer failed', error);
        }
    }, delay);
    // A corpse timer must never keep a test process or a graceful server
    // shutdown alive on its own. The reaper remains the durable fallback.
    npc.corpseDecayTimer.unref?.();
    return true;
}

function decay(world, npc) {
    if (!world?.npc?.spawns || !npc?.fetchId) return false;
    if (npc.corpseDecayState === 'removed') return false;

    let npcId;
    try {
        npcId = npc.fetchId();
    }
    catch (error) {
        logWarning('failed to read NPC id during decay', error);
        return false;
    }
    const sourceSession = npc.corpseDecaySession;
    npc.corpseDecayState = 'removed';
    npc.corpseDecayAt = 0;
    npc.corpseDecaySession = null;
    npc.corpseDecaySweepFailures = 0;
    clearTimer(npc);

    // Remove the server object first. Packet delivery is best effort and may
    // fail for a disconnected client; it must not leave a corpse in the grid.
    world.npc.spawns = world.npc.spawns.filter((entry) => {
        if (entry === npc) return false;
        try {
            return entry?.fetchId?.() !== npcId;
        }
        catch (error) {
            logWarning('failed to read a neighboring NPC id during decay', error);
            return true;
        }
    });

    try {
        world.indexSpawnsInGrid?.();
    }
    catch (error) {
        // Grid repair is useful but must not prevent the client deletion
        // packet or strand the corpse in the known-object view.
        logWarning(`grid rebuild failed for NPC ${npcId}`, error);
    }

    try {
        NpcVisibility.deleteKnownNpc(world, sourceSession, npcId);
    }
    catch (error) {
        logWarning(`failed to notify deletion for NPC ${npcId}`, error);
    }

    return true;
}

function discardUnremovableNpc(world, npc, attempts) {
    if (!world?.npc?.spawns || !npc) return false;

    const previousLength = world.npc.spawns.length;
    world.npc.spawns = world.npc.spawns.filter((entry) => entry !== npc);
    npc.corpseDecayState = 'removed';
    npc.corpseDecayAt = 0;
    npc.corpseDecaySession = null;
    npc.corpseDecaySweepFailures = 0;
    clearTimer(npc);

    try {
        world.indexSpawnsInGrid?.();
    }
    catch (error) {
        logWarning('grid rebuild failed while discarding an unremovable NPC', error);
    }

    logWarning(`discarded unremovable corpse after ${attempts} failed attempts`, 'NPC id unavailable');
    return world.npc.spawns.length < previousLength;
}

function sweepExpired(world, now = Date.now()) {
    if (!world?.npc?.spawns) return 0;

    let removed = 0;
    [...world.npc.spawns].forEach((npc) => {
        let failed = false;
        try {
            if (
                npc?.corpseDecayState !== 'removed' &&
                Number(npc?.corpseDecayAt || 0) > 0 &&
                Number(npc.corpseDecayAt) <= Number(now)
            ) {
                if (decay(world, npc)) removed += 1;
                else failed = true;
            }
        }
        catch (error) {
            // One malformed corpse must not block every later corpse in the
            // same sweep. Keep it scheduled for a future retry.
            logWarning('individual sweep failed', error);
            failed = true;
        }

        if (failed) {
            const attempts = Number(npc?.corpseDecaySweepFailures || 0) + 1;
            npc.corpseDecaySweepFailures = attempts;
            if (attempts >= MAX_SWEEP_FAILURES && discardUnremovableNpc(world, npc, attempts)) {
                removed += 1;
            }
        }
    });
    return removed;
}

function start(world, intervalMs = DEFAULT_REAPER_INTERVAL_MS) {
    stop(world);
    if (!world?.npc) return null;

    const interval = Math.max(50, Number(intervalMs) || DEFAULT_REAPER_INTERVAL_MS);
    world.npc.corpseDecayReaper = setInterval(() => {
        try {
            sweepExpired(world);
        }
        catch (error) {
            // One malformed NPC must not stop future corpse cleanup.
            logWarning('reaper failed', error);
        }
    }, interval);
    world.npc.corpseDecayReaper.unref?.();
    return world.npc.corpseDecayReaper;
}

function stop(world) {
    if (!world?.npc?.corpseDecayReaper) return;
    clearInterval(world.npc.corpseDecayReaper);
    world.npc.corpseDecayReaper = undefined;
}

module.exports = {
    schedule,
    decay,
    sweepExpired,
    start,
    stop
};
