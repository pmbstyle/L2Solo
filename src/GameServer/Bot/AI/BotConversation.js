const CONVERSATION_COOLDOWN_MS = 90 * 1000;
const CONVERSATION_RANGE = 800;

function areaFor(session) {
    return session?.botStatus?.home?.region || session?.homeRegion || session?.spotId || 'town';
}

function personaFor(session) {
    return session?.persona?.traits ? session.persona : null;
}

function trait(session, name, fallback = 0.5) {
    const value = Number(personaFor(session)?.traits?.[name]);
    return Number.isFinite(value) ? value : fallback;
}

function roleLine(session) {
    const role = String(session?.botStatus?.role || session?.role || '').toLowerCase();
    let line = 'I could use a steadier run than the last one.';
    if (role === 'healer' || role === 'buffer') line = 'I will keep an eye on everyone\'s health.';
    else if (role === 'tank') line = 'I can take the first hits if things get rough.';
    else if (role === 'archer') line = 'I will keep some distance and watch the edges.';
    else if (role === 'dagger') line = 'I will look for a clean opening behind them.';

    if (trait(session, 'empathy') >= 0.78) return `${line} No one gets left behind.`;
    if (trait(session, 'assertiveness') >= 0.78) return `${line} Just give the word.`;
    return line;
}

function restOpener(session, area) {
    const drive = personaFor(session)?.primaryDrive;
    if (drive === 'wealth') return `Quiet around ${area} for once. A steady run could pay for the next upgrade.`;
    if (drive === 'social') return `Quiet around ${area} for once. It is better to head out with familiar company.`;
    if (drive === 'progression') return `Quiet around ${area} for once. Ready to make the next run count?`;
    return `Quiet around ${area} for once. Heading out when you are recovered?`;
}

function restCloser(session) {
    if (trait(session, 'caution') >= 0.70) return 'Sounds good. We can keep it steady and avoid rushing back in.';
    if (trait(session, 'sociability') >= 0.70) return 'Sounds good. Better than rushing back in alone.';
    return 'Sounds good. Better than rushing back in alone.';
}

function chooseTopic(initiator, responder) {
    const area = areaFor(initiator);
    const recentTopic = initiator?.lastConversation?.topic || responder?.lastConversation?.topic;
    const candidates = [];

    candidates.push({
        id: 'rest',
        opener: restOpener(initiator, area),
        reply: roleLine(responder),
        closer: restCloser(initiator)
    });

    if (responder?.botStatus?.role === 'tank' || initiator?.botStatus?.role === 'tank' ||
        responder?.botStatus?.role === 'healer' || initiator?.botStatus?.role === 'healer') {
        candidates.push({
            id: 'party',
            opener: personaFor(initiator)?.primaryDrive === 'social'
                ? `We have the right roles for a small group around ${area}. It would be good to keep the team together.`
                : `We have the right roles for a small group around ${area}.`,
            reply: roleLine(responder),
            closer: 'Then let us watch for someone who wants to join the next run.'
        });
    }

    if (initiator?.lastTradeSummary || responder?.lastTradeSummary) {
        candidates.push({
            id: 'trade',
            opener: `The market around ${area} has been busy. Did you find what you needed?`,
            reply: personaFor(responder)?.primaryDrive === 'wealth'
                ? 'Enough to get by. I would rather spend the next hour earning than browsing.'
                : 'Enough to get by. I would rather spend the next hour fighting than browsing.',
            closer: 'Same. A little more adena always makes the next trip easier.'
        });
    }

    const options = candidates.filter((topic) => topic.id !== recentTopic);
    return options[Math.floor(Math.random() * options.length)] || candidates[0];
}

function canStart(initiator, responder, now = Date.now()) {
    if (!initiator?.actor || !responder?.actor || initiator === responder) return false;
    if (initiator.inConversation || responder.inConversation) return false;
    if (initiator.partyCompanion || responder.partyCompanion) return false;
    if (initiator.plan !== 'resting' || responder.plan !== 'resting') return false;

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
    start,
    finish
};
