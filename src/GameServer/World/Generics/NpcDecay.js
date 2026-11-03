const DiagnosticConfig = require('../../Bot/Population/PopulationConfig');
const NpcVisibility = invoke('GameServer/World/NpcVisibility');

// A corpse leaves the world when its own timer fires (set in schedule()). A
// failed removal is retried by re-arming that timer, and a corpse that cannot
// be removed after MAX_DECAY_FAILURES tries is discarded.
const RETRY_DELAY_MS = 1000;
const MAX_DECAY_FAILURES = 3;

const telemetry = { scheduled: 0, expired: 0, retries: 0, discarded: 0 };

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

// The one place a corpse is marked gone: no later timer, retry or batch
// touches it again.
function markRemoved(npc) {
    npc.corpseDecayState = 'removed';
    npc.corpseDecayAt = 0;
    npc.corpseDecaySession = null;
    npc.corpseDecayFailures = 0;
    clearTimer(npc);
}

function numericDelay(delayMs) {
    const value = Number(delayMs);
    return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function armTimer(world, npc, delayMs) {
    clearTimer(npc);
    npc.corpseDecayTimer = setTimeout(() => expire(world, npc), delayMs);
    // A corpse timer must never keep a test process or a graceful server
    // shutdown alive on its own.
    npc.corpseDecayTimer.unref?.();
}

function schedule(world, sourceSession, npc, delayMs) {
    if (!world?.npc?.spawns || !npc?.fetchId) return false;
    if (npc.corpseDecayState === 'removed') return false;

    const delay = numericDelay(delayMs);
    npc.corpseDecayState = 'scheduled';
    npc.corpseDecaySession = sourceSession || null;
    npc.corpseDecayAt = Date.now() + delay;
    npc.corpseDecayFailures = 0;
    armTimer(world, npc, delay);
    DiagnosticConfig.developerDiagnostics && (telemetry.scheduled += 1);
    return true;
}

// The corpse timer: removes the corpse, or on a failure retries it a second
// later and discards it after MAX_DECAY_FAILURES failures.
function expire(world, npc) {
    if (npc.corpseDecayState === 'removed') return false;
    DiagnosticConfig.developerDiagnostics && (telemetry.expired += 1);
    let failed;
    try {
        failed = !decay(world, npc);
    }
    catch (error) {
        logWarning('timer failed', error);
        failed = true;
    }
    if (!failed || npc.corpseDecayState === 'removed') return !failed;

    const attempts = Number(npc.corpseDecayFailures || 0) + 1;
    npc.corpseDecayFailures = attempts;
    if (attempts >= MAX_DECAY_FAILURES) {
        try {
            if (discardUnremovableNpc(world, npc, attempts)) {
                DiagnosticConfig.developerDiagnostics && (telemetry.discarded += 1);
                return true;
            }
        }
        catch (error) {
            logWarning('discard failed', error);
        }
        // Marked removed even when it was already out of the list: no retry.
        if (npc.corpseDecayState === 'removed') return true;
    }
    DiagnosticConfig.developerDiagnostics && (telemetry.retries += 1);
    armTimer(world, npc, RETRY_DELAY_MS);
    return false;
}

// Takes one corpse out of the grid and the spawn list. Each step is best
// effort: a failed grid step must not strand the corpse in the list or stop
// the caller. Returns whether the corpse was in the list.
function removeFromWorld(world, npc, label) {
    try {
        world.removeNpcFromGrid(npc);
    }
    catch (error) {
        logWarning(`grid removal failed for ${label}`, error);
    }
    // A corpse already taken out of the list (a spoil sweep, a summon death)
    // is not there; nothing else needs a scan.
    const index = world.npc.spawns.indexOf(npc);
    if (index >= 0) world.npc.spawns.splice(index, 1);
    return index >= 0;
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
    markRemoved(npc);

    // Remove the server object first. Packet delivery is best effort and may
    // fail for a disconnected client; it must not leave a corpse in the grid.
    removeFromWorld(world, npc, `NPC ${npcId}`);

    try {
        NpcVisibility.deleteKnownNpc(world, sourceSession, npcId);
    }
    catch (error) {
        logWarning(`failed to notify deletion for NPC ${npcId}`, error);
    }

    return true;
}

function decayMany(world, npcs) {
    if (!world?.npc?.spawns || !Array.isArray(npcs) || npcs.length === 0) return 0;

    const removed = new Set();
    const notifications = [];
    npcs.forEach((npc) => {
        if (!npc?.fetchId || npc.corpseDecayState === 'removed') return;
        try {
            const npcId = npc.fetchId();
            removed.add(npc);
            notifications.push({ npcId, sourceSession: npc.corpseDecaySession });
            markRemoved(npc);
        }
        catch (error) {
            logWarning('failed to prepare NPC for batch decay', error);
        }
    });
    if (removed.size === 0) return 0;

    removed.forEach((npc) => {
        try {
            world.removeNpcFromGrid(npc);
        } catch (error) {
            logWarning('grid removal failed during batch decay', error);
        }
    });
    world.npc.spawns = world.npc.spawns.filter((entry) => !removed.has(entry));

    notifications.forEach(({ npcId, sourceSession }) => {
        try {
            NpcVisibility.deleteKnownNpc(world, sourceSession, npcId);
        }
        catch (error) {
            logWarning(`failed to notify deletion for NPC ${npcId}`, error);
        }
    });
    return removed.size;
}

// The last failed attempt: the corpse is marked gone first, so whatever the
// world does next, no timer is armed for it again.
function discardUnremovableNpc(world, npc, attempts) {
    if (!npc) return false;
    markRemoved(npc);
    if (!world?.npc?.spawns) return false;

    const removed = removeFromWorld(world, npc, 'an unremovable NPC');
    logWarning(`discarded unremovable corpse after ${attempts} failed attempts`, 'NPC id unavailable');
    return removed;
}

function stats() {
    if (!DiagnosticConfig.developerDiagnostics) return { enabled: false };
    return { ...telemetry };
}

module.exports = {
    schedule,
    expire,
    decay,
    decayMany,
    stats
};
