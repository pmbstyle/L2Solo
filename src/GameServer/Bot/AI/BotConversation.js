const Speech = invoke('GameServer/Bot/AI/BotSpeechTemplates');
const CONVERSATION_COOLDOWN_MS = 90 * 1000;
const CONVERSATION_RANGE = 800;

function areaFor(session) {
    const actor = session?.actor;
    return invoke('GameServer/Bot/AI/BotChatLocation').describe({
        loc: { locX: actor?.fetchLocX?.(), locY: actor?.fetchLocY?.(), locZ: actor?.fetchLocZ?.() },
        region: session?.currentRegion
    });
}

function trait(session, name, fallback = 0.5) {
    const value = Number(session?.persona?.traits?.[name]);
    return Number.isFinite(value) ? value : fallback;
}

function chooseTopic(initiator, responder) {
    const area = areaFor(initiator);
    const drive = initiator?.persona?.primaryDrive;
    const cautious = trait(responder, 'caution') >= 0.7;
    const social = trait(responder, 'sociability') >= 0.7;
    const candidates = [];
    const add = (id, lines, weight = 1) => candidates.push({
        id, opener: lines[0], reply: lines[1], closer: lines[2], weight
    });

    add('rest', Speech.lines('dialogue.rest.1', {}, { cautious, social }));
    add('rest', Speech.lines('dialogue.rest.2', {place: area}, { cautious, social }));
    add('roads', Speech.lines('dialogue.roads.1', {}, { cautious, social }));
    add('roads', Speech.lines('dialogue.roads.2', {}, { cautious, social }));
    add('gear', Speech.lines('dialogue.gear.1', {}, { cautious, social }), drive === 'wealth' ? 3 : 1);
    add('gear', Speech.lines('dialogue.gear.2', {}, { cautious, social }), drive === 'progression' ? 3 : 1);
    add('company', Speech.lines('dialogue.company.1', {}, { cautious, social }), drive === 'social' ? 3 : 1);
    add('company', Speech.lines('dialogue.company.2', {}, { cautious, social }));
    add('hunting', Speech.lines('dialogue.hunting.1', {}, { cautious, social }));
    add('hunting', Speech.lines('dialogue.hunting.2', {}, { cautious, social }));

    const role = String(responder?.botStatus?.role || responder?.role || '').toLowerCase();
    if (['healer', 'buffer', 'tank', 'archer', 'dagger'].includes(role)) {
        add('party', Speech.lines('dialogue.party.1', {reply: Speech.line('dialogue.role.' + role)}, { cautious, social }));
    }
    // The memory only proves there was a shop visit, not that a purchase
    // succeeded. Do not invent a successful deal in the reply.
    if (initiator?.lastTradeSummary || responder?.lastTradeSummary) {
        add('trade', Speech.lines('dialogue.trade.1', {}, { cautious, social }));
    }
    const maxMp = Number(responder?.actor?.fetchMaxMp?.() || 0);
    if (maxMp > 0 && Number(responder.actor.fetchMp?.() ?? maxMp) / maxMp < 0.45) {
        add('recovery', Speech.lines('dialogue.recovery.1', {}, { cautious, social }), 4);
    }

    const recent = new Set([...(initiator.recentConversationTopics || []),
        ...(responder.recentConversationTopics || []),
        initiator.lastConversation?.topic, responder.lastConversation?.topic]);
    const fresh = candidates.filter((topic) => !recent.has(topic.id));
    const pool = fresh.length ? fresh : candidates;
    let roll = Math.random() * pool.reduce((sum, topic) => sum + topic.weight, 0);
    return pool.find((topic) => (roll -= topic.weight) < 0) || pool[pool.length - 1];
}

function canContinue(conversation) {
    const sessions = [...new Set((conversation?.lines || []).map((line) => line.speaker))];
    if (sessions.length !== 2 || sessions.some((session) => !session?.actor ||
        session.plan !== 'resting' || session.partyCompanion || session.activeTrade || session.activeNegotiation ||
        session.actor.fetchIsOnline?.() === false || session.actor.isDead?.() ||
        session.actor.state?.fetchDead?.() || session.actor.state?.fetchHits?.() || session.actor.state?.fetchCasts?.())) return false;
    const [a, b] = sessions.map((session) => session.actor);
    if (typeof a.fetchLocX !== 'function' || typeof b.fetchLocX !== 'function') return true;
    return Math.hypot(a.fetchLocX() - b.fetchLocX(), a.fetchLocY() - b.fetchLocY(),
        (a.fetchLocZ?.() || 0) - (b.fetchLocZ?.() || 0)) < CONVERSATION_RANGE;
}

function canStart(initiator, responder, now = Date.now()) {
    if (!initiator?.actor || !responder?.actor || initiator === responder) return false;
    if (initiator.inConversation || responder.inConversation) return false;
    if (initiator.partyCompanion || responder.partyCompanion) return false;
    if (!canContinue({ lines: [{ speaker: initiator }, { speaker: responder }] })) return false;

    return ![initiator, responder].some((session) => (
        session.lastConversationAt && now - session.lastConversationAt < CONVERSATION_COOLDOWN_MS
    ));
}

function start(initiator, responder, now = Date.now()) {
    if (!canStart(initiator, responder, now)) return null;

    const topic = chooseTopic(initiator, responder);
    const conversation = {
        topic: topic.id,
        startedAt: now,
        participants: [initiator.actor.fetchName(), responder.actor.fetchName()],
        lines: [
            { speaker: initiator, text: topic.opener },
            { speaker: responder, text: topic.reply },
            { speaker: initiator, text: topic.closer }
        ]
    };

    for (const session of [initiator, responder]) {
        session.recentConversationTopics = [topic.id, ...(session.recentConversationTopics || [])].slice(0, 3);
    }
    initiator.inConversation = true;
    responder.inConversation = true;
    initiator.lastConversationAt = now;
    responder.lastConversationAt = now;
    initiator.lastConversation = { topic: topic.id, with: responder.actor.fetchName(), at: now };
    responder.lastConversation = { topic: topic.id, with: initiator.actor.fetchName(), at: now };
    return conversation;
}

function finish(conversation) {
    if (!conversation) return;
    conversation.lines.forEach(({ speaker }) => {
        speaker.inConversation = false;
    });
}

module.exports = {
    CONVERSATION_COOLDOWN_MS,
    CONVERSATION_RANGE,
    chooseTopic,
    canStart,
    canContinue,
    start,
    finish
};
