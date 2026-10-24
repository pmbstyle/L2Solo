const DiagnosticConfig = require('../Population/PopulationConfig');
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LifeEvents = invoke('GameServer/Bot/Population/BotLifeEvents');
const BotPersona = invoke('GameServer/Bot/AI/BotPersona');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const ServerResponse = invoke('GameServer/Network/Response');
const ChatLocation = invoke('GameServer/Bot/AI/BotChatLocation');
const BotDialogueStyle = invoke('GameServer/Bot/AI/BotDialogueStyle');
const DialogueProtocol = require('./BotDialogueProtocol');
const DialogueKnowledge = require('./BotDialogueKnowledge');
const DialogueRunner = require('./BotDialogueRunner');
const DialogueParty = require('./BotDialogueParty');

// A player can send several tells while the provider is answering.  Keep the
// pair ordered so each request sees the previous answer in conversation
// history, but do not add an artificial delay or discard any message.
const queues = new Map();
// Result of a request whose character was replaced on the connection meanwhile.
const actorChanged = (extra = {}) => ({ ok: false, reason: 'actor_changed', ...extra });

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
        classId: state.classId ?? state.stats?.classId ?? null,
        className: invoke('GameServer/Bot/AI/BotRoles').className(state),
        activity: state.activity,
        currentRegion: ChatLocation.forState(state),
        hpPct: state.vitals?.maxHp ? Math.round((state.vitals.hp / state.vitals.maxHp) * 100) : null,
        mpPct: state.vitals?.maxMp ? Math.round((state.vitals.mp / state.vitals.maxMp) * 100) : null,
        adena: state.adena,
        partyId: state.party?.partyId || null,
        role: state.party?.role || state.stats?.role || 'dps',
        persona: personaForState(state)
    };
}

function personaForState(state) {
    const persona = BotPersona.of(state);
    if (!persona) return null;
    return {
        primaryDrive: persona.primaryDrive,
        archetype: persona.archetype,
        traits: { ...persona.traits },
        textCard: persona.textCard,
        dialogueVoice: persona.dialogueVoice
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

    if (availability?.reason === 'relationship_hostile') {
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
    if (lower.includes('party') || lower.includes('\u043f\u0430\u0442\u0438') || lower.includes('invite')) {
        if (availability?.available && persona?.primaryDrive === 'social') {
            return `I am open to a steady party. Invite me by name near ${ChatLocation.forState(state)}.`;
        }
        if (availability?.available && persona?.primaryDrive === 'wealth') {
            return `If it is a practical run, invite me by name near ${ChatLocation.forState(state)}.`;
        }
        return DialogueParty.reply(availability);
    }
    if (lower.includes('where') || lower.includes('\u0433\u0434\u0435')) {
        return `${name} here. I'm ${activity} near ${ChatLocation.forState(state)}.`;
    }

    return `Hey. I'm ${activity} near ${ChatLocation.forState(state)} right now.`;
}

function isPlayerJoinRequest(text) {
    return invoke('GameServer/Bot/AI/PlayerPartyTakeover').isJoinRequest(text);
}

function schema(shopAvailable = false) {
    return {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: ['say', 'none', 'come_to_player', 'request_player_join_party',
                    ...(shopAvailable ? ['shop_offer', 'shop_accept', 'shop_decline', 'shop_status'] : []), ...DialogueKnowledge.ACTIONS]
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
            },
            partyIntent: DialogueParty.INTENT_SCHEMA,
            topic: { type: 'string', enum: ['', ...DialogueKnowledge.TOPICS] },
            query: { type: 'string' },
            entityId: { type: 'integer', minimum: 0 },
            page: { type: 'integer', minimum: 1, maximum: 1000 },
            ...(shopAvailable ? {
                shopItemId: { type: 'integer', description: 'Exact listed item self id for shop_offer.' },
                shopQuantity: { type: 'integer', description: 'Requested listed quantity for shop_offer.' },
                shopTotalPrice: { type: 'integer', description: 'Total Adena for the whole shop_offer quantity.' }
            } : {})
        },
        required: ['action', 'reply', 'reason', 'confidence'],
        additionalProperties: false
    };
}

function systemPrompt(shopAvailable = false) {
    return [
        'You are a Lineage 2 character replying to a private message.',
        BotDialogueStyle,
        DialogueKnowledge.GROUNDING_PROMPT,
        DialogueParty.PROMPT,
        'For claims about your game life, use only the provided state, persona, social memory, availability, conversation, and life events. This does not restrict ordinary conversation topics.',
        'The persona shapes tone and high-level preferences, never facts, safety, or available actions.',
        'Do not invent items, rewards, locations, levels, party membership, combat results, or live observations.',
        'Keep the reply short, grounded, and in character.',
        'For a past raid/drop/trade/encounter, call recall_event first with a short keyword in query. Current state proves no past event. For drop/spoil sources use find_item_sources with the exact English item name in query.',
        'Read missing facts with inspect_self (inventory, equipment, skills, party, goals, relationship, relationships, recent_events) or lookup_game (items, item, item_sources, npcs, npc, recipes). Leave query empty to read all equipment. Search English catalog names with query, then use entityId. Results come back before your next decision. Catalog spawns are not live sightings.',
        'Use action=say for ordinary conversation and action=none when no reply is needed.',
        'Use action=come_to_player only when the player explicitly asks this bot to come, arrive, teleport, or meet them here.',
        'Use action=request_player_join_party only when the player asks to join this bot existing autonomous party. The server, not you, decides whether the party accepts and transfers the whole roster.',
        'The server will validate availability and perform the arrival. Never claim that the bot arrived or joined a party before the server confirms the action.',
        'Chat alone does not move you or form a party. Availability describes now; never promise acceptance of a later invite.',
        ...(shopAvailable ? [
            'The bot.shop payload is the current server-owned AFK shop. For a player price proposal about a listed item, use shop_offer with its exact selfId, quantity, and total Adena (47k means 47000). For agreement to an active shop negotiation use shop_accept; for rejection use shop_decline; for a request to inspect or update the shop without an active offer use shop_status.',
            'Never agree to a new price or claim that a shop changed with action=say. The server validates all shop actions and supplies the actual reply.'
        ] : [])
    ].join(' ');
}

async function requestLlmReply(payload, cfg, turn, state, playerSession) {
    const playerId = playerSession.actor.fetchId();
    const botId = Number(state.characterId || 0);
    const sessionId = `cold-bot:${botId}:player:${playerId}`;
    const actor = playerSession.actor;
    const result = await DialogueRunner.run({
        messages: DialogueProtocol.messages(systemPrompt(Boolean(payload.shop)), payload),
        alive: () => playerSession.actor === actor,
        isRead: action => DialogueKnowledge.ACTIONS.includes(action),
        read: decision => DialogueKnowledge.execute(decision, { session: state, playerSession, playerMessage: payload.playerMessage }),
        generate: async round => {
            const responseSchema = { name: 'bot_remote_chat', schema: round.final ? {
                type: 'object', properties: { action: { type: 'string', enum: ['say'] }, reply: { type: 'string', minLength: 1 },
                    reason: { type: 'string' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
                    partyIntent: DialogueParty.INTENT_SCHEMA },
                required: ['action', 'reply', 'reason', 'confidence'], additionalProperties: false
            } : schema(Boolean(payload.shop)) };
            if (!round.canRead) responseSchema.schema.properties.action.enum = responseSchema.schema.properties.action.enum
                .filter(action => !DialogueKnowledge.ACTIONS.includes(action));
            if (round.round > 0) responseSchema.schema.properties.action.enum = responseSchema.schema.properties.action.enum.filter(action => action !== 'none');
            const effectiveSchema = OpenRouterGateway.responseSchemaForConfig(responseSchema, cfg);
            const messages = DialogueProtocol.fitMessages(round.messages, effectiveSchema, round.maxPromptTokens);
            if (!messages) return { ok: false, reason: 'dialogue_prompt_budget' };
            const result = await OpenRouterGateway.request({
                config: cfg,
                circuitKey: `cold-chat:${botId}:${playerId}`,
                circuitBreaker: false,
                interactive: true,
                timeoutMs: 0,
                maxCompletionTokens: round.maxCompletionTokens,
                maxTotalCompletionTokens: round.maxTotalCompletionTokens,
                maxPromptTokens: round.maxPromptTokens,
                maxTotalPromptTokens: round.maxTotalPromptTokens,
                requestId: turn.turnId,
                sessionId,
                source: 'cold_chat',
                botId,
                playerId,
                turnId: turn.turnId,
                messages,
                responseSchema,
                repairSchema: true
            });
            return result.ok ? { ...result.data, usage: result.usage, accountedPromptTokens: result.accountedPromptTokens, llmTelemetry: result.telemetry,
                promptEstimate: DialogueProtocol.requestSize(messages, effectiveSchema) } : result;
        }
    });
    if (result.ok === false) {
        return {
            providerFailure: true,
            providerOutcome: result.reason,
            usage: result.usage,
            llmTelemetry: result.telemetry,
        };
    }
    return {
        data: result,
        usage: result.usage,
        llmTelemetry: result.llmTelemetry
    };
}

function validateLlmReply(result) {
    if (result?.providerFailure) return result;
    if (!result?.data) return null;

    const parsed = result.data;
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    const reply = BotChatText.normalize(parsed.reply)
        .slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
    if ((!reply && parsed.action !== 'none') || Number(parsed.confidence || 0) < 0.35) return null;

    return {
        ok: true,
        reply,
        action: parsed.action || 'say',
        reason: parsed.reason || 'llm',
        confidence: Number(parsed.confidence || 0),
        partyIntent: parsed.partyIntent,
        shopItemId: parsed.shopItemId,
        shopQuantity: parsed.shopQuantity,
        shopTotalPrice: parsed.shopTotalPrice,
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
    const actor = playerSession.actor;
    const run = () => {
        const PopulationService = invoke('GameServer/Bot/Population/PopulationService');
        const BotManager = invoke('GameServer/Bot/BotManager');
        const World = invoke('GameServer/World/World');
        const availability = BotAvailability.evaluateState(playerSession, state);
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
                if (playerSession.actor !== actor) return actorChanged();

                const ChatArrivalState = invoke('GameServer/Bot/AI/ChatArrivalState');
                // start refuses a bot without an actor or a player who went offline meanwhile.
                if (!ChatArrivalState.start(targetSession, playerSession)) {
                    return { ok: false, reason: 'arrival_not_started' };
                }
                return { ok: true, targetSession, activation };
            });
        });
    };
    return LangfuseTracing.withObservation(
        'bot.tool.come_to_player',
        (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({ player: playerSummary(playerSession), bot: stateSummary(state), playerLoc: playerLocation(playerSession) }) : null,
        (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({
            source: 'cold_chat',
            tool: 'come_to_player',
            botId: state.characterId,
            playerId: playerSession.actor.fetchId()
        }) : null,
        run,
        'tool'
    );
}

function recordReply(playerSession, state, turn, result, extra = {}) {
    if (!result?.reply) return Promise.resolve(false);
    // The turn belongs to the character that asked; never store its answer under another.
    if (Number(playerSession.actor?.fetchId?.()) !== Number(turn.playerId)) return Promise.resolve(false);
    const fallback = result.providerFailure === true ||
        result.isFallback === true ||
        result.reason === 'fallback' ||
        extra.fallback === true;
    return LangfuseTracing.withObservation(
        'bot.conversation.persist',
        (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({ botId: state.characterId, playerId: playerSession.actor.fetchId(), turnId: turn.turnId }) : null,
        (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({
            source: 'cold_chat',
            botId: state.characterId,
            playerId: playerSession.actor.fetchId(),
            turnId: turn.turnId,
            sessionId: `cold-bot:${Number(state.characterId || 0)}:player:${playerSession.actor.fetchId()}`
        }) : null,
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

function deliverReply(playerSession, state, text, actor) {
    if (!state || !playerSession?.dataSendToMe || playerSession.actor !== actor) return false;
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
    // The player may select another character while the reply is prepared:
    // the answer and any action belong only to the character that asked.
    const actor = playerSession.actor;
    const tradeChat = invoke('GameServer/Bot/Economy/BotAfkTradeChat');
    const tradeIntent = tradeChat.parse(state, text, playerSession);
    if (tradeIntent) {
        return BotConversationService.beginTurn({
            playerSession, botSession: state, text, channel, source: 'cold_shop_chat'
        }).then(async (turn) => {
            if (playerSession.actor !== actor) return actorChanged();
            const result = await tradeChat.handle(playerSession, state, tradeIntent);
            const delivered = deliverReply(playerSession, state, result.reply, actor);
            const reply = { ...result, delivered };
            await recordReply(playerSession, state, turn, reply, { deterministic: true });
            return reply;
        });
    }
    const cfg = config();
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
    ]).then(async ([turn, events]) => {
        if (playerSession.actor !== actor) return actorChanged();
        const memory = await BotSocialMemory.load(playerSession, state) || BotSocialMemory.getSnapshot(playerSession, state);
        if (playerSession.actor !== actor) return actorChanged();
        const self = await DialogueKnowledge.selfContext(state, text, turn.context);
        if (playerSession.actor !== actor) return actorChanged();
        const availability = BotAvailability.evaluateState(playerSession, state, { loadMemory: false });
        const fallback = { ok: true, reply: fallbackReply(state, availability, text),
            action: 'say', reason: 'fallback', isFallback: true };
        const payload = {
            event: 'cold_chat',
            playerMessage: String(text || '').slice(0, 240),
            player: playerSummary(playerSession),
            bot: { ...stateSummary(state), ...self },
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
            shop: tradeChat.context(state, playerSession),
            conversation: turn.context,
            constraints: {
                privateReply: true,
                remainColdUnlessCome: true,
                noCombatMicromanagement: true,
                noInventedFacts: true
            }
        };

        if (state.party?.partyId && isPlayerJoinRequest(text)) {
            return invoke('GameServer/Bot/AI/PlayerPartyTakeover').request({
                playerSession,
                target: state,
                source: channel || 'cold_chat'
            }).then((actionResult) => {
                const reply = {
                    ok: actionResult.ok,
                    reply: actionResult.reply,
                    reason: actionResult.reason,
                    action: 'request_player_join_party',
                    actionResult: {
                        ok: actionResult.ok,
                        reason: actionResult.reason,
                        partyId: actionResult.partyId || null,
                        count: actionResult.count || 0
                    }
                };
                const delivered = deliverReply(playerSession, state, reply.reply, actor);
                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
                    'BotParty :: remote join request player=%s speaker=%s party=%s result=%s applied=%s',
                    playerSession.actor.fetchName?.() || 'unknown',
                    state.name || state.characterId,
                    state.party?.partyId || actionResult.partyId || 'none',
                    actionResult.reason || 'unknown',
                    actionResult.applied === true
                );
                return recordReply(playerSession, state, turn, { ...reply, delivered }, {
                    deterministic: true,
                    actionResult: reply.actionResult
                }).then(() => ({ ...reply, delivered }));
            });
        }

        const llmReady = OpenRouterGateway.isConfigured(cfg);
        const estimatedPromptTokens = estimatePromptTokens({
            messages: [
                { role: 'system', content: systemPrompt(Boolean(payload.shop)) },
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
            (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({
                event: 'cold_chat',
                source: 'cold_chat',
                botId: state.characterId,
                playerId: playerSession.actor.fetchId(),
                turnId: turn.turnId,
                requestId: turn.turnId,
                sessionId: `cold-bot:${Number(state.characterId || 0)}:player:${playerSession.actor.fetchId()}`
            }) : null,
            async () => {
                const stageMetadata = (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({
                    event: 'cold_chat',
                    source: 'cold_chat',
                    botId: state.characterId,
                    playerId: playerSession.actor.fetchId(),
                    turnId: turn.turnId,
                    requestId: turn.turnId,
                    sessionId: `cold-bot:${Number(state.characterId || 0)}:player:${playerSession.actor.fetchId()}`
                }) : null;
                await LangfuseTracing.withObservation(
                    'bot.context.assemble',
                    (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({
                        event: 'cold_chat',
                        conversationTurns: payload.conversation?.recentTurns?.length || 0,
                        recentEvents: payload.recentEvents?.length || 0
                    }) : null,
                    stageMetadata,
                    async () => payload,
                    'chain'
                );

                const deliver = (reply, extra = {}) => LangfuseTracing.withObservation(
                    'bot.reply.deliver',
                    (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({
                        action: reply?.action || 'say',
                        reply: reply?.reply || null,
                        providerOutcome: reply?.providerOutcome || null
                    }) : null,
                    stageMetadata,
                    () => {
                        if (playerSession.actor !== actor) return actorChanged();
                        if (['say', 'none'].includes(reply?.action) && DialogueParty.shouldCheck(text, reply)) {
                            const hot = invoke('GameServer/Bot/BotManager').findSessionById(state.characterId);
                            const latest = hot?.actor ? hot : invoke('GameServer/Bot/Population/BotLifeState').cachedState(state.characterId) || state;
                            const current = latest.actor ? BotAvailability.evaluate(playerSession, latest, { loadMemory: false })
                                : BotAvailability.evaluateState(playerSession, latest, { loadMemory: false });
                            reply = DialogueParty.apply(reply, current, latest, text);
                        }
                        const delivered = deliverReply(playerSession, state, reply?.reply, actor);
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
                if (playerSession.actor !== actor) return actorChanged();
                if (!llmReady || !grantedAdmission?.ok) {
                    if (llmReady && !grantedAdmission?.ok) {
                        await LangfuseTracing.withObservation(
                            'bot.inference.admission',
                            (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({ event: 'cold_chat', estimatedPromptTokens }) : null,
                            (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({ ...stageMetadata, reason: grantedAdmission.reason, retryAfterMs: grantedAdmission.retryAfterMs || 0 }) : null,
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

                BotInferenceBudget.markStarted(reservation);
                const providerResult = await requestLlmReply(payload, cfg, turn, state, playerSession);
                const result = await LangfuseTracing.withObservation(
                    'bot.schema.validate',
                    (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) ? ({
                        event: 'cold_chat',
                        providerOutcome: providerResult?.llmTelemetry?.outcome || providerResult?.providerOutcome || null
                    }) : null,
                    stageMetadata,
                    async () => validateLlmReply(providerResult),
                    'chain'
                );
                if (playerSession.actor !== actor) {
                    return actorChanged({ usage: result?.usage || null, llmTelemetry: result?.llmTelemetry || null });
                }
                if (result?.providerFailure) {
                    if (DiagnosticConfig.developerDiagnostics) state.lastRemoteChatTelemetry = result.llmTelemetry || null;
                    const failed = {
                        ...fallback,
                        providerOutcome: result.providerOutcome,
                        usage: result.usage || null,
                        llmTelemetry: result.llmTelemetry || null,
                        isFallback: true
                    };
                    return deliver(failed);
                }
                let reply = result || fallback;
                const partyCheck = DialogueParty.shouldCheck(text, reply);
                const explicitArrival = reply.action === 'come_to_player' && DialogueParty.isArrivalRequest(text);
                if (partyCheck && explicitArrival) {
                    // Movement is separately authorized. Its receipt may
                    // acknowledge coming, never admission to a future party.
                    reply = { ...reply, reply: 'I am coming over.' };
                } else if (partyCheck && reply.action !== 'request_player_join_party') {
                    reply = DialogueParty.apply(reply, BotAvailability.evaluateState(playerSession,
                        invoke('GameServer/Bot/Population/BotLifeState').cachedState(state.characterId) || state,
                        { loadMemory: false }), state, text);
                }
                if (reply.action?.startsWith('shop_')) {
                    const intent = tradeChat.intentForAction(state, playerSession, reply.action, reply);
                    const actionResult = intent
                        ? await tradeChat.handle(playerSession, state, intent)
                        : { ok: false, reason: 'shop_unavailable',
                            reply: 'I have no active AFK shop to change right now.' };
                    return deliver({ ...reply, ...actionResult,
                        reason: actionResult.reason || actionResult.action || 'shop_action',
                        action: reply.action }, {
                        actionResult: { ok: actionResult.ok, reason: actionResult.reason || null,
                            action: actionResult.action || null }
                    });
                }
                if (reply.action === 'request_player_join_party') {
                    const actionResult = await invoke('GameServer/Bot/AI/PlayerPartyTakeover').request({
                        playerSession,
                        target: state,
                        source: channel || 'cold_chat'
                    });
                    return deliver({
                        ...reply,
                        ok: actionResult.ok,
                        reply: actionResult.reply,
                        reason: actionResult.reason,
                        action: 'request_player_join_party',
                        actionResult: {
                            ok: actionResult.ok,
                            reason: actionResult.reason,
                            partyId: actionResult.partyId || null,
                            count: actionResult.count || 0
                        }
                    }, {
                        actionResult: {
                            ok: actionResult.ok,
                            reason: actionResult.reason,
                            partyId: actionResult.partyId || null,
                            count: actionResult.count || 0
                        }
                    });
                }
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

        const actor = playerSession.actor;
        const key = `${actor.fetchId()}:${state.characterId}`;
        return enqueue(key, () => (playerSession.actor === actor
            ? replyForStateNow(playerSession, state, text, channel) : actorChanged()))
            .then((result) => {
                if (playerSession.actor !== actor) return result;
                BotSocialMemory.recordEvent(playerSession, state, 'chat', result.reason || 'remote_chat');
                return result;
            });
    }
};

module.exports = { ...BotRemoteChat, personaForState, fallbackReply };
