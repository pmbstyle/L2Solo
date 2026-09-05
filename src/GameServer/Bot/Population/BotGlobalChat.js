const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ServerResponse = invoke('GameServer/Network/Response');

const TOPIC_INTERVAL_MS = 15 * 60 * 1000;
const SPEAKER_INTERVAL_MS = 10 * 60 * 1000;
let lastGlobalAt = null;
let nextGlobalAt = 0;
const recent = [];

function realPlayerSessions() {
    const World = invoke('GameServer/World/World');
    return (World.user?.sessions || []).filter((session) => (
        session.socket && typeof session.socket.write === 'function' &&
        session.accountId && !String(session.accountId).startsWith('bot_')
    ));
}

function available(id, topic, now) {
    while (recent.length && now - recent[0].at >= TOPIC_INTERVAL_MS) recent.shift();
    if (lastGlobalAt !== null && now < nextGlobalAt) return false;
    return !recent.some((entry) => entry.topic === topic ||
        (entry.id === id && now - entry.at < SPEAKER_INTERVAL_MS));
}

function send(actor, topic, templates, now) {
    const id = actor.fetchId();
    if (!available(id, topic, now)) return false;
    const players = realPlayerSessions();
    if (!players.length) return false;
    const text = templates[Math.floor(Math.random() * templates.length)].slice(0, 120);
    const packet = ServerResponse.speak(actor, { kind: 1, text });
    players.forEach((session) => session.dataSendToMe(packet));
    lastGlobalAt = now;
    nextGlobalAt = now + Config.globalChatMinIntervalMs * (1 + Math.random() * 0.75);
    recent.push({ id, topic, at: now });
    if (recent.length > 128) recent.shift();
    console.info('BotGlobalChat :: %s announced %s: %s', actor.fetchName(), topic, text);
    return true;
}

function maybeAnnounce(state, events = [], now = Date.now()) {
    if (Config.globalChatEnabled === false || !state) return false;
    // Ordinary kills and party formation already have better homes: the
    // event journal and factual recruitment ads. A death is an occasional
    // reaction, not a population-wide status ticker.
    const event = events.find((candidate) => candidate.type === 'death');
    if (!event || !available(Number(state.characterId || 0), 'death', now)) return false;
    if (Math.random() >= Config.globalChatImportantChance) return false;
    return send({
        fetchId: () => Number(state.characterId || 0),
        fetchName: () => state.name || 'Bot'
    }, 'death', Speech.lines('global.death'), now);
}

function maybeAmbient(session, now = Date.now()) {
    if (Config.globalChatEnabled === false || !session?.actor || session.partyCompanion ||
        session.inConversation || session.actor.isDead?.() || session.actor.state?.fetchDead?.() ||
        !['resting', 'hunting'].includes(session.plan)) return false;
    if (!available(session.actor.fetchId(), '', now)) return false;
    const topics = [
        ['break', Speech.lines('global.break')],
        ['roads', Speech.lines('global.roads')],
        ['patience', Speech.lines('global.patience')],
        ['company', Speech.lines('global.company')]
    ].filter(([topic]) => available(session.actor.fetchId(), topic, now));
    if (!topics.length) return false;
    const [topic, lines] = topics[Math.floor(Math.random() * topics.length)];
    return send(session.actor, topic, lines, now);
}

module.exports = {
    maybeAnnounce, maybeAmbient, TOPIC_INTERVAL_MS, SPEAKER_INTERVAL_MS,
    reset() { lastGlobalAt = null; nextGlobalAt = 0; recent.length = 0; }
};
