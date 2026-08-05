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
const BotAvailability = invoke('GameServer/Bot/AI/BotAvailability');
const PartyDialogueState = invoke('GameServer/Bot/AI/PartyDialogueState');

const ALLOWED_EVENTS = new Set(['player_chat']);
function config() {
    return OpenRouterGateway.config();
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
    if (!status || !status.available) return [];

    let indexed;
    try {
        indexed = SpotService.ensureIndexed();
    } catch (_) {
        // Lightweight chat fixtures and startup windows may not have the
        // world spawn catalog loaded yet.  An empty candidate list is safer
        // than making the whole dialogue turn fail.
        return [];
    }

    return indexed
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

function merchantSchema(allowedActions) {
    return {
        type: 'object',
        properties: {
            action: { type: 'string', enum: allowedActions },
            reply: {
                type: 'string',
                description: 'Short in-character English merchant reply. State an exact total or unit price when discussing price.'
            },
            negotiationItemId: {
                type: 'number',
                minimum: 0,
                description: 'Exact selfId from bot.market.lines.'
            },
            negotiationAmount: {
                type: 'number',
                minimum: 1,
                maximum: 100,
                description: 'Exact quantity requested by the player, bounded by the listed count.'
            },
            negotiationPrice: {
                type: 'number',
                minimum: 1,
                maximum: 100000000000,
                description: 'Total Adena price for the whole negotiated quantity, never a unit price.'
            },
            reason: { type: 'string', description: 'Short private reason for telemetry.' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            worldRevision: {
                type: 'string',
                description: 'Echo toolContext.worldRevision for a mutating action.'
            }
        },
        required: ['action', 'reply', 'reason', 'confidence'],
        additionalProperties: false
    };
}

function schema(allowedActions = BotAgentTools.ACTIONS, session = null) {
    if (session?.plan === 'merchant') return merchantSchema(allowedActions);
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
                description: 'Exact learned friendly buff effect or name from bot.skills.support.availableBuffs for buff_target.'
            },
            buffPolicyType: {
                type: 'string',
                description: 'Exact learned friendly buff effect or name for set_buff_policy.'
            },
            buffPolicyMode: {
                type: 'string',
                enum: ['', 'allow', 'deny', 'clear'],
                description: 'Temporary support rotation policy for set_buff_policy.'
            },
            regroupRadius: {
                type: 'number',
                minimum: 40,
                maximum: 150,
                description: 'Compact radius around the party leader for regroup_party; use 50 unless the player specifies another value.'
            },
            pullMode: {
                type: 'string',
                enum: ['', 'auto', 'leader', 'bot', 'off'],
                description: 'Temporary party pull mode for set_pull_policy.'
            },
            tradeItemId: {
                type: 'number',
                minimum: 0,
                description: 'Inventory object id for give_resources, offer_resources, or update_trade_offer.'
            },
            tradeAmount: {
                type: 'number',
                minimum: 0,
                maximum: 10000,
                description: 'Bounded quantity for an outbound resource trade line.'
            },
            supplyItemId: {
                type: 'number',
                minimum: 0,
                description: 'Exact item template self id from the server-owned supply catalog for fetch_resources.'
            },
            supplyItemName: {
                type: 'string',
                description: 'Exact item name from the player request when the compact catalog does not contain the item; the server resolves it against all NPC-listed items.'
            },
            supplyAmount: {
                type: 'number',
                minimum: 1,
                maximum: 5000,
                description: 'Exact new quantity to buy and deliver for fetch_resources.'
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
                maximum: 100000000000,
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

function merchantSystemPrompt() {
    return [
        'You are one Lineage 2 player merchant speaking English to the real player who addressed you.',
        'This is a compact merchant-only turn. bot.market is authoritative; do not invent inventory, equipment, skills, party state, travel, or combat actions.',
        'Each bot.market.lines entry gives exact selfId, name, listed count, current unitPrice, preferredUnitPrice, minimumUnitPrice, relation, and rationale.',
        'A store title is flavor only. Never interpret title suffixes such as +1 or +2 as enchant level or quantity; use the exact structured lines.',
        'All negotiation prices sent to tools are total Adena for negotiationAmount. Compute total from the exact requested quantity.',
        'Never agree below minimumUnitPrice. Prefer preferredUnitPrice, but use relation and rationale to make a believable bounded deal.',
        'For a new offer at or above the minimum that you agree to, use accept_price with the exact selfId, quantity, total, and worldRevision.',
        'For a new offer below the minimum, use quote_item with the player total so the server creates the bounded counter. For a request without an offer, use quote_item.',
        'For an active negotiation, use counter_offer, accept_price, or decline_price. The server revalidates stock, bounds, store revision, and authority.',
        'A merchant sale is public: accept_price closes and republishes the store with only the agreed quantity at the agreed unit price. It does not reserve the item for this player and does not open native trade.',
        'Only say the store was relisted when accept_price succeeds. Keep replies brief and in character.'
    ].join(' ');
}

function systemPrompt(session = null) {
    if (session?.plan === 'merchant') return merchantSystemPrompt();
    return [
        'You are the interactive high-level dialogue brain for one Lineage 2 bot.',
        'The deterministic server code handles combat, pathfinding, HP/MP, loot, and safety.',
        'Only choose one small, high-level social or intent change for the explicit player message in this turn.',
        'Never invent a background request, ambient prompt, player intent, or private internal event.',
        'A player-facing reply must be grounded in the authoritative bot state and conversation context.',
        'follow_player only means approach a visible player unless the bot is already an invited party companion.',
        'For a whole-party request such as everybody come closer or regroup, use regroup_party once. For everyone stay here, use stay_party once. Both control all current companions server-side; never answer as if only this bot moved.',
        'For a non-party follow request, say that you are on your way unless the authoritative distance is already near the player; never claim to be beside them before arrival.',
        'For buff_target and heal_target, choose a visible player and let the server validate class, learned skill, MP, range, and safety.',
        'Do not claim that buffs or heals are ready in a plain chat reply. Use buff_target or heal_target; only the validated server action may confirm a cast.',
        'When the player asks to stop, allow, or exclude one learned buff from the support rotation, use set_buff_policy with the exact effect/name from bot.skills.support.availableBuffs and mode deny, allow, or clear. Do not claim a rotation changed after a plain say.',
        'Party pull, skill preference, stance, and equipment tools are temporary hot-session controls. They require the current human party leader; never invent authority.',
        'Pull permission, pull mode, and assigned puller are separate. Unassigning one puller returns to the existing automatic policy and does not globally disable pulling.',
        'When the player asks to stop pulling and return, prefer stop_pulling_and_return so both server mutations are applied as one bounded workflow.',
        'Skill priorities are bounded hints to the deterministic offensive scorer. Emergency healing, defense, resurrection, cooldowns, MP, range, and C4 compatibility always win.',
        'Equipment tools may only use safe candidates from actual inventory and native persistence. Never equip quest, incompatible, over-grade, or non-upgrade items.',
        'The persona describes tone and high-level preferences only. It never overrides safety, current game state, or the allowed actions.',
        'Ambient mood and intent are server-owned soft context. Treat an active ambient scene as factual only when bot.ambient.scene is present; never start or claim a scene from mood alone.',
        'The contextFragments field is bounded and includes recent authoritative events; treat summaries as memory, never as permission to perform an action. Action metadata is authoritative only when serverApplied or actionResult.ok is true.',
        'Resource-gift trade tools can open a native window only with the current party leader; give_resources opens the window and displays the requested line in one server action. Companion negotiation tools use only the active real player pair, reserve safe inventory without mutating it, expose only server-owned bounds, allow at most three negotiation rounds, and release reservations on cancel/expiry. Never claim completion before native player confirmation.',
        'When the party leader explicitly asks the bot to go to town and buy a new item, use fetch_resources with the exact selfId from the compact server-owned supply catalog (entries are [selfId, name, price, town]) and the requested quantity. If the compact catalog does not show the item, pass its exact requested name in supplyItemName; the server resolves it against the full NPC catalog. This buys a new quantity even if the bot already owns some; do not substitute give_resources from existing stock. If the server reports insufficient Adena, say how much is needed and wait for the player to transfer Adena before retrying. The server returns beside the leader and opens native trade only when the party is safe, so describe it as pending.',
        'For party candidate discovery, use the server-owned party.candidates list in the current payload and answer from it; do not assume a later tool result will be sent back to you in this turn.',
        'Never invent unavailable actions, players, items, or spells.'
    ].join(' ');
}

function userPayload(event, session, status, visiblePlayers, text, requestContext = null) {
    const assembled = requestContext?.assembledContext;
    const preparedWorldRevision = requestContext?.preparedWorldRevision ||
        requestContext?.worldRevision || BotAgentTools.worldRevision(session);
    const candidateRequest = isPartyCandidateRequest(text);
    const partyRequest = isPartyRequest(text);
    const availability = partyRequest && requestContext?.playerSession
        ? BotAvailability.evaluate(requestContext.playerSession, session)
        : null;
    const candidates = candidateRequest
        ? BotAgentTools.partyCandidates(requestContext.playerSession, session)
        : [];
    const merchantSlice = session?.plan === 'merchant';
    return {
        event,
        playerMessage: text || '',
        bot: assembled?.bot || (merchantSlice
            ? BotBrainContext.compactMerchantStatus(session, status, requestContext.playerSession)
            : BotBrainContext.compactStatus(session, status, text)),
        visiblePlayers,
        party: !merchantSlice && (partyRequest || candidateRequest) ? {
            intent: candidateRequest ? 'candidate_discovery' : 'membership',
            availability: availability ? {
                available: availability.available === true,
                reason: availability.reason || null,
                reasonText: availability.reasonText || null,
                distance: availability.distance === null ? null : Math.round(availability.distance)
            } : null,
            candidates
        } : null,
        candidateSpots: merchantSlice ? [] : candidateSpots(status),
        allowedActions: BotAgentTools.availableActions(session),
        tools: BotAgentTools.toolDescriptions(session),
        toolContext: {
            worldRevision: preparedWorldRevision
        },
        constraints: merchantSlice ? {
            keepReplyShort: true,
            englishOnly: true,
            publicStoreSale: true,
            noInventoryReservation: true
        } : {
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
            { role: 'system', content: systemPrompt(session) },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        responseSchema: {
            name: 'bot_brain_decision',
            schema: schema(BotAgentTools.availableActions(session), session)
        },
        repairSchema: true
    });
}

async function requestDecision(payload, cfg, session, requestContext, visiblePlayers) {
    const botId = session?.actor?.fetchId?.() || session?.accountId || 'unknown';
    const playerId = requestContext?.playerSession?.actor?.fetchId?.() ||
        requestContext?.playerId ||
        null;
    const result = await OpenRouterGateway.request({
        config: cfg,
        circuitKey: `hot-chat:${botId}:${playerId}`,
        circuitBreaker: false,
        interactive: true,
        timeoutMs: 0,
        requestId: requestContext?.requestId || `hot-${botId}-${Date.now()}`,
        sessionId: `hot-bot:${botId}:player:${playerId || 'none'}`,
        source: requestContext?.source || requestContext?.channel || 'hot_brain',
        botId,
        playerId,
        turnId: requestContext?.conversationTurn?.turnId || requestContext?.requestId || null,
        messages: [
            { role: 'system', content: systemPrompt(session) },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        responseSchema: {
            name: 'bot_brain_decision',
            schema: schema(BotAgentTools.availableActions(session), session)
        },
        repairSchema: true
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
    const confirmed = result.applied === true && result.outcome !== 'pending';
    const compact = {
        ok: confirmed,
        reason: result.reason || null,
        idempotent: result.idempotent === true,
        replyDelivered: result.replyDelivered === true
    };
    if (result.outcome) compact.outcome = result.outcome;
    if (result.effect) compact.effect = result.effect;
    return compact;
}

function orderedConversation(conversation) {
    if (!conversation?.recentTurns?.length) return conversation;
    const groups = new Map();
    conversation.recentTurns.forEach((turn, index) => {
        const key = turn.turnId || `anonymous:${index}`;
        const group = groups.get(key) || { firstIndex: index, turns: [] };
        group.turns.push({ turn, index });
        groups.set(key, group);
    });
    const recentTurns = [...groups.values()]
        .sort((left, right) => left.firstIndex - right.firstIndex)
        .flatMap((group) => group.turns
            .sort((left, right) => {
                const leftRole = left.turn.role === 'player' ? 0 : 1;
                const rightRole = right.turn.role === 'player' ? 0 : 1;
                return leftRole - rightRole || left.index - right.index;
            })
            .map(({ turn }) => turn));
    return { ...conversation, recentTurns };
}

function validateDecisionResult(result, session) {
    if (result?.ok === false) return result;
    const action = String(result?.action || '');
    const allowed = BotAgentTools.availableActions(session);
    if (!action || !allowed.includes(action) || typeof result?.reply !== 'string') {
        return {
            ...result,
            ok: false,
            reason: 'schema_error',
            telemetry: {
                ...(result?.llmTelemetry || result?.telemetry || {}),
                outcome: 'schema_error',
                validation: 'decision_shape'
            }
        };
    }
    return result;
}

function isPartyCandidateRequest(text) {
    const value = String(text || '');
    const candidateMarker = /\b(?:other|another|anyone|anybody|somebody|someone|who|other\s+bots?)\b|кто|друг(?:ие|их)?\s+(?:бот|игрок)|друг(?:ие|их)?\s+боты/i;
    const partyMarker = /\b(?:party|group|team|join|invite|member|bot|player)s?\b|пати|групп|команд|присоедин|игрок/i;
    return candidateMarker.test(value) && partyMarker.test(value);
}

function isPartyRequest(text) {
    const value = String(text || '');
    if (isPartyCandidateRequest(value)) return false;
    // Membership requests are distinct from ordinary party context such as
    // “find a better hunting spot for this party” or “the party is in town”.
    // Applying membership policy to those messages silently replaced the LLM
    // answer with “I am already with you”.
    return /\b(?:join|invite|join\s+(?:our|the)\s+(?:party|group|team)|party\s+up|group\s+up|add\s+me|take\s+me|let\s+me\s+join|(?:wanna|want(?:\s+to)?|can\s+i|could\s+i|need)\s+(?:join|party|group|team))\b|пати\s*(?:вступ|присоедин|инвайт)|присоедин/i.test(value);
}

function applyPartyPolicy(session, decision, requestContext, text) {
    if (!requestContext?.playerSession) return decision;
    const value = String(text || '').toLowerCase();
    const group = /\b(?:everyone|everybody|all|guys|bots|companions|party|team)\b/.test(value);
    const positionHold = /\b(?:stay|wait|hold)\b/.test(value) &&
        (/(?:\b(?:here|there|position|spot|together|close)\b)/.test(value) || /\bhold\s+position\b/.test(value));
    if (group && positionHold) {
        return {
            ...decision,
            action: 'stay_party',
            reply: String(decision.reply || '').trim() || 'Everyone hold here.',
            reason: 'party_policy:whole_party_hold',
            confidence: Math.max(0.95, Number(decision.confidence || 0))
        };
    }
    if (group && /\b(?:come|closer|regroup|follow)\b/.test(value)) {
        return {
            ...decision,
            action: 'regroup_party',
            reply: String(decision.reply || '').trim() || 'Regrouping around you.',
            reason: 'party_policy:whole_party_regroup',
            confidence: Math.max(0.95, Number(decision.confidence || 0))
        };
    }
    if (!isPartyRequest(text)) return decision;
    if (session.partyCompanion === true && session.followPlayerSession === requestContext.playerSession) {
        return {
            ...decision,
            action: 'say',
            reply: 'I am already with you. Let me know what you need.',
            reason: 'party_policy:already_grouped',
            confidence: Math.max(0.9, Number(decision.confidence || 0))
        };
    }

    const availability = BotAvailability.evaluate(requestContext.playerSession, session);
    const reply = availability.available
        ? String(decision.reply || '').trim() || 'I am open to a party. Send me an invite and I will decide in the moment.'
        : `I cannot join right now: ${availability.reasonText || availability.reason || 'not available'}.`;
    return {
        ...decision,
        action: 'say',
        reply,
        targetPlayerName: requestContext.playerSession.actor.fetchName?.() || decision.targetPlayerName || '',
        reason: `party_policy:${availability.reason || 'available'}`,
        confidence: Math.max(0.9, Number(decision.confidence || 0))
    };
}

function recordConversationReply(session, decision, result, requestContext) {
    const turn = requestContext?.conversationTurn;
    const action = decision?.action;
    const visibleReply = result?.playerVisibleReply || decision?.reply;
    if (!turn || !result?.applied || result.replyDelivered !== true || !visibleReply || ['buff_target', 'heal_target'].includes(action)) return;
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    const reply = BotChatText.normalize(visibleReply)
        .slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
    if (!reply) return;

    queueConversationWrite(session, () => BotConversationService.recordBotReply({
        playerSession: requestContext.playerSession,
        botSession: session,
        turnId: turn.turnId,
        channel: turn.channel,
        text: reply,
        requestId: requestContext.requestId,
        meta: {
            action,
            reason: result.reason || null,
            serverApplied: result.applied === true && result.outcome !== 'pending',
            actionResult: compactActionResult(result)
        }
    }));
}

function recordDialogueDelivery(session, reply, requestContext) {
    if (!reply || !requestContext?.playerSession || !requestContext?.conversationTurn) return;
    PartyDialogueState.recordDeliveredReply(
        requestContext.playerSession,
        session,
        reply,
        {
            turnId: requestContext.conversationTurn.turnId,
            channel: requestContext.conversationTurn.channel
        }
    );
}

function queueConversationWrite(session, work, metadata = {}) {
    const previous = session.lastConversationWrite || Promise.resolve();
    const persist = () => LangfuseTracing.withObservation(
        'bot.conversation.persist',
        { botId: session?.actor?.fetchId?.() || session?.accountId || null },
        {
            botId: session?.actor?.fetchId?.() || session?.accountId || null,
            source: 'hot_dialogue',
            ...metadata
        },
        work,
        'chain'
    );
    const next = previous.catch(() => {}).then(persist).catch(() => false);
    session.lastConversationWrite = next;
    return next;
}

async function applyDecision(session, decision, visiblePlayers, requestContext) {
    let result = await BotAgentTools.execute(session, decision, visiblePlayers, requestContext);
    BotAgentTools.remember(session, decision, result, config().model);
    const playerSession = requestContext?.playerSession;
    let playerVisibleReply = null;
    if (result.applied) {
        // Skill requests are confirmed by the native cast/effect path. Do not
        // persist or claim the model's speculative reply before that happens.
        if (!['buff_target', 'heal_target'].includes(decision.action)) {
            playerVisibleReply = result.outcome === 'pending'
                ? (result.playerVisibleReply || BotAgentTools.pendingReply(result))
                : (result.playerVisibleReply || decision.reply || null);
            if (result.replyDelivered !== true && playerVisibleReply && playerSession?.actor) {
                invoke('GameServer/Bot/BotManager').botTell(session, playerSession, playerVisibleReply);
                result = { ...result, replyDelivered: true, playerVisibleReply };
            }
            if (result.replyDelivered === true) recordDialogueDelivery(session, playerVisibleReply, requestContext);
            recordConversationReply(session, decision, result, requestContext);
        }
        return { ...result, playerVisibleReply };
    }
    if (!result.applied && requestContext?.playerSession?.actor) {
        const BotManager = invoke('GameServer/Bot/BotManager');
        const reply = BotAgentTools.rejectionReply(result);
        BotManager.botTell(session, requestContext.playerSession, reply);
        playerVisibleReply = reply;
        recordDialogueDelivery(session, reply, requestContext);
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
    return { ...result, replyDelivered: !!playerVisibleReply, playerVisibleReply };
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

function fallbackReply(session, requestContext, outcome, persistMetadata = {}) {
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
    recordDialogueDelivery(session, reply, requestContext);
    if (requestContext?.conversationTurn) {
        queueConversationWrite(
            session,
            () => BotConversationService.recordFallback({
                playerSession,
                botSession: session,
                turnId: requestContext.conversationTurn.turnId,
                channel: requestContext.conversationTurn.channel,
                text: reply,
                reason: outcome || 'fallback'
            }),
            persistMetadata
        );
    }
    return reply;
}

function tracePreProviderFallback(session, requestContext, outcome, playerMessage = '', failure = null) {
    const botId = session?.actor?.fetchId?.() || session?.accountId || null;
    const playerId = requestContext?.playerSession?.actor?.fetchId?.() || requestContext?.playerId || null;
    const turnId = requestContext?.conversationTurn?.turnId || requestContext?.requestId || null;
    const metadata = {
        event: 'player_chat',
        source: requestContext?.source || requestContext?.channel || 'player_chat',
        channel: requestContext?.channel || requestContext?.conversationTurn?.channel || null,
        botId,
        playerId,
        turnId,
        requestId: requestContext?.requestId || turnId,
        sessionId: conversationSessionId(session, requestContext),
        providerOutcome: outcome || 'pre_provider_error',
        preProviderFallback: true,
        error: failure?.message || null
    };
    let fallbackDelivered = false;

    return LangfuseTracing.withRootObservation(
        'hot-bot.dialogue',
        {
            event: 'player_chat',
            playerMessage: playerMessage || '',
            conversation: requestContext?.conversation || null
        },
        metadata,
        async () => {
            const delivery = await LangfuseTracing.withObservation(
                'bot.reply.deliver',
                { action: 'fallback', reason: outcome || 'pre_provider_error' },
                metadata,
                async () => {
                    const reply = fallbackReply(session, requestContext, outcome, metadata);
                    fallbackDelivered = !!reply;
                    return { ok: !!reply, reply: reply || null, delivered: !!reply };
                },
                'chain'
            );
            await Promise.resolve(session?.lastConversationWrite).catch(() => false);
            return {
                ok: delivery?.delivered === true,
                applied: false,
                reason: outcome || 'pre_provider_error',
                traceOutput: {
                    providerOutcome: outcome || 'pre_provider_error',
                    requestedAction: null,
                    toolOutcome: null,
                    applied: false,
                    playerVisibleReply: delivery?.reply || null,
                    replyDelivered: delivery?.delivered === true,
                    error: failure?.message || null
                }
            };
        },
        'agent'
    ).catch(async (traceError) => {
        utils.infoWarn('Langfuse', 'pre-provider fallback trace failed for %s: %s', session?.actor?.fetchName?.() || 'bot', traceError.message);
        if (!fallbackDelivered) {
            try { fallbackReply(session, requestContext, outcome, metadata); } catch (_) { /* original failure is already logged */ }
        }
        await Promise.resolve(session?.lastConversationWrite).catch(() => false);
        return false;
    });
}

const BotBrain = {
    isEnabled() {
        const cfg = config();
        return cfg.enabled && !!cfg.apiKey;
    },

    applyPartyPolicy,
    isPartyRequest,
    isPartyCandidateRequest,

    visibleRealPlayers,

    maybeThink(session, event, status, text = '', requestContext = null) {
        const cfg = config();
        const bot = session.actor;
        if (!bot) return false;
        if (!ALLOWED_EVENTS.has(event)) {
            debugSkip(session, cfg, `event_not_chat:${event}`);
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

        const visiblePlayers = visibleRealPlayers(session, bot, cfg, requestContext);
        if (visiblePlayers.length === 0) {
            debugSkip(session, cfg, 'no_visible_real_players');
            return false;
        }

        if (requestContext && !requestContext.enqueuedAt) requestContext.enqueuedAt = Date.now();

        if (requestContext) {
            requestContext.preparedWorldRevision = BotAgentTools.worldRevision(session);
            requestContext.worldRevision = requestContext.preparedWorldRevision;
        }
        const payload = userPayload(event, session, status, visiblePlayers, text, requestContext);
        const estimatedPromptTokens = estimateRequestPromptTokens(payload, session);
        const admission = BotInferenceBudget.reserve(session, {
            event,
            bypass: true,
            priority: 'interactive',
            estimatedPromptTokens,
            maxCompletionTokens: 0
        });
        if (!admission.ok) {
            LangfuseTracing.withObservation(
                'bot.inference.admission',
                { event, estimatedPromptTokens },
                {
                    event,
                    source: requestContext?.source || event,
                    botId: bot.fetchId?.(),
                    playerId: requestContext?.playerSession?.actor?.fetchId?.() || requestContext?.playerId || null,
                    turnId: requestContext?.conversationTurn?.turnId || requestContext?.requestId || null,
                    reason: admission.reason,
                    retryAfterMs: admission.retryAfterMs || 0
                },
                async () => ({ ok: false, reason: admission.reason, retryAfterMs: admission.retryAfterMs || 0 }),
                'chain'
            ).catch(() => {});
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
        let reservation = admission.reservation;
        const admissionReady = admission.ready
            ? admission.ready.then((granted) => {
                reservation = granted?.reservation || null;
                return granted;
            })
            : Promise.resolve(admission);
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
            BotInferenceBudget.settle(reservation, providerResult?.usage);
            const finalTelemetry = providerResult?.llmTelemetry || providerResult?.telemetry || {};
            const actionResult = providerResult?.actionResult || null;
            const turnOutcome = providerResult?.ok === false
                ? providerResult.reason
                : actionResult
                    ? providerResult.toolApplied === false
                        ? `tool_rejected:${actionResult.reason || 'unknown'}`
                        : actionResult.outcome === 'pending'
                            ? `tool_pending:${actionResult.reason || providerResult.action || 'action'}`
                            : `tool_applied:${actionResult.reason || providerResult.action || 'action'}`
                    : finalTelemetry.outcome || 'success';
            turnPersistence.then(() => BotLLMTurnStore.finish({
                turnId,
                ok: providerResult?.ok !== false && providerResult?.toolApplied !== false,
                outcome: turnOutcome,
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
                    status: finalTelemetry.status || null,
                    toolOutcome: actionResult?.outcome || null,
                    toolReason: actionResult?.reason || null
                }
            })).catch(() => {});
            session.lastBrainBudget = BotInferenceBudget.status(session);
            session.brainInFlight = false;
            const queue = session.pendingBrainTurns || [];
            const pending = queue.shift() || null;
            session.pendingBrainTurn = queue[0] || null;
            if (pending) {
                const startPending = (nextPending) => Promise.resolve().then(async () => {
                    let requestContext = { ...nextPending.requestContext, queued: true };
                    let pendingStatus = nextPending.status;
                    // The player turn is persisted before admission, but the
                    // previous bot reply may finish while this request waits
                    // in the FIFO. Refresh the bounded context at dequeue so
                    // the next prompt sees the latest delivered turn.
                    if (nextPending.event === 'player_chat' && requestContext.playerSession) {
                        try {
                            const BotAI = invoke('GameServer/Bot/BotAI');
                            pendingStatus = BotAI.getStatus(session) || pendingStatus;
                        } catch (_) {
                            // Keep the ingress status if the live snapshot is unavailable.
                        }
                        try {
                            const fresh = await BotConversationService.contextFor(
                                requestContext.playerSession,
                                session
                            );
                            const previousCount = requestContext.conversation?.recentTurns?.length || 0;
                            if ((fresh?.recentTurns?.length || 0) >= previousCount) {
                                requestContext.conversation = fresh;
                            }
                        } catch (_) {
                            // Keep the ingress snapshot if persistence is
                            // temporarily unavailable.
                        }
                        requestContext.conversation = orderedConversation(requestContext.conversation);
                        requestContext.assembledContext = await BotContextAssembler.assemble({
                            session,
                            status: pendingStatus,
                            text: nextPending.text,
                            requestContext
                        });
                    }
                    const started = BotBrain.maybeThink(
                        session,
                        nextPending.event,
                        pendingStatus,
                        nextPending.text,
                        requestContext
                    );
                    if (!started) {
                        await tracePreProviderFallback(session, requestContext, 'queued_not_started', nextPending.text);
                    }
                });
                const continuePending = (nextPending) => Promise.resolve(session.lastConversationWrite)
                    .catch(() => {})
                    .then(() => startPending(nextPending))
                    .catch(async (error) => {
                        utils.infoWarn('BotBrain', 'queued dialogue failed for %s: %s', bot.fetchName(), error.message);
                        await tracePreProviderFallback(
                            session,
                            nextPending.requestContext,
                            'queued_context_error',
                            nextPending.text,
                            error
                        );

                        const following = queue.shift() || null;
                        session.pendingBrainTurn = queue[0] || null;
                        return following ? continuePending(following) : false;
                    });
                continuePending(pending).catch((error) => {
                    utils.infoWarn('BotBrain', 'queued dialogue drain failed for %s: %s', bot.fetchName(), error.message);
                });
            }
        };
        const runTurn = async () => {
            try {
                const grantedAdmission = await admissionReady;
                if (!grantedAdmission?.ok) {
                    providerResult = {
                        ok: false,
                        reason: grantedAdmission?.reason || 'inference_budget_unavailable',
                        telemetry: { outcome: grantedAdmission?.reason || 'inference_budget_unavailable' }
                    };
                    return providerResult;
                }
                const stageMetadata = {
                    event,
                    source: requestContext?.source || event,
                    channel: requestContext?.channel || null,
                    botId: bot.fetchId?.(),
                    playerId: requestContext?.playerSession?.actor?.fetchId?.() || requestContext?.playerId || null,
                    turnId,
                    requestId: requestContext?.requestId || turnId,
                    sessionId: conversationSessionId(session, requestContext)
                };
                await LangfuseTracing.withObservation(
                    'bot.context.assemble',
                    {
                        event,
                        playerMessage: text || '',
                        fragments: requestContext?.assembledContext?.telemetry?.included || [],
                        estimatedTokens: requestContext?.assembledContext?.estimatedTokens || null
                    },
                    stageMetadata,
                    async () => requestContext?.assembledContext || null,
                    'chain'
                );
                const providerDecision = await requestDecision(payload, cfg, session, requestContext, visiblePlayers);
                providerResult = await LangfuseTracing.withObservation(
                    'bot.schema.validate',
                    { event, providerOutcome: providerDecision?.telemetry?.outcome || providerDecision?.llmTelemetry?.outcome || null },
                    stageMetadata,
                    async () => validateDecisionResult(providerDecision, session),
                    'chain'
                );
                rememberTelemetry(session, providerResult);
                if (providerResult?.ok === false) {
                    recordInferenceEvent(session, event, providerResult, requestContext);
                    const playerVisibleReply = fallbackReply(session, requestContext, providerResult.reason);
                    providerResult = {
                        ...providerResult,
                        applied: false,
                        traceOutput: {
                            providerOutcome: providerResult.reason || providerResult.telemetry?.outcome || 'provider_error',
                            requestedAction: null,
                            toolOutcome: null,
                            applied: false,
                            playerVisibleReply: playerVisibleReply || null
                        }
                    };
                    return providerResult;
                }
                providerResult = applyPartyPolicy(session, providerResult, requestContext, text);
                recordInferenceEvent(session, event, providerResult, requestContext);
                const actionResult = await LangfuseTracing.withObservation(
                    'bot.tool.execute',
                    {
                        action: providerResult.action || null,
                        confidence: providerResult.confidence || null,
                        worldRevision: requestContext?.preparedWorldRevision || null
                    },
                    stageMetadata,
                    async () => applyDecision(session, providerResult, visiblePlayers, requestContext),
                    'tool'
                );
                const playerVisibleReply = actionResult.playerVisibleReply ||
                    (actionResult.applied && actionResult.replyDelivered ? providerResult.reply || null : null) ||
                    (!actionResult.applied ? BotAgentTools.rejectionReply(actionResult) : null);
                await LangfuseTracing.withObservation(
                    'bot.reply.deliver',
                    {
                        action: providerResult.action || null,
                        reply: playerVisibleReply,
                        applied: actionResult.applied === true,
                        delivered: actionResult.replyDelivered === true
                    },
                    stageMetadata,
                    async () => playerVisibleReply,
                    'chain'
                );
                providerResult = {
                    ...providerResult,
                    applied: actionResult.applied === true && actionResult.outcome !== 'pending',
                    toolApplied: actionResult.applied === true,
                    actionResult: compactActionResult(actionResult),
                    traceOutput: {
                        providerOutcome: providerResult.llmTelemetry?.outcome || providerResult.telemetry?.outcome || 'success',
                        requestedAction: providerResult.action || null,
                        toolOutcome: compactActionResult(actionResult),
                        applied: actionResult.applied === true && actionResult.outcome !== 'pending',
                        toolApplied: actionResult.applied === true,
                        playerVisibleReply,
                        replyDelivered: actionResult.replyDelivered === true
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
                const playerVisibleReply = fallbackReply(session, requestContext, 'provider_error');
                providerResult.traceOutput = {
                    providerOutcome: 'provider_error',
                    requestedAction: null,
                    toolOutcome: null,
                    applied: false,
                    playerVisibleReply: playerVisibleReply || null
                };
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
                sessionId: conversationSessionId(session, requestContext),
                queueWaitMs: requestContext?.enqueuedAt
                    ? Math.max(0, Date.now() - requestContext.enqueuedAt)
                    : 0
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
