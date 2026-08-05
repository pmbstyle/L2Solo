const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const ServerResponse = invoke('GameServer/Network/Response');

// A player can send several tells while the provider is answering.  Keep the
// pair ordered so each request sees the previous answer in conversation
// history, but do not add an artificial delay or discard any message.
const queues = new Map();

function config() {
    return OpenRouterGateway.config({ timeoutMs: 0 });
}

function estimatePromptTokens(payload) {
    try { return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4)); } catch (_) { return 1; }
}

function enqueue(key, work) {
    const previous = queues.get(key) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    queues.set(key, current);
    return current.finally(() => {
        if (queues.get(key) === current) queues.delete(key);
    });
}

function playerSummary(playerSession) {
    const actor = playerSession?.actor;
    if (!actor) return null;

    return {
        id: actor.fetchId(),
        name: actor.fetchName(),
        level: actor.fetchLevel(),
        hpPct: Math.round((actor.fetchHp() / actor.fetchMaxHp()) * 100),
        mpPct: Math.round((actor.fetchMp() / actor.fetchMaxMp()) * 100),
        karma: typeof actor.fetchKarma === 'function' ? actor.fetchKarma() : 0
    };
}

function stateSummary(state) {
    if (!state) return null;

    return {
        id: state.characterId,
        name: state.name,
        level: state.level,
        classId: state.classId || state.stats?.classId || null,
        phase: state.phase,
        activity: state.activity,
        homeRegion: state.homeRegion,
        currentRegion: state.currentRegion,
        spotId: state.spotId,
        loc: state.loc || null,
        hpPct: state.vitals?.maxHp ? Math.round((state.vitals.hp / state.vitals.maxHp) * 100) : null,
        mpPct: state.vitals?.maxMp ? Math.round((state.vitals.mp / state.vitals.maxMp) * 100) : null,
        adena: state.adena,
        partyId: state.party?.partyId || null,
        role: state.party?.role || state.stats?.role || 'dps',
        lastReason: state.stats?.lastReason || null,
        newbieAnchor: !!state.stats?.newbieAnchor,
        persona: personaForState(state)
    };
}

function personaForState(state) {
    const persona = BotPersona.generate(state);
    if (!persona) return null;
    return {
        primaryDrive: persona.primaryDrive,
        archetype: persona.archetype,
        traits: { ...persona.traits },
        textCard: persona.textCard
    };
}

function compactEvents(events) {
    return (events || []).map((event) => ({
        type: event.type,
        summary: event.summary,
        ageSec: event.createdAt ? Math.max(0, Math.round((Date.now() - event.createdAt) / 1000)) : null
    }));
}

function fallbackReply(state, availability, text) {
    const name = state?.name || 'I';
    const activity = state?.activity || 'hunting';
    const hpPct = state?.vitals?.maxHp ? Math.round((state.vitals.hp / state.vitals.maxHp) * 100) : null;
    const lower = String(text || '').toLowerCase();
    const persona = personaForState(state);

    if (availability?.reason === 'low_trust') {
        return `I hear you, but I don't trust you enough yet.`;
    }
    if (availability?.reason === 'recently_abandoned') {
        return `Not now. Last party ended badly.`;
    }
    if (availability?.reason === 'prefers_solo') {
        return persona?.primaryDrive === 'wealth'
            ? `I'm keeping this run focused on work for now. Let us get to know each other first.`
            : `I prefer a quiet solo run for now. Let us get to know each other first.`;
    }
    if (activity === 'dead' || availability?.reason === 'bot_dead') {
        return `I died out here. Running back from town when I can.`;
    }
    if (activity === 'resting' || (hpPct !== null && hpPct < 35)) {
        return `I'm recovering for a bit, HP is around ${hpPct ?? 'low'}%.`;
    }
    if (lower.includes('party') || lower.includes('пати') || lower.includes('invite')) {
        if (availability?.available && persona?.primaryDrive === 'social') {
            return `I am open to a steady party. Invite me by name near ${state?.homeRegion || 'my spot'}.`;
        }
        if (availability?.available && persona?.primaryDrive === 'wealth') {
            return `If it is a practical run, invite me by name near ${state?.homeRegion || 'my spot'}.`;
        }
        return `Invite me by name if you want, I'm near ${state?.homeRegion || 'my spot'}.`;
    }
    if (lower.includes('where') || lower.includes('где')) {
        return `${name} here. I'm ${activity} near ${state?.homeRegion || state?.spotId || 'my hunting spot'}.`;
    }

    return `Hey. I'm ${activity} near ${state?.homeRegion || 'my hunting spot'} right now.`;
}

function schema() {
    return {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['say', 'none', 'come_to_player']
            },
            reply: {
                type: 'string',
                description: 'Short in-character private reply. Do not claim arrival until the server confirms it.'
            },
            reason: {
                type: 'string',
                description: 'Short internal reason.'
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1
            }
        },
        required: ['action', 'reply', 'reason', 'confidence'],
        additionalProperties: false
    };
}

function systemPrompt() {
    return [
        'You are replying as one Lineage 2 bot in a private chat while the bot is cold/off-screen.',
        'The state below is a persistent snapshot of the bot life, not a live actor. Use only the provided state, persona, social memory, availability, conversation, and life events.',
        'The persona shapes tone and high-level preferences, never facts, safety, or available actions.',
        'Do not invent items, rewards, locations, levels, party membership, combat results, or live observations.',
        'Keep the reply short, grounded, and in character.',
        'Use action=say for ordinary conversation and action=none when no reply is needed.',
        'Use action=come_to_player only when the player explicitly asks this bot to come, arrive, teleport, or meet them here.',
        'The server will validate availability and perform the arrival. Never claim that the bot arrived or joined a party before the server confirms the action.',
        'A cold chat never activates the bot by itself unless the validated action is come_to_player.'
    ].join(' ');
}

async function requestLlmReply(payload, cfg, turn, state, playerSession) {
    const playerId = playerSession.actor.fetchId();
    const botId = Number(state.characterId || 0);
    const sessionId = `cold-bot:${botId}:player:${playerId}`;
    const result = await OpenRouterGateway.request({
        config: cfg,
        circuitKey: `cold-chat:${botId}:${playerId}`,
        circuitBreaker: false,
        interactive: true,
        timeoutMs: 0,
        requestId: turn.turnId,
        sessionId,
        source: 'cold_chat',
        botId,
        playerId,
        turnId: turn.turnId,
        messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        responseSchema: {
            name: 'bot_remote_chat',
            schema: schema()
        },
        repairSchema: true
    });
    if (!result.ok) {
        return {
            providerFailure: true,
            providerOutcome: result.reason,
            usage: result.usage,
            llmTelemetry: result.telemetry
        };
    }
    return {
        data: result.data || null,
        usage: result.usage,
        llmTelemetry: result.telemetry
    };
}

function validateLlmReply(result) {
    if (result?.providerFailure) return result;
    if (!result?.data) return null;

    const parsed = result.data;
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    const reply = BotChatText.normalize(parsed.reply)
        .slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
    if (!reply || Number(parsed.confidence || 0) < 0.35) return null;

    return {
        reply,
        action: parsed.action || 'say',
        reason: parsed.reason || 'llm',
        confidence: Number(parsed.confidence || 0),
        llm: true,
        usage: result.usage,
        llmTelemetry: result.llmTelemetry
    };
}

function playerLocation(playerSession) {
    const actor = playerSession?.actor;
    if (!actor) return null;
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function activateNearPlayer(playerSession, state) {
    const run = () => {
        const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const World = invoke('GameServer/World/World');
        const availability = BotAvailability.evaluateState(playerSession, state, { ignoreDistance: true });
        if (!availability.available) {
            return Promise.resolve({ ok: false, reason: availability.reason, availability });
        }

        return PopulationService.requestActivation(state, 'remote_chat_come', {
            playerLoc: playerLocation(playerSession),
            forceNearPlayer: true,
            readyOnActivation: true,
            recoverOnActivation: true
        }).then((activation) => {
            if (!activation?.ok) return { ok: false, reason: activation?.reason || 'activation_failed' };
            return World.waitForBotSession(BotManager, state.name, 40).then((targetSession) => {
                if (!targetSession) return { ok: false, reason: 'activation_session_timeout' };

                const ChatArrivalState = invoke('GameServer/Bot/AI/ChatArrivalState');
                ChatArrivalState.start(targetSession, playerSession);
                return { ok: true, targetSession, activation };
            });
        });
    };
    return LangfuseTracing.withObservation(
        'bot.tool.come_to_player',
        { player: playerSummary(playerSession), bot: stateSummary(state), playerLoc: playerLocation(playerSession) },
        {
            source: 'cold_chat',
            tool: 'come_to_player',
            botId: state.characterId,
            playerId: playerSession.actor.fetchId()
        },
        run,
        'tool'
    );
}

function recordReply(playerSession, state, turn, result, extra = {}) {
    if (!result?.reply) return Promise.resolve(false);
    const fallback = result.providerFailure === true ||
        result.isFallback === true ||
        result.reason === 'fallback' ||
        extra.fallback === true;
    return LangfuseTracing.withObservation(
        'bot.conversation.persist',
        { botId: state.characterId, playerId: playerSession.actor.fetchId(), turnId: turn.turnId },
        {
            source: 'cold_chat',
            botId: state.characterId,
            playerId: playerSession.actor.fetchId(),
            turnId: turn.turnId,
            sessionId: `cold-bot:${Number(state.characterId || 0)}:player:${playerSession.actor.fetchId()}`
        },
        () => BotConversationService.recordBotReply({
            playerSession,
            botSession: state,
            turnId: turn.turnId,
            channel: turn.channel,
            text: result.reply,
            requestId: turn.turnId,
            delivered: result.delivered === true,
            meta: {
                action: result.action || 'say',
                reason: result.reason || null,
                providerOutcome: result.providerOutcome || null,
                fallback,
                ...extra
            }
        }),
        'chain'
    );
}

function deliverReply(playerSession, state, text) {
    if (!state || !playerSession?.dataSendToMe) return false;
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    const lines = BotChatText.splitForTell(text);
    if (!lines.length) return false;
    try {
        lines.forEach((line) => {
            playerSession.dataSendToMe(
                ServerResponse.speak({
                    fetchId: () => Number(state.characterId || 0),
                    fetchName: () => state.name || 'Bot'
                }, { kind: 2, text: line })
            );
        });
        return true;
    } catch (_) {
        return false;
    }
}

function replyForStateNow(playerSession, state, text, channel = 'client_tell') {
    const cfg = config();
    const availability = BotAvailability.evaluateState(playerSession, state);
    const fallback = {
        ok: true,
        reply: fallbackReply(state, availability, text),
        action: 'say',
        reason: 'fallback',
        isFallback: true
    };
    const begin = BotConversationService.beginTurn({
        playerSession,
        botSession: state,
        text,
        channel,
        source: 'cold_chat'
    });

    return Promise.all([
        begin,
        LifeEvents.recentForBot(state.characterId, 5)
    ]).then(([turn, events]) => {
        const memory = BotSocialMemory.getSnapshot(playerSession, state);
        const payload = {
            event: 'cold_chat',
            playerMessage: String(text || '').slice(0, 240),
            player: playerSummary(playerSession),
            bot: stateSummary(state),
            social: {
                relationship: BotSocialMemory.relationship(memory),
                trust: memory.trust,
                familiarity: memory.familiarity,
                groupRuns: memory.groupRuns,
                tradesCompleted: memory.tradesCompleted
            },
            availability: {
                available: availability.available,
                reason: availability.reason,
                reasonText: availability.reasonText
            },
            recentEvents: compactEvents(events),
            conversation: turn.context,
            constraints: {
                privateReply: true,
                remainColdUnlessCome: true,
                noCombatMicromanagement: true,
                noInventedFacts: true
            }
        };

        const llmReady = cfg.enabled && !!cfg.apiKey;
        const estimatedPromptTokens = estimatePromptTokens({
            messages: [
                { role: 'system', content: systemPrompt() },
                { role: 'user', content: JSON.stringify(payload) }
            ]
        });
        const admission = llmReady
            ? BotInferenceBudget.reserveForBotId(state.characterId, {
                event: 'cold_chat',
                bypass: true,
                priority: 'interactive',
                estimatedPromptTokens,
                maxCompletionTokens: 0
            })
            : { ok: false, reason: 'disabled', reservation: null };
        let reservation = admission.reservation;

        const rootPromise = LangfuseTracing.withRootObservation(
            'cold-bot.dialogue',
            payload,
            {
                event: 'cold_chat',
                source: 'cold_chat',
                botId: state.characterId,
                playerId: playerSession.actor.fetchId(),
                turnId: turn.turnId,
                requestId: turn.turnId,
                sessionId: `cold-bot:${Number(state.characterId || 0)}:player:${playerSession.actor.fetchId()}`
            },
            async () => {
                const stageMetadata = {
                    event: 'cold_chat',
                    source: 'cold_chat',
                    botId: state.characterId,
                    playerId: playerSession.actor.fetchId(),
                    turnId: turn.turnId,
                    requestId: turn.turnId,
                    sessionId: `cold-bot:${Number(state.characterId || 0)}:player:${playerSession.actor.fetchId()}`
                };
                await LangfuseTracing.withObservation(
                    'bot.context.assemble',
                    {
                        event: 'cold_chat',
                        conversationTurns: payload.conversation?.recentTurns?.length || 0,
                        recentEvents: payload.recentEvents?.length || 0
                    },
                    stageMetadata,
                    async () => payload,
                    'chain'
                );

                const deliver = (reply, extra = {}) => LangfuseTracing.withObservation(
                    'bot.reply.deliver',
                    {
                        action: reply?.action || 'say',
                        reply: reply?.reply || null,
                        providerOutcome: reply?.providerOutcome || null
                    },
                    stageMetadata,
                    () => {
                        const delivered = deliverReply(playerSession, state, reply?.reply);
                        const deliveredReply = { ...reply, delivered };
                        return recordReply(
                            playerSession,
                            state,
                            turn,
                            deliveredReply,
                            { ...extra, fallback: deliveredReply.isFallback === true }
                        ).then(() => deliveredReply);
                    },
                    'chain'
                );

                const grantedAdmission = admission.ready
                    ? await admission.ready
                    : admission;
                reservation = grantedAdmission?.reservation || reservation;
                if (!llmReady || !grantedAdmission?.ok) {
                    if (llmReady && !grantedAdmission?.ok) {
                        await LangfuseTracing.withObservation(
                            'bot.inference.admission',
                            { event: 'cold_chat', estimatedPromptTokens },
                            { ...stageMetadata, reason: grantedAdmission.reason, retryAfterMs: grantedAdmission.retryAfterMs || 0 },
                            async () => ({ ok: false, reason: grantedAdmission.reason, retryAfterMs: grantedAdmission.retryAfterMs || 0 }),
                            'chain'
                        );
                    }
                    const failed = !llmReady
                        ? fallback
                        : {
                            ...fallback,
                            providerOutcome: grantedAdmission.reason,
                            reason: grantedAdmission.reason,
                            isFallback: true
                        };
                    return deliver(failed);
                }

                const providerResult = await requestLlmReply(payload, cfg, turn, state, playerSession);
                const result = await LangfuseTracing.withObservation(
                    'bot.schema.validate',
                    {
                        event: 'cold_chat',
                        providerOutcome: providerResult?.llmTelemetry?.outcome || providerResult?.providerOutcome || null
                    },
                    stageMetadata,
                    async () => validateLlmReply(providerResult),
                    'chain'
                );
                if (result?.providerFailure) {
                    state.lastRemoteChatTelemetry = result.llmTelemetry || null;
                    const failed = {
                        ...fallback,
                        providerOutcome: result.providerOutcome,
                        usage: result.usage || null,
                        llmTelemetry: result.llmTelemetry || null,
                        isFallback: true
                    };
                    return deliver(failed);
                }
                const reply = result || fallback;
                if (reply.action === 'come_to_player') {
                    const actionResult = await activateNearPlayer(playerSession, state);
                    const confirmed = actionResult.ok;
                    const actionReply = confirmed
                        ? reply
                        : {
                            ...fallback,
                            reason: `come_to_player:${actionResult.reason || 'rejected'}`,
                            providerOutcome: 'action_rejected',
                            isFallback: true
                        };
                    return deliver({
                        ...actionReply,
                        action: confirmed ? 'come_to_player' : 'say',
                        actionResult: { ok: confirmed, reason: actionResult.reason || null }
                    }, {
                        actionResult: { ok: confirmed, reason: actionResult.reason || null }
                    });
                }
                return deliver(reply);
            },
            'agent'
        );
        return rootPromise.then((result) => {
            BotInferenceBudget.settle(reservation, result?.usage || result?.llmTelemetry?.usage);
            return result;
        }, (error) => {
            BotInferenceBudget.settle(reservation);
            throw error;
        });
    });
}

const BotRemoteChat = {
    replyForState(playerSession, state, text, channel = 'client_tell') {
        if (!playerSession?.actor || !state) {
            return Promise.resolve({ ok: false, reason: 'missing_context' });
        }

        const key = `${playerSession.actor.fetchId()}:${state.characterId}`;
        return enqueue(key, () => replyForStateNow(playerSession, state, text, channel))
            .then((result) => {
                BotSocialMemory.recordEvent(playerSession, state, 'chat', result.reason || 'remote_chat');
                return result;
            });
    }
};

module.exports = { ...BotRemoteChat, personaForState, fallbackReply };
