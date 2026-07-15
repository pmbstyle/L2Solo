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
    return (World.user?.sessions || []).filter((session) => (
        session.socket &&
        typeof session.socket.write === 'function' &&
        session.accountId &&
        !String(session.accountId).startsWith('bot_')
    ));
}

function joinRoles(roles) {
    if (roles.length <= 1) return roles[0] || '';
    if (roles.length === 2) return `${roles[0]} and ${roles[1]}`;
    return `${roles.slice(0, -1).join(', ')}, and ${roles[roles.length - 1]}`;
}

function recruitmentText(party, members, spot, maxSize) {
    const coverage = PartyComposition.roleCoverage(members);
    const openSlots = Math.max(0, Number(maxSize || 0) - members.length);
    if (!openSlots) return '';

    const present = ['tank', 'healer', 'buffer']
        .filter((role) => coverage[role])
        .map((role) => ROLE_NAMES[role]);
    const wanted = ['tank', 'healer', 'buffer']
        .filter((role) => !coverage[role])
        .map((role) => ROLE_NAMES[role]);
    if (wanted.length < openSlots) wanted.unshift('DPS');
    if (!wanted.length) wanted.push('DPS');

    const leader = members.find((member) => Number(member.characterId) === Number(party.leaderId)) || members[0];
    const level = Number(leader?.level || 1);
    const group = present.length ? joinRoles(present) : 'Party';
    const place = spot?.name || party.spotId || 'our spot';
    return `${group} LFM ${joinRoles(wanted)} — Lv. ${level} party at ${place}.`.slice(0, 120);
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
    console.info('BotParty :: %s recruitment ad: %s', leader?.name || 'Bot', text);
    return { party: nextParty, announced: true, text };
}

function reset() {
    lastGlobalAdAt = 0;
}

module.exports = { maybeAnnounce, recruitmentText, reset };
