const { EVENT_TYPES, characterIds, writeEvent } = require('./BotCombatMemory');

const [EVENT_TYPE] = EVENT_TYPES.pvp;
const OUTCOMES = {
    killed: 'ended with a kill',
    defeated: 'ended with a defeated side',
    retreated: 'ended with a retreat',
    disengaged: 'ended with both sides disengaging',
    expired: 'ran out of time',
    interrupted: 'was interrupted',
    separated_or_protected: 'ended after separation or reaching safety'
};

function coldParticipants(encounter, fight) {
    const seenAttackers = (encounter?.seen || []).flatMap(incident => {
        const ids = /^(\d+):(\d+):attacked$/.exec(incident);
        return ids ? ids.slice(1) : [];
    });
    const previous = [...(encounter?.pvpParticipants || []), ...seenAttackers];
    const hostile = (fight?.incidents || []).flatMap(({ sourceId, targetId }) => [sourceId, targetId]);
    if (!previous.length && !hostile.length) return [];
    return characterIds([
        ...previous, ...hostile,
        ...(fight?.fighters || []).filter(fighter => fighter.heals > 0).map(fighter => fighter.id)
    ]);
}

function coldOutcome({ key, sides, pvpParticipants }, outcome, at, losingSide = null, kills = []) {
    const participants = new Set(pvpParticipants);
    const observed = sides.map(side => side.memberIds.filter(id => participants.has(id)));
    if (observed.some(side => !side.length)) return null;
    return { source: 'cold', key, at, outcome: outcome.replace(/^pvp_/, ''), sides: observed, losingSide,
        encounterMemberIds: sides.flatMap(side => side.memberIds), bots: observed.flat(), kills };
}

function hotKill({ killerId, victimId, bots, credit, at, encounter }) {
    if (!bots.length) return Promise.resolve();
    const kills = [{ killerId, victimId, outcome: credit }];
    if (encounter?.key && at < encounter.expiresAt) {
        const killerSide = encounter.sides.findIndex(side => side.memberIds.includes(killerId));
        const losingSide = encounter.sides.findIndex(side => side.memberIds.includes(victimId));
        if (killerSide >= 0 && losingSide >= 0 && killerSide !== losingSide) {
            const memory = coldOutcome({ ...encounter,
                pvpParticipants: characterIds([...coldParticipants(encounter), killerId, victimId])
            }, 'killed', at, losingSide, kills);
            return invoke('Database').recordBotPvpOutcome({ ...memory, source: 'hot_encounter' });
        }
    }
    return invoke('Database').recordBotPvpOutcome({
        source: 'hot', key: [at, killerId, victimId], at, outcome: 'killed', losingSide: 1,
        sides: [[killerId], [victimId]], bots, kills
    });
}

function writeOutcome(write, { source, key, at, outcome, sides, losingSide, bots, kills = [], encounterMemberIds = [] }) {
    if (!key || !['hot', 'cold', 'hot_encounter'].includes(source) || !Object.hasOwn(OUTCOMES, outcome) || sides?.length !== 2) return;
    const observed = sides.map(characterIds);
    const participantIds = characterIds(observed.flat());
    if (observed.some(side => !side.length) || participantIds.length !== observed.flat().length) return;
    const recordedKills = kills.filter(({ killerId, victimId }) => participantIds.includes(killerId) && participantIds.includes(victimId))
        .map(({ killerId, victimId, outcome: credit }) => ({ killerId, victimId, credit }));
    const scope = source === 'hot' ? 'casualty' : 'encounter';
    // Use the original encounter key for a native kill and its later cleanup.
    writeEvent(write, { kind: 'pvp', eventType: EVENT_TYPE, at, identity: [scope === 'casualty' ? 'hot' : 'cold', key],
        onceFor: scope === 'encounter' ? characterIds(encounterMemberIds) : [],
        summary: scope === 'casualty' ? 'A character was killed in PvP.' : `PvP encounter ${OUTCOMES[outcome]}.`, participantIds, bots,
        details: { scope, outcome, sides: observed, losingSide: [0, 1].includes(losingSide) ? losingSide : null, kills: recordedKills } });
}

module.exports = { coldParticipants, coldOutcome, hotKill, writeOutcome };
