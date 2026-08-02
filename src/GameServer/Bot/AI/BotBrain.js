const SpotService    = invoke('GameServer/Bot/AI/SpotService');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotContextAssembler = invoke('GameServer/Bot/AI/BotContextAssembler');
const BotConversationService = invoke('GameServer/Bot/AI/BotConversationService');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');
const BotInferenceBudget = invoke('GameServer/Bot/AI/BotInferenceBudget');
const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');
const BotLLMTurnStore = invoke('GameServer/Bot/AI/BotLLMTurnStore');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');

const ALLOWED_PLANS = ['hunting', 'following', 'resting', 'shopping', 'pk_hunting', 'merchant', 'getting_buffed'];
const ALLOWED_EVENTS = new Set(['player_chat', 'state_change']);
function config() {
    return OpenRouterGateway.config({ maxTokens: 320 });
}

function debugSkip(session, cfg, reason) {
    if (!cfg.debug) return;

    const now = Date.now();
    if (session.lastBrainDebugAt && now - session.lastBrainDebugAt < 5000) return;

    session.lastBrainDebugAt = now;
    const name = session.actor?.fetchName?.() || session.accountId || 'unknown';
    utils.infoWarn('BotBrain', '%s skip: %s', name, reason);
}

function isRealPlayer(session) {
    return session &&
        session.actor &&
        session.actor.fetchIsOnline() &&
        session.accountId &&
        !session.accountId.startsWith('bot_');
}

function location(actor) {
    return {
        locX: actor.fetchLocX(),
        locY: actor.fetchLocY(),
        locZ: actor.fetchLocZ()
    };
}

function distance2d(a, b) {
    const dx = a.locX - b.locX;
    const dy = a.locY - b.locY;
    return Math.sqrt(dx * dx + dy * dy);
}

function compactPlayer(session, botLoc) {
    const actor = session.actor;
    const loc = location(actor);
    return {
        id: actor.fetchId(),
        name: actor.fetchName(),
        level: actor.fetchLevel(),
        hpPct: Math.round((actor.fetchHp() / actor.fetchMaxHp()) * 100),
        karma: typeof actor.fetchKarma === 'function' ? actor.fetchKarma() : 0,
        distance: Math.round(distance2d(loc, botLoc)),
        targetId: actor.fetchDestId ? actor.fetchDestId() : 0
    };
}

function visibleRealPlayers(session, bot, cfg = config(), requestContext = null) {
    if (!bot) return [];

    const World = invoke('GameServer/World/World');
    const botLoc = location(bot);
    const visible = World.fetchVisibleUsers(session, bot)
        .filter(isRealPlayer)
        .map((playerSession) => compactPlayer(playerSession, botLoc))
        .filter((player) => player.distance <= cfg.visibilityRadius)
        .sort((a, b) => a.distance - b.distance);

    const directSession = requestContext?.playerSession;
    if (isRealPlayer(directSession)) {
        const direct = compactPlayer(directSession, botLoc);
        if (!visible.some((player) => Number(player.id) === Number(direct.id))) visible.push(direct);
    }

    return visible.sort((a, b) => a.distance - b.distance);
}

function candidateSpots(status) {
    if (!status || !status.available || status.mode !== 'hunting') return [];

    return SpotService.ensureIndexed()
        .map((spot) => ({
            id: spot.id,
            name: spot.name,
            minLevel: spot.minLevel,
            maxLevel: spot.maxLevel,
            density: spot.density,
            distance: Math.round(SpotService.distance2d(status.loc, spot.center))
        }))
        .filter((spot) => spot.density >= 3)
        .filter((spot) => spot.minLevel <= status.level + 4 && spot.maxLevel >= status.level - 4)
        .sort((a, b) => {
            if (a.distance !== b.distance) return a.distance - b.distance;
            return b.density - a.density;
        })
        .slice(0, 6);
}

function schema(allowedActions = BotAgentTools.ACTIONS) {
    return {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: allowedActions
            },
            reply: {
                type: 'string',
                description: 'Short in-character bot reply. Empty string when no reply is needed. Long factual lists may be up to 360 chars.'
            },
            targetPlayerName: {
                type: 'string',
                description: 'Visible player name for follow_player, or empty string.'
            },
            spotId: {
                type: 'string',
                description: 'Candidate spot id for move_to_spot, or empty string.'
            },
            buffType: {
                type: 'string',
                enum: ['', 'might', 'shield', 'haste', 'windwalk'],
                description: 'Buff type for buff_target, or empty string.'
            },
            pullMode: {
                type: 'string',
                enum: ['', 'auto', 'leader', 'bot', 'off'],
                description: 'Temporary party pull mode for set_pull_policy.'
            },
            pullPermission: {
                type: 'string',
                enum: ['', 'allow', 'deny'],
                description: 'Temporary party pull permission for set_pull_policy.'
            },
            pullerId: {
                type: 'number',
                minimum: 0,
                description: 'Target companion actor id; normally the addressed bot.'
            },
            skillId: {
                type: 'number',
                minimum: 0,
                description: 'Learned offensive skill self id for priority tools.'
            },
            skillPriority: {
                type: 'number',
                minimum: -50,
                maximum: 50,
                description: 'Bounded temporary score weight. Zero clears the preference.'
            },
            combatStance: {
                type: 'string',
                enum: ['', 'balanced', 'aggressive', 'defensive', 'ranged'],
                description: 'Bounded offensive combat stance.'
            },
            itemId: {
                type: 'number',
                minimum: 0,
                description: 'Inventory object id for equip_candidate.'
            },
            tradeItemId: {
                type: 'number',
                minimum: 0,
                description: 'Inventory object id for offer_resources or update_trade_offer.'
            },
            tradeAmount: {
                type: 'number',
                minimum: 0,
                maximum: 10000,
                description: 'Bounded quantity for an outbound trade line.'
            },
            negotiationItemId: {
                type: 'number',
                minimum: 0,
                description: 'Actual bot inventory object id for quote_item.'
            },
            negotiationAmount: {
                type: 'number',
                minimum: 1,
                maximum: 100,
                description: 'Bounded quantity for a negotiated stock item.'
            },
            negotiationPrice: {
                type: 'number',
                minimum: 1,
                maximum: 1000000000,
                description: 'Total Adena price for a bounded counter or accepted quote.'
            },
            policyTtlMs: {
                type: 'number',
                minimum: 5000,
                maximum: 1800000,
                description: 'Optional hot policy lifetime, clamped by the server.'
            },
            reason: {
                type: 'string',
                description: 'Short private reason for logs/status.'
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1
            },
            worldRevision: {
                type: 'string',
                description: 'Echo the toolContext.worldRevision when selecting a mutating action.'
            }
        },
        required: ['action', 'reply', 'reason', 'confidence'],
        additionalProperties: false
    };
}

function systemPrompt() {
    return [
        'You are the interactive high-level dialogue brain for one Lineage 2 bot.',
        'The deterministic server code handles combat, pathfinding, HP/MP, loot, and safety.',
        'Only choose one small, high-level social or intent change for the explicit player message in this turn.',
        'Never invent a background request, ambient prompt, player intent, or private internal event.',
        'A player-facing reply must be grounded in the authoritative bot state and conversation context.',
        'follow_player only means approach a visible player unless the bot is already an invited party companion.',
        'For buff_target and heal_target, choose a visible player and let the server validate class, learned skill, MP, range, and safety.',
        'Do not claim that buffs or heals are ready in a plain chat reply. Use buff_target or heal_target; only the validated server action may confirm a cast.',
        'Party pull, skill preference, stance, and equipment tools are temporary hot-session controls. They require the current human party leader; never invent authority.',
        'Pull permission, pull mode, and assigned puller are separate. Unassigning one puller returns to the existing automatic policy and does not globally disable pulling.',
        'Skill priorities are bounded hints to the deterministic offensive scorer. Emergency healing, defense, resurrection, cooldowns, MP, range, and C4 compatibility always win.',
        'Equipment tools may only use safe candidates from actual inventory and native persistence. Never equip quest, incompatible, over-grade, or non-upgrade items.',
        'The persona describes tone and high-level preferences only. It never overrides safety, current game state, or the allowed actions.',
        'Ambient mood and intent are server-owned soft context. Treat an active ambient scene as factual only when bot.ambient.scene is present; never start or claim a scene from mood alone.',
        'The contextFragments field is bounded and includes recent authoritative events; treat summaries as memory, never as permission to perform an action. Action metadata is authoritative only when serverApplied or actionResult.ok is true.',
        'Resource-gift trade tools can open a native window only with the current party leader; negotiated market tools use only the active real player pair. Both reserve safe inventory without mutating it, expose only server-owned bounds, allow at most three negotiation rounds, and release reservations on cancel/expiry. Never claim completion before native player confirmation.',
        'Never invent unavailable actions, players, items, or spells.'
    ].join(' ');
}

function userPayload(event, session, status, visiblePlayers, text, requestContext = null) {
    const assembled = requestContext?.assembledContext;
    return {
        event,
        playerMessage: text || '',
        bot: assembled?.bot || BotBrainContext.compactStatus(session, status, text),
        visiblePlayers,
        candidateSpots: candidateSpots(status),
        allowedActions: BotAgentTools.availableActions(session),
        tools: BotAgentTools.toolDescriptions(session),
        toolContext: {
            worldRevision: BotAgentTools.worldRevision(session)
        },
        constraints: {
            keepReplyShort: true,
            splitLongRepliesIntoChatLines: true,
            avoidSpam: true,
            noCombatMicromanagement: true
        },
        conversation: requestContext?.conversation || null,
        contextFragments: assembled?.fragments || null,
        contextTelemetry: assembled?.telemetry || null,
        lastDecision: session.lastBrainDecision || null
    };
}

function estimatePromptTokens(payload) {
    try { return Math.max(1, Math.ceil(JSON.stringify(payload).length / 4)); } catch (_) { return 1; }
}

function estimateRequestPromptTokens(payload, session) {
    return estimatePromptTokens({
        messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        responseSchema: {
            name: 'bot_brain_decision',
            schema: schema(BotAgentTools.availableActions(session))
        }
    });
}

async function requestDecision(payload, cfg, session, requestContext, visiblePlayers) {
    const botId = session?.actor?.fetchId?.() || session?.accountId || 'unknown';
    const playerId = requestContext?.playerSession?.actor?.fetchId?.() ||
        requestContext?.playerId ||
        null;
    const result = await OpenRouterGateway.request({
        config: cfg,
        circuitKey: requestContext?.conversationTurn
            ? `hot-chat:${botId}:${playerId}`
            : 'hot-background',
        circuitBreaker: requestContext?.conversationTurn ? false : true,
        timeoutMs: requestContext?.conversationTurn ? 0 : cfg.timeoutMs,
        requestId: requestContext?.requestId || `hot-${botId}-${Date.now()}`,
        sessionId: `hot-bot:${botId}:player:${playerId || 'none'}`,
        source: requestContext?.source || requestContext?.channel || 'hot_brain',
        botId,
        playerId,
        turnId: requestContext?.conversationTurn?.turnId || requestContext?.requestId || null,
        messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        responseSchema: {
            name: 'bot_brain_decision',
            schema: schema(BotAgentTools.availableActions(session))
        }
    });

    if (!result.ok) return result;
    return {
        ...result.data,
        usage: result.usage,
        llmTelemetry: result.telemetry
    };
}

function conversationSessionId(session, requestContext) {
    const botId = session?.actor?.fetchId?.() || session?.accountId || 'unknown';
    const playerId = requestContext?.playerSession?.actor?.fetchId?.() ||
        requestContext?.playerId || 'none';
    return `hot-bot:${botId}:player:${playerId}`;
}

function compactActionResult(result) {
    if (!result) return null;
    return {
        ok: result.applied === true,
        reason: result.reason || null,
        idempotent: result.idempotent === true
    };
}

function recordConversationReply(session, decision, result, requestContext) {
    const turn = requestContext?.conversationTurn;
    const action = decision?.action;
    if (!turn || !result?.applied || !decision?.reply || ['buff_target', 'heal_target'].includes(action)) return;
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    const reply = BotChatText.normalize(decision.reply)
        .slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
    if (!reply) return;

    queueConversationWrite(session, () => BotConversationService.recordBotReply({
        playerSession: requestContext.playerSession,
        botSession: session,
        turnId: turn.turnId,
        channel: turn.channel,
        text: reply,
        requestId: requestContext.requestId,
        meta: { action, reason: result.reason || null, serverApplied: result.applied === true }
    }));
}

function queueConversationWrite(session, work) {
    const previous = session.lastConversationWrite || Promise.resolve();
    const next = previous.catch(() => {}).then(work).catch(() => false);
    session.lastConversationWrite = next;
    return next;
}

function applyDecision(session, decision, visiblePlayers, requestContext) {
    const result = BotAgentTools.execute(session, decision, visiblePlayers, requestContext);
    BotAgentTools.remember(session, decision, result, config().model);
    if (result.applied && decision.action === 'none' && decision.reply && requestContext?.playerSession?.actor) {
        // `none` means “no world mutation”, not “drop the player's message”.
        // A direct hot dialogue still needs a visible reply when the model
        // chooses to speak without selecting a tool.
        invoke('GameServer/Bot/BotManager').botTell(session, requestContext.playerSession, decision.reply);
    }
    recordConversationReply(session, decision, result, requestContext);
    if (!result.applied && requestContext?.playerSession?.actor) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const reply = BotAgentTools.rejectionReply(result);
        BotManager.botTell(session, requestContext.playerSession, reply);
        if (requestContext.conversationTurn) {
            queueConversationWrite(session, () => BotConversationService.recordFallback({
                playerSession: requestContext.playerSession,
                botSession: session,
                turnId: requestContext.conversationTurn.turnId,
                channel: requestContext.conversationTurn.channel,
                text: reply,
                reason: `tool_rejected:${result.reason}`
            }));
        }
    }
    return result;
}

function rememberTelemetry(session, result) {
    const telemetry = result?.llmTelemetry || result?.telemetry;
    if (!telemetry) return;

    session.lastBrainTelemetry = {
        ...telemetry,
        usage: result.usage || telemetry.usage || null
    };
}

function recordInferenceEvent(session, event, result, requestContext = null, extra = {}) {
    const botId = session?.actor?.fetchId?.();
    if (!botId) return;
    const telemetry = result?.llmTelemetry || result?.telemetry || {};
    const usage = result?.usage || telemetry.usage || {};
    const outcome = result?.ok === false
        ? result.reason || telemetry.outcome || 'provider_failure'
        : telemetry.outcome || 'success';
    const action = result?.action || null;
    const decisionReason = result?.reason || null;
    const requestId = telemetry.requestId || requestContext?.requestId || `${event}-${Date.now()}`;
    const playerId = requestContext?.playerSession?.actor?.fetchId?.() || requestContext?.playerId || null;
    const name = session.actor.fetchName?.() || 'bot';

    BotEventJournal.record({
        playerId,
        botId,
        eventType: 'llm_decision',
        summary: `${name} ${event} outcome=${outcome}${action ? ` action=${action}` : ''}`,
        dedupeKey: `request:${requestId}`,
        meta: {
            event,
            outcome,
            model: telemetry.model || config().model,
            action,
            reason: decisionReason,
            confidence: Number.isFinite(Number(result?.confidence)) ? Number(result.confidence) : null,
            latencyMs: Number(telemetry.latencyMs || 0),
            providerStatus: telemetry.status || null,
            usage: {
                promptTokens: Number(usage.promptTokens || 0),
                completionTokens: Number(usage.completionTokens || 0),
                totalTokens: Number(usage.totalTokens || 0),
                cost: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null
            },
            ...extra
        }
    }).catch(() => {});
}

function fallbackReply(session, requestContext, outcome) {
    const playerSession = requestContext?.playerSession;
    if (!playerSession?.actor || !session?.actor) return false;

    const BotManager = invoke('GameServer/Bot/BotManager');
    const plan = session.plan || 'hunting';
    const reply = outcome === 'timeout'
        ? 'Give me a moment. I am still sorting things out.'
        : String(outcome || '').startsWith('inference_budget_')
            ? 'Give me a moment. I have a lot to sort through right now.'
        : `I am ${plan} right now.`;

    BotManager.botTell(session, playerSession, reply);
    if (requestContext?.conversationTurn) {
        queueConversationWrite(session, () => BotConversationService.recordFallback({
            playerSession,
            botSession: session,
            turnId: requestContext.conversationTurn.turnId,
            channel: requestContext.conversationTurn.channel,
            text: reply,
            reason: outcome || 'fallback'
        }));
    }
    return reply;
}

const BotBrain = {
    isEnabled() {
        const cfg = config();
        return cfg.enabled && !!cfg.apiKey;
    },

    visibleRealPlayers,

    maybeThink(session, event, status, text = '', requestContext = null) {
        const cfg = config();
        const bot = session.actor;
        if (!bot) return false;
        if (!ALLOWED_EVENTS.has(event)) {
            debugSkip(session, cfg, `event_not_chat:${event}`);
            return false;
        }
        if (event !== 'player_chat' && cfg.backgroundInferenceEnabled !== true) {
            debugSkip(session, cfg, 'background_inference_disabled');
            return false;
        }
        if (!cfg.enabled) {
            debugSkip(session, cfg, 'disabled');
            return false;
        }
        if (!cfg.apiKey) {
            debugSkip(session, cfg, 'missing_api_key');
            return false;
        }
        if (session.brainInFlight) {
            if (requestContext?.conversationTurn) {
                const pending = {
                    event,
                    status,
                    text,
                    requestContext
                };
                const queue = session.pendingBrainTurns || (session.pendingBrainTurns = []);
                queue.push(pending);
                session.pendingBrainTurn = queue[0];
                debugSkip(session, cfg, 'request_queued');
                return true;
            }
            debugSkip(session, cfg, 'request_in_flight');
            return false;
        }
        if (event !== 'player_chat' && bot.isDead && bot.isDead()) {
            debugSkip(session, cfg, 'dead');
            return false;
        }
        if (session.plan === 'merchant' && event !== 'player_chat') {
            debugSkip(session, cfg, 'merchant_plan');
            return false;
        }
        if (event !== 'player_chat' && session.plan === 'getting_buffed') {
            debugSkip(session, cfg, 'refreshing_buffs');
            return false;
        }
        if (event !== 'player_chat' && !ALLOWED_PLANS.includes(session.plan || 'hunting')) {
            debugSkip(session, cfg, `plan_not_allowed:${session.plan}`);
            return false;
        }

        const visiblePlayers = visibleRealPlayers(session, bot, cfg, requestContext);
        if (visiblePlayers.length === 0) {
            debugSkip(session, cfg, 'no_visible_real_players');
            return false;
        }

        const cooldown = cfg.cooldownMs;
        const lastAt = session.lastBrainThinkAt;
        if (event !== 'player_chat' && lastAt && requestContext?.queued !== true && Date.now() - lastAt < cooldown) {
            debugSkip(session, cfg, `cooldown:${event}`);
            return false;
        }

        if (event === 'state_change' && Math.random() > 0.12) {
            debugSkip(session, cfg, 'ambient_sample_skip');
            return false;
        }

        if (event !== 'player_chat') {
            session.lastBrainThinkAt = Date.now();
        }

        const payload = userPayload(event, session, status, visiblePlayers, text, requestContext);
        const admission = BotInferenceBudget.reserve(session, {
            event,
            bypass: event === 'player_chat',
            priority: event === 'player_chat' ? 'interactive' : 'normal',
            estimatedPromptTokens: estimateRequestPromptTokens(payload, session),
            maxCompletionTokens: cfg.maxTokens
        });
        if (!admission.ok) {
            session.lastBrainBudget = {
                ...BotInferenceBudget.status(session),
                deniedReason: admission.reason,
                retryAfterMs: admission.retryAfterMs,
                at: Date.now()
            };
            BotEventJournal.record({
                botId: bot.fetchId?.(),
                eventType: 'llm_budget',
                summary: `${bot.fetchName?.() || 'bot'} inference denied: ${admission.reason}`,
                dedupeKey: `deny:${admission.reason}`,
                meta: { reason: admission.reason, retryAfterMs: admission.retryAfterMs }
            }).catch(() => {});
            debugSkip(session, cfg, admission.reason);
            fallbackReply(session, requestContext, admission.reason);
            return true;
        }

        session.brainInFlight = true;
        const turnId = requestContext?.conversationTurn?.turnId || requestContext?.requestId || `${event}:${bot.fetchId?.()}:${Date.now()}`;
        if (requestContext && !requestContext.requestId) requestContext.requestId = turnId;
        const turnPersistence = BotLLMTurnStore.begin({
            turnId,
            requestId: requestContext?.requestId || turnId,
            playerId: requestContext?.playerSession?.actor?.fetchId?.() || requestContext?.playerId,
            botId: bot.fetchId?.(),
            eventType: event,
            channel: requestContext?.channel,
            model: cfg.model,
            meta: { source: requestContext?.source || event }
        }).then(() => BotLLMTurnStore.markStarted({ turnId })).catch(() => false);
        if (requestContext?.assembledContext?.telemetry) {
            session.lastBrainContextTelemetry = {
                ...requestContext.assembledContext.telemetry,
                estimatedTokens: requestContext.assembledContext.estimatedTokens,
                budget: requestContext.assembledContext.budget,
                hardMaxTokens: requestContext.assembledContext.hardMaxTokens,
                at: Date.now()
            };
        }
        if (cfg.debug) {
            utils.infoSuccess('BotBrain', '%s requesting %s decision via %s', bot.fetchName(), event, cfg.model);
        }

        let providerResult = null;
        const finishTurn = () => {
            BotInferenceBudget.settle(admission.reservation, providerResult?.usage);
            const finalTelemetry = providerResult?.llmTelemetry || providerResult?.telemetry || {};
            turnPersistence.then(() => BotLLMTurnStore.finish({
                turnId,
                ok: providerResult?.ok !== false,
                outcome: providerResult?.ok === false ? providerResult.reason : finalTelemetry.outcome,
                model: finalTelemetry.model || cfg.model,
                traceId: finalTelemetry.traceId || null,
                usage: providerResult?.usage || finalTelemetry.usage,
                error: providerResult?.ok === false ? providerResult.reason : '',
                meta: {
                    event,
                    action: providerResult?.action || null,
                    traceId: finalTelemetry.traceId || null,
                    observationId: finalTelemetry.observationId || null,
                    finishReason: finalTelemetry.finishReason || null,
                    status: finalTelemetry.status || null
                }
            })).catch(() => {});
            session.lastBrainBudget = BotInferenceBudget.status(session);
            session.brainInFlight = false;
            const queue = session.pendingBrainTurns || [];
            const pending = queue.shift() || null;
            session.pendingBrainTurn = queue[0] || null;
            if (pending) {
                const startPending = () => Promise.resolve().then(async () => {
                    let requestContext = { ...pending.requestContext, queued: true };
                    // The player turn is persisted before admission, but the
                    // previous bot reply may finish while this request waits
                    // in the FIFO. Refresh the bounded context at dequeue so
                    // the next prompt sees the latest delivered turn.
                    if (pending.event === 'player_chat' && requestContext.playerSession) {
                        try {
                            const fresh = await BotConversationService.contextFor(
                                requestContext.playerSession,
                                session
                            );
                            const previousCount = requestContext.conversation?.recentTurns?.length || 0;
                            if ((fresh?.recentTurns?.length || 0) >= previousCount) {
                                requestContext.conversation = fresh;
                                requestContext.assembledContext = await BotContextAssembler.assemble({
                                    session,
                                    status: pending.status,
                                    text: pending.text,
                                    requestContext
                                });
                            }
                        } catch (_) {
                            // Keep the ingress snapshot if persistence is
                            // temporarily unavailable.
                        }
                    }
                    const started = BotBrain.maybeThink(
                        session,
                        pending.event,
                        pending.status,
                        pending.text,
                        requestContext
                    );
                    if (!started) fallbackReply(session, requestContext, 'queued_not_started');
                });
                Promise.resolve(session.lastConversationWrite)
                    .catch(() => {})
                    .then(startPending);
            }
        };
        const runTurn = async () => {
            try {
                providerResult = await requestDecision(payload, cfg, session, requestContext, visiblePlayers);
                recordInferenceEvent(session, event, providerResult, requestContext);
                rememberTelemetry(session, providerResult);
                if (providerResult?.ok === false) {
                    fallbackReply(session, requestContext, providerResult.reason);
                    return providerResult;
                }
                const actionResult = applyDecision(session, providerResult, visiblePlayers, requestContext);
                const playerVisibleReply = actionResult.applied
                    ? providerResult.reply || null
                    : BotAgentTools.rejectionReply(actionResult);
                providerResult = {
                    ...providerResult,
                    applied: actionResult.applied === true,
                    actionResult: compactActionResult(actionResult),
                    traceOutput: {
                        providerOutcome: providerResult.llmTelemetry?.outcome || providerResult.telemetry?.outcome || 'success',
                        requestedAction: providerResult.action || null,
                        toolOutcome: compactActionResult(actionResult),
                        applied: actionResult.applied === true,
                        playerVisibleReply
                    }
                };
                return providerResult;
            } catch (err) {
                providerResult = {
                    ok: false,
                    reason: 'provider_error',
                    telemetry: { outcome: 'provider_error' }
                };
                recordInferenceEvent(session, event, providerResult, requestContext);
                utils.infoWarn('BotBrain', 'decision request failed for %s: %s', bot.fetchName(), err.message);
                fallbackReply(session, requestContext, 'provider_error');
                return providerResult;
            } finally {
                finishTurn();
            }
        };
        LangfuseTracing.withRootObservation(
            'hot-bot.dialogue',
            payload,
            {
                event,
                botId: bot.fetchId?.(),
                playerId: requestContext?.playerSession?.actor?.fetchId?.() || requestContext?.playerId || null,
                turnId,
                requestId: requestContext?.requestId || turnId,
                source: requestContext?.source || event,
                sessionId: conversationSessionId(session, requestContext)
            },
            runTurn,
            'agent'
        ).catch((error) => {
            utils.infoWarn('Langfuse', 'hot-bot observation failed: %s', error.message);
        });

        return true;
    }
};

module.exports = BotBrain;
