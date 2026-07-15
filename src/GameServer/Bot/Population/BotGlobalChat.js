const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ServerResponse = invoke('GameServer/Network/Response');

let lastGlobalAt = 0;

function coldActor(state) {
    return {
        fetchId: () => Number(state?.characterId || 0),
        fetchName: () => state?.name || 'Bot'
    };
}

function realPlayerSessions() {
    const World = invoke('GameServer/World/World');
    return World.user.sessions.filter((session) => (
        session.socket &&
        typeof session.socket.write === 'function' &&
        session.accountId &&
        !String(session.accountId).startsWith('bot_')
    ));
}

function eventChance(event) {
    if (!event) return 0;
    if (event.type === 'death' || Number(event.weight || 0) >= 4) return Config.globalChatImportantChance;
    if (event.type === 'party') return Config.globalChatChance * 2;
    if (event.type === 'hunt' && Number(event.meta?.wins || 0) >= 3) return Config.globalChatChance;
    return 0;
}

function lineForEvent(state, event) {
    const spot = event?.meta?.spotId || state?.spotId || state?.homeRegion || 'my spot';
    if (event.type === 'death') {
        return `Careful near ${spot}. I just died there.`;
    }
    if (event.type === 'party') {
        return `We formed a party near ${spot}. Could use one more later.`;
    }
    if (event.type === 'hunt') {
        return `Good run near ${spot}: ${event.meta?.wins || 'a few'} fights down.`;
    }
    return '';
}

function pickEvent(events = []) {
    return events
        .filter((event) => eventChance(event) > 0)
        .sort((a, b) => Number(b.weight || 0) - Number(a.weight || 0))[0] || null;
}

const BotGlobalChat = {
    maybeAnnounce(state, events = []) {
        if (Config.globalChatEnabled === false) return false;
        if (!state || !events.length) return false;
        if (Date.now() - lastGlobalAt < Config.globalChatMinIntervalMs) return false;

        const event = pickEvent(events);
        if (!event) return false;
        if (Math.random() > eventChance(event)) return false;

        const players = realPlayerSessions();
        if (players.length === 0) return false;

        const text = lineForEvent(state, event).slice(0, 120);
        if (!text) return false;

        const packet = ServerResponse.speak(coldActor(state), { kind: 1, text });
        players.forEach((session) => session.dataSendToMe(packet));
        lastGlobalAt = Date.now();

        console.info(
            'BotGlobalChat :: %s announced %s: %s',
            state.name || 'Bot',
            event.type,
            text
        );
        return true;
    }
};

module.exports = BotGlobalChat;
