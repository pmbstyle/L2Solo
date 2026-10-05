// PvP journal: one row per conflict between characters (a cold contest,
// revenge or fight, written when it ends; a hot kill), kept in memory and
// written with the economy journal flush. Raw rows are kept for hours; an
// hourly summary for days.

const MAX_PENDING = 5000;

let pending = [];

const personaArchetype = (personaFor, state) => {
    try {
        return personaFor?.(state)?.archetype || null;
    } catch (_) {
        return null;
    }
};

function record(row) {
    if (pending.length >= MAX_PENDING) return;
    pending.push(row);
}

// Both sides as the journal names them: solo_vs_party and so on.
const matchup = (partyIds) => partyIds.map((partyId) => (partyId ? 'party' : 'solo')).join('_vs_');

// One row when a cold conflict ends: a contest or revenge without a fight, a
// fight that ends in a step (retreat, kill, defeat, disengage;
// ColdPartyConflict.apply), or a fight that runs out of time, is interrupted
// or separated (PvpEncounterRuntime.finish). principals[0] started it. A step
// that leaves the fight going writes nothing. kills: the cold kills of the
// fight; a kill ends it, so they all come from its last step.
function coldConflict({ key, revenge, reason, spotId, npcId, partyIds, sideSizes, outcome, fought,
    principals, losingSide = null, kills = [], durationMs = 0, actions = 0, personaFor, at }) {
    const [first, second] = principals;
    record({
        at,
        source: 'cold',
        conflictKey: String(key || ''),
        action: revenge ? 'revenge' : 'contest',
        reason: reason || null,
        spotId: spotId || null,
        npcId: Number(npcId || 0) || null,
        matchup: matchup(partyIds),
        outcome,
        pvp: fought ? 1 : 0,
        initiatorId: first.characterId,
        initiatorLevel: Number(first.level || 0),
        initiatorArchetype: personaArchetype(personaFor, first),
        initiatorKarma: Number(first.stats?.karma || 0),
        targetId: second.characterId,
        targetLevel: Number(second.level || 0),
        targetArchetype: personaArchetype(personaFor, second),
        targetKarma: Number(second.stats?.karma || 0),
        sideSizes: sideSizes.join(':'),
        losingSide: losingSide === null || losingSide === undefined ? null : Number(losingSide),
        kills: kills.length,
        pkKills: kills.filter((kill) => !kill.pvp).length,
        durationMs: Math.max(0, Math.round(Number(durationMs) || 0)),
        actions: Number(actions || 0),
        playerInvolved: 0
    });
}

// A hot kill of a character (ReceivedHit), with the karma before the kill.
function hotKill({ attacker, victim, pk, attackerKarma, playerInvolved, at }) {
    record({
        at,
        source: 'hot',
        conflictKey: null,
        action: 'kill',
        reason: null,
        spotId: null,
        npcId: null,
        matchup: null,
        outcome: pk ? 'pk' : 'pvp',
        pvp: 1,
        initiatorId: attacker.fetchId(),
        initiatorLevel: Number(attacker.fetchLevel() || 0),
        initiatorArchetype: null,
        initiatorKarma: Number(attackerKarma || 0),
        targetId: victim.fetchId(),
        targetLevel: Number(victim.fetchLevel() || 0),
        targetArchetype: null,
        targetKarma: Number(victim.fetchKarma() || 0),
        sideSizes: '1:1',
        losingSide: 1,
        kills: 1,
        pkKills: pk ? 1 : 0,
        durationMs: 0,
        actions: 0,
        playerInvolved: playerInvolved ? 1 : 0
    });
}

function snapshot() {
    return pending.slice();
}

function drain() {
    const rows = pending;
    pending = [];
    return rows;
}

module.exports = { coldConflict, hotKill, matchup, record, drain, snapshot };
