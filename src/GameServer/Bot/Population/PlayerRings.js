'use strict';

// The real players' activation rings, published to the cold worker as the 'player_rings'
// table: where each online player stands and the activation radius around it. Main
// publishes them at its activation scan (PopulationService.activateNearPlayers: every
// scan, a login, a teleport), a player's row only when it moved a ring step since its last
// one. The worker puts the bots inside a ring first in its due queue: they may go hot at
// the next scan, and a player sees them.
const TableChannel = require('./ColdTableChannel').shared;

// A move shorter than this keeps the published ring (an edge off by at most this much
// against a 9000 radius); a longer one republishes it and reschedules the bots it crosses.
const RING_STEP = 1000;

const rows = new Map();
TableChannel.register('player_rings', { key: row => row.characterId, allRows: () => [...rows.values()], eventDriven: true });

// players: [{ characterId, locX, locY }], every real player online now; radius: the activation's.
function publish(players, radius) {
    const seen = new Set();
    for (const player of players) {
        const id = Number(player.characterId), locX = Number(player.locX), locY = Number(player.locY);
        if (!id || !Number.isFinite(locX) || !Number.isFinite(locY)) continue;
        seen.add(id);
        const held = rows.get(id);
        if (held && held.radius === radius && Math.hypot(held.locX - locX, held.locY - locY) < RING_STEP) continue;
        const row = { characterId: id, locX, locY, radius };
        rows.set(id, row);
        TableChannel.changed('player_rings', row);
    }
    for (const id of rows.keys()) {
        if (seen.has(id)) continue;
        rows.delete(id);
        TableChannel.changed('player_rings', { key: id, removed: true });
    }
}

module.exports = { publish, RING_STEP };
