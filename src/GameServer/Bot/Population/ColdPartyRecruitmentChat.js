const ActorQueries = require('../../World/ActorSpatialQueries');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const PartyComposition = invoke('GameServer/Bot/Population/BackgroundPartyComposition');
const ServerResponse = invoke('GameServer/Network/Response');

let lastGlobalAdAt = 0;

const ROLE_NAMES = {
    tank: 'Tank',
    healer: 'Healer',
    buffer: 'Buffer',
    dps: 'DPS',
    mage: 'DPS',
    archer: 'DPS',
    dagger: 'DPS'
};

function coldActor(state) {
    return {
        fetchId: () => Number(state?.characterId || 0),
        fetchName: () => state?.name || 'Bot'
    };
}

function realPlayerSessions() {
    const World = invoke('GameServer/World/World');
    return ActorQueries.humans(World).filter((session) => (
        session.socket &&
        typeof session.socket.write === 'function' &&
        session.accountId &&
        !String(session.accountId).startsWith('bot_')
    ));
}

function recruitmentText(party, members, spot, maxSize) {
    const coverage = PartyComposition.roleCoverage(members);
    const openSlots = Math.max(0, Number(maxSize || 0) - members.length);
    if (!openSlots) return '';

    const wanted = ['tank', 'healer', 'buffer']
        .filter((role) => !coverage[role])
        .map((role) => ROLE_NAMES[role]);
    if (wanted.length < openSlots) wanted.unshift('DPS');
    if (!wanted.length) wanted.push('DPS');

    const leader = members.find((member) => Number(member.characterId) === Number(party.leaderId)) || members[0];
    const level = Number(leader?.level || 1);
    const place = invoke('GameServer/Bot/AI/BotChatLocation').describe({ spot, spotId: party.spotId });
    const Agreement = require('./PartyAgreement');
    const base = `LF ${wanted.map(role => role.toLowerCase()).join('/')}, ${place} lv${level}`;
    let clause = Agreement.describe(party.stats?.objective, party.stats?.agreement, { place });
    if (base.length + clause.length + 2 > 220) {
        clause = Agreement.describe(null, party.stats?.agreement, { place, includeGoal: false });
    }
    return base + (clause ? `, ${clause}` : '');
}

function maybeAnnounce(party, members, spot, timestamp = Date.now()) {
    if (Config.partyRecruitmentChatEnabled === false || !party?.partyId || !Array.isArray(members) || !members.length) {
        return { party, announced: false, reason: 'not_eligible' };
    }
    if (members.length >= Config.partyMaxSize) return { party, announced: false, reason: 'party_full' };

    const lastAt = Number(party.stats?.lastRecruitmentAdAt || 0);
    if (lastAt > 0 && lastAt + Config.partyRecruitmentChatIntervalMs > timestamp) {
        return { party, announced: false, reason: 'cooldown' };
    }
    if (lastGlobalAdAt > 0 && timestamp - lastGlobalAdAt < Config.partyRecruitmentChatGlobalMinIntervalMs) {
        return { party, announced: false, reason: 'global_cooldown' };
    }

    const text = recruitmentText(party, members, spot, Config.partyMaxSize);
    const players = realPlayerSessions();
    if (!text || !players.length) return { party, announced: false, reason: 'no_audience' };

    const leader = members.find((member) => Number(member.characterId) === Number(party.leaderId)) || members[0];
    const packet = ServerResponse.speak(coldActor(leader), { kind: 1, text });
    players.forEach((session) => session.dataSendToMe(packet));
    lastGlobalAdAt = timestamp;

    const nextParty = {
        ...party,
        stats: { ...(party.stats || {}), lastRecruitmentAdAt: timestamp }
    };
    if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info('BotParty :: %s recruitment ad: %s', leader?.name || 'Bot', text);
    return { party: nextParty, announced: true, text };
}

function reset() {
    lastGlobalAdAt = 0;
}

module.exports = { maybeAnnounce, recruitmentText, reset };
