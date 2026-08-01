const BotConversationStore = invoke('GameServer/Bot/AI/BotConversationStore');
const BotConversationSummarizer = invoke('GameServer/Bot/AI/BotConversationSummarizer');

const DEFAULT_RECENT_TURNS = BotConversationStore.DEFAULT_RECENT_TURNS;
let turnSequence = 0;

function actorId(session) {
    return Number(session?.actor?.fetchId?.() || session?.characterId || 0);
}

function normalizeChannel(value) {
    return String(value || 'local').toLowerCase().replace(/[^a-z0-9_:-]/g, '_').slice(0, 32) || 'local';
}

function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, BotConversationStore.MAX_TEXT_CHARS);
}

function validPair(playerSession, botSession) {
    return !!(
        playerSession?.actor &&
        botSession?.actor &&
        actorId(playerSession) > 0 &&
        actorId(botSession) > 0 &&
        !String(playerSession.accountId || '').startsWith('bot_') &&
        String(botSession.accountId || '').startsWith('bot_')
    );
}

function nextTurnId(input = {}) {
    if (input.turnId) return String(input.turnId).slice(0, 128);
    turnSequence += 1;
    return `${normalizeChannel(input.channel)}:${actorId(input.playerSession)}:${actorId(input.botSession)}:${Date.now()}:${turnSequence}`;
}

function contextView(context) {
    return {
        summary: context?.summary || null,
        recentTurns: (context?.recentTurns || []).map((turn) => ({
            turnId: turn.turnId,
            role: turn.role,
            channel: turn.channel,
            text: turn.text,
            createdAt: turn.createdAt
        })),
        version: Number(context?.version || 0)
    };
}

function beginTurn(input = {}) {
    if (!validPair(input.playerSession, input.botSession)) {
        return Promise.reject(new Error('invalid hot dialogue pair'));
    }

    const playerId = actorId(input.playerSession);
    const botId = actorId(input.botSession);
    const channel = normalizeChannel(input.channel);
    const turnId = nextTurnId(input);
    const playerText = normalizeText(input.text);
    if (!playerText) return Promise.reject(new Error('empty hot dialogue text'));

    return BotConversationStore.appendTurn({
        playerId,
        botId,
        turnId,
        role: 'player',
        channel,
        text: playerText,
        requestId: input.requestId,
        meta: {
            source: input.source || channel,
            playerName: input.playerSession.actor.fetchName?.() || null,
            botName: input.botSession.actor.fetchName?.() || null
        }
    }).then((stored) => BotConversationStore.context(playerId, botId, {
        limit: input.recentTurns || DEFAULT_RECENT_TURNS
    }).then((context) => ({
        playerId,
        botId,
        turnId,
        channel,
        playerText,
        inserted: stored.inserted,
        conversation: context.conversation,
        context: contextView(context)
    })));
}

function recordBotReply(input = {}) {
    if (!validPair(input.playerSession, input.botSession)) return Promise.resolve(false);
    const text = normalizeText(input.text);
    if (!text || !input.turnId) return Promise.resolve(false);

    return BotConversationStore.appendTurn({
        playerId: actorId(input.playerSession),
        botId: actorId(input.botSession),
        turnId: input.turnId,
        role: 'bot',
        channel: normalizeChannel(input.channel),
        text,
        requestId: input.requestId,
        delivered: input.delivered !== false,
        meta: input.meta || null
    }).then(() => {
        BotConversationSummarizer.summarize({
            playerId: actorId(input.playerSession),
            botId: actorId(input.botSession),
            requestId: input.requestId
        }).catch(() => {});
        return true;
    }).catch(() => false);
}

function recordFallback(input = {}) {
    return recordBotReply({
        ...input,
        meta: { ...(input.meta || {}), fallback: true, reason: input.reason || 'fallback' }
    });
}

function contextFor(playerSession, botSession, options = {}) {
    if (!validPair(playerSession, botSession)) return Promise.reject(new Error('invalid hot dialogue pair'));
    return BotConversationStore.context(actorId(playerSession), actorId(botSession), options)
        .then(contextView);
}

const BotConversationService = {
    DEFAULT_RECENT_TURNS,
    validPair,
    beginTurn,
    recordBotReply,
    recordFallback,
    contextFor,
    maybeSummarize(input = {}) {
        if (!validPair(input.playerSession, input.botSession)) {
            return Promise.resolve({ ok: false, reason: 'invalid_hot_dialogue_pair' });
        }
        return BotConversationSummarizer.summarize({
            playerId: actorId(input.playerSession),
            botId: actorId(input.botSession),
            requestId: input.requestId,
            threshold: input.threshold,
            limit: input.limit
        });
    },
    resetSequence() {
        turnSequence = 0;
    }
};

module.exports = BotConversationService;
