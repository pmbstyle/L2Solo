const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');

function fallbackText(botSession, reason) {
    const plan = botSession?.plan || 'hunting';
    if (reason === 'timeout') return 'Give me a moment. I am still sorting things out.';
    if (reason === 'no_visible_real_players') return `I cannot hear you clearly from here. I am ${plan} right now.`;
    return `I hear you. I am ${plan} right now.`;
}

function deliverFallback(input, turn, reason) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const reply = fallbackText(input.botSession, reason);
    BotManager.botTell(input.botSession, input.playerSession, reply);
    return BotConversationService.recordFallback({
        playerSession: input.playerSession,
        botSession: input.botSession,
        turnId: turn.turnId,
        channel: turn.channel,
        text: reply,
        reason
    }).then(() => ({
        ok: true,
        started: false,
        reason: reason || 'fallback',
        reply
    }));
}

function route(input = {}) {
    if (!BotConversationService.validPair(input.playerSession, input.botSession)) {
        return Promise.resolve({ ok: false, reason: 'invalid_hot_pair' });
    }

    return BotConversationService.beginTurn(input).then((turn) => {
        const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
        Promise.resolve(BotSocialMemory.recordEvent(
            input.playerSession,
            input.botSession,
            'chat',
            input.channel || input.source || 'hot_dialogue'
        )).catch(() => {});

        const BotBrain = invoke('GameServer/Bot/AI/BotBrain');
        const BotAI = invoke('GameServer/Bot/BotAI');
        const status = BotAI.getStatus(input.botSession);
        const requestContext = {
            playerSession: input.playerSession,
            source: input.source || input.channel || 'hot_dialogue',
            channel: turn.channel,
            requestId: input.requestId,
            conversation: turn.context,
            conversationTurn: turn,
            worldRevision: BotAgentTools.worldRevision(input.botSession),
            allowFallback: input.allowFallback !== false,
            queued: input.queued === true
        };

        return BotContextAssembler.assemble({
            session: input.botSession,
            status,
            text: turn.playerText,
            requestContext
        }).then((assembledContext) => {
            const started = BotBrain.maybeThink(
                input.botSession,
                'player_chat',
                status,
                turn.playerText,
                { ...requestContext, assembledContext }
            );

            if (!started && input.allowFallback !== false) {
                return deliverFallback(input, turn, 'not_started');
            }
            return { ok: true, started, queued: input.queued === true, turn, assembledContext };
        });
    }).catch((error) => {
        if (input.allowFallback === false || !input.playerSession?.actor || !input.botSession?.actor) {
            return { ok: false, reason: 'conversation_error' };
        }
        const BotManager = invoke('GameServer/Bot/BotManager');
        const reply = fallbackText(input.botSession, 'conversation_error');
        BotManager.botTell(input.botSession, input.playerSession, reply);
        return {
            ok: true,
            started: false,
            reason: 'conversation_error',
            reply,
            error: error.message
        };
    });
}

module.exports = {
    route,
    fallbackText
};
