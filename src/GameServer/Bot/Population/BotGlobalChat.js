const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const Reactions = invoke('GameServer/Bot/AI/BotChatReactions');
const Budget = invoke('GameServer/Bot/AI/BotChatterBudget');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const ServerResponse = invoke('GameServer/Network/Response');

const TOPIC_INTERVAL_MS = 15 * 60 * 1000;
const SPEAKER_INTERVAL_MS = 10 * 60 * 1000;
let lastGlobalAt = null;
let nextGlobalAt = 0;
const recent = [];
const lastTextByTopic = new Map();

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
    if (Reactions.snapshot(now).global) return false;
    if (!Budget.canReply(id, now)) return false;
    const topicInterval = topic === 'death' ? TOPIC_INTERVAL_MS : Config.globalChatTopicIntervalMs;
    return !recent.some((entry) => (entry.topic === topic && now - entry.at < topicInterval) ||
        (entry.id === id && now - entry.at < SPEAKER_INTERVAL_MS));
}

function speakerAvailable(id, now) {
    return Budget.canReply(id, now) && !recent.some(entry => entry.id === id && now - entry.at < SPEAKER_INTERVAL_MS);
}

function deliverReaction(source, text, topic, now) {
    if (Config.globalChatEnabled === false) return false;
    const players = realPlayerSessions();
    if (!players.length) return false;
    const actor = source.actor || {
        fetchId: () => Number(source.characterId), fetchName: () => source.name
    };
    const packet = ServerResponse.speak(actor, { kind: 1, text: text.slice(0, 120) });
    players.forEach(session => session.dataSendToMe(packet));
    Budget.recordSpeaker(actor.fetchId(), now);
    // A short exchange borrows from the following quiet period. Replies do
    // not multiply the average global traffic budget by the number of bots.
    nextGlobalAt = Math.max(now, nextGlobalAt) + Config.globalChatMinIntervalMs;
    recent.push({ id: actor.fetchId(), topic: `reply:${topic}`, at: now });
    if (recent.length > 128) recent.shift();
    console.info('BotGlobalChat :: %s replied to %s: %s', actor.fetchName(), topic, text);
    return true;
}

function offerReply(source, now = Date.now()) {
    return Config.globalChatEnabled !== false && Reactions.offerGlobal(source, deliverReaction, speakerAvailable, now);
}

function send(actor, topic, templates, now, source) {
    const id = actor.fetchId();
    if (!available(id, topic, now)) return false;
    const players = realPlayerSessions();
    if (!players.length) return false;
    const fresh = templates.filter(text => text !== lastTextByTopic.get(topic));
    const pool = fresh.length ? fresh : templates;
    const text = pool[Math.floor(Math.random() * pool.length)].slice(0, 120);
    const packet = ServerResponse.speak(actor, { kind: 1, text });
    players.forEach((session) => session.dataSendToMe(packet));
    Budget.recordSpeaker(id, now);
    lastTextByTopic.set(topic, text);
    lastGlobalAt = now;
    nextGlobalAt = now + Config.globalChatMinIntervalMs * (1 + Math.random() * 0.75);
    recent.push({ id, topic, at: now });
    if (recent.length > 128) recent.shift();
    console.info('BotGlobalChat :: %s announced %s: %s', actor.fetchName(), topic, text);
    Reactions.openGlobal(source, topic, now);
    return true;
}

function maybeAnnounce(state, events = [], now = Date.now()) {
    if (Config.globalChatEnabled === false || !state) return false;
    if (offerReply(state, now)) return true;
    if (Reactions.isBusy(state, now)) return false;
    // Ordinary kills and party formation already have better homes: the
    // event journal and factual recruitment ads. A death is an occasional
    // reaction, not a population-wide status ticker.
    const event = events.find((candidate) => candidate.type === 'death');
    if (!event) return ambient(state, now);
    if (!available(Number(state.characterId || 0), 'death', now)) return false;
    if (Math.random() >= Config.globalChatImportantChance) return false;
    return send({
        fetchId: () => Number(state.characterId || 0),
        fetchName: () => state.name || 'Bot'
    }, 'death', Speech.lines('global.death'), now, state);
}

function maybeAmbient(session, now = Date.now()) {
    if (offerReply(session, now)) return true;
    return ambient(session, now);
}

function ambient(session, now) {
    if (Config.globalChatEnabled === false || !session) return false;
    const id = Number(session.actor?.fetchId() || session.characterId || 0);
    if (!available(id, '', now)) return false;
    if (!session.actor) {
        // Fresh cold simulation commits are also opportunities to begin a
        // conversation. Most of the population never receives a hot AI tick.
        if (!Reactions.canParticipate(session) || Reactions.isBusy(session, now) ||
            Math.random() >= Config.globalChatChance) return false;
    } else if (session.partyCompanion ||
        session.inConversation || session.actor.isDead?.() || session.actor.state?.fetchDead?.() ||
        !['resting', 'hunting'].includes(session.plan) || Reactions.isBusy(session, now)) return false;
    const topics = [
        ['break', Speech.lines('global.break')],
        ['roads', Speech.lines('global.roads')],
        ['patience', Speech.lines('global.patience')],
        ['company', Speech.lines('global.company')]
    ].filter(([topic]) => available(id, topic, now));
    if (!topics.length) return false;
    const [topic, lines] = topics[Math.floor(Math.random() * topics.length)];
    return send(session.actor || { fetchId: () => id, fetchName: () => session.name }, topic, lines, now, session);
}

module.exports = {
    maybeAnnounce, maybeAmbient, offerReply, TOPIC_INTERVAL_MS, SPEAKER_INTERVAL_MS,
    reset() { lastGlobalAt = null; nextGlobalAt = 0; recent.length = 0; lastTextByTopic.clear(); Reactions.reset(); }
};
