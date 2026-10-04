// PvP journal: one row per committed conflict between characters (a cold
// contest, revenge or fight; a hot kill), kept in memory and written with the
// economy journal flush. Raw rows are kept for hours; an hourly summary for days.

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

// A committed cold conflict (ColdPartyConflict.apply). sides[0] started it.
function coldConflict({ event, sides, outcome, pvp, matchup, revenge, personaFor, at }) {
    const [first, second] = sides.map((side) => side.principal);
    const fighters = pvp?.started ? pvp.fighters || [] : [];
    const kills = fighters.flatMap((fighter) => fighter.kills || []);
    record({
        at,
        source: 'cold',
        conflictKey: String(event.key || ''),
        action: revenge ? 'revenge' : 'contest',
        reason: pvp?.reason || event.action || null,
        spotId: event.spotId || null,
        npcId: Number(event.npcId || 0) || null,
        matchup,
        outcome,
        pvp: pvp?.started ? 1 : 0,
        initiatorId: first.characterId,
        initiatorLevel: Number(first.level || 0),
        initiatorArchetype: personaArchetype(personaFor, first),
        initiatorKarma: Number(first.stats?.karma || 0),
        targetId: second.characterId,
        targetLevel: Number(second.level || 0),
        targetArchetype: personaArchetype(personaFor, second),
        targetKarma: Number(second.stats?.karma || 0),
        sideSizes: sides.map((side) => side.members.length).join(':'),
        losingSide: pvp?.started ? Number(pvp.losingSide) : null,
        kills: kills.length,
        pkKills: kills.filter((kill) => !kill.pvp).length,
        durationMs: pvp?.started ? Number(pvp.durationMs || 0) : 0,
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
        playerInvolved: playerInvolved ? 1 : 0
    });
}

function drain() {
    const rows = pending;
    pending = [];
    return rows;
}

module.exports = { coldConflict, hotKill, record, drain };
