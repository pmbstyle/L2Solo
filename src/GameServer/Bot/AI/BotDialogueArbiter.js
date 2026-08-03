const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

function fallbackText(botSession, reason) {
    const plan = botSession?.plan || 'hunting';
    if (reason === 'timeout') return 'Give me a moment. I am still sorting things out.';
    if (reason === 'no_visible_real_players') return `I cannot hear you clearly from here. I am ${plan} right now.`;
    return `I hear you. I am ${plan} right now.`;
}

function deliverFallback(input, turn, reason) {
    const BotManager = invoke('GameServer/Bot/BotManager');
    const reply = fallbackText(input.botSession, reason);
    const botId = input.botSession?.actor?.fetchId?.() || input.botSession?.accountId || null;
    const playerId = input.playerSession?.actor?.fetchId?.() || null;
    const turnId = turn?.turnId || input.turnId || input.requestId || null;
    const channel = turn?.channel || input.channel || input.source || 'hot_dialogue';
    const metadata = {
        event: 'player_chat',
        source: input.source || channel,
        channel,
        botId,
        playerId,
        turnId,
        requestId: input.requestId || turnId,
        sessionId: `hot-bot:${botId || 'unknown'}:player:${playerId || 'unknown'}`,
        providerOutcome: reason || 'fallback',
        preProviderFallback: true
    };
    let delivered = false;
    let persisted = false;
    const fallbackResult = (traceError = null) => ({
        ok: delivered,
        started: false,
        applied: false,
        reason: reason || 'fallback',
        reply,
        delivered,
        persisted,
        traceOutput: {
            providerOutcome: reason || 'fallback',
            requestedAction: null,
            toolOutcome: null,
            applied: false,
            playerVisibleReply: delivered ? reply : null,
            replyDelivered: delivered,
            traceError: traceError?.message || null
        }
    });

    return LangfuseTracing.withRootObservation(
        'hot-bot.dialogue',
        {
            event: 'player_chat',
            playerMessage: turn?.playerText || input.text || '',
            conversation: turn?.context || null
        },
        metadata,
        async () => {
            const delivery = await LangfuseTracing.withObservation(
                'bot.reply.deliver',
                { action: 'fallback', reply, reason: reason || 'fallback' },
                metadata,
                async () => {
                    BotManager.botTell(input.botSession, input.playerSession, reply);
                    delivered = true;
                    return { ok: true, reply, delivered: true };
                },
                'chain'
            );
            persisted = turnId
                ? await LangfuseTracing.withObservation(
                    'bot.conversation.persist',
                    { botId, playerId, turnId, fallback: true },
                    metadata,
                    () => BotConversationService.recordFallback({
                        playerSession: input.playerSession,
                        botSession: input.botSession,
                        turnId,
                        channel,
                        text: reply,
                        reason
                    }),
                    'chain'
                )
                : false;
            delivered = delivery?.delivered === true;
            persisted = persisted === true;
            return fallbackResult();
        },
        'agent'
    ).catch(async (traceError) => {
        utils.infoWarn('Langfuse', 'fallback trace failed for %s: %s', input.botSession?.actor?.fetchName?.() || 'bot', traceError.message);
        if (!delivered) {
            try {
                BotManager.botTell(input.botSession, input.playerSession, reply);
                delivered = true;
            } catch (_) {
                delivered = false;
            }
        }
        if (turnId && !persisted) {
            persisted = await BotConversationService.recordFallback({
                playerSession: input.playerSession,
                botSession: input.botSession,
                turnId,
                channel,
                text: reply,
                reason
            }).catch(() => false);
        }
        return fallbackResult(traceError);
    });
}

function route(input = {}) {
    if (!BotConversationService.validPair(input.playerSession, input.botSession)) {
        return Promise.resolve({ ok: false, reason: 'invalid_hot_pair' });
    }

    let turnForFallback = null;
    return BotConversationService.beginTurn(input).then((turn) => {
        turnForFallback = turn;
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
        if (turnForFallback) {
            return deliverFallback(input, turnForFallback, 'conversation_error').then((result) => ({
                ...result,
                error: error.message
            }));
        }
        return deliverFallback(input, {
            turnId: input.turnId || input.requestId || null,
            channel: input.channel || input.source || 'hot_dialogue',
            playerText: input.text || '',
            context: null
        }, 'conversation_error').then((result) => ({
            ...result,
            error: error.message
        }));
    });
}

module.exports = {
    route,
    fallbackText
};
