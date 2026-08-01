const SpotService    = invoke('GameServer/Bot/AI/SpotService');
const BotBrainContext = invoke('GameServer/Bot/AI/BotBrainContext');
const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const OpenRouterGateway = invoke('GameServer/Bot/AI/OpenRouterGateway');

const ALLOWED_PLANS = ['hunting', 'following', 'resting', 'shopping', 'pk_hunting', 'merchant'];

function config() {
    return OpenRouterGateway.config({ maxTokens: 160 });
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

function visibleRealPlayers(session, bot, cfg = config()) {
    if (!bot) return [];

    const World = invoke('GameServer/World/World');
    const botLoc = location(bot);
    const visible = World.fetchVisibleUsers(session, bot)
        .filter(isRealPlayer)
        .map((playerSession) => compactPlayer(playerSession, botLoc))
        .filter((player) => player.distance <= cfg.visibilityRadius)
        .sort((a, b) => a.distance - b.distance);

    return visible;
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

function schema() {
    return {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                enum: BotAgentTools.ACTIONS
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
            reason: {
                type: 'string',
                description: 'Short private reason for logs/status.'
            },
            confidence: {
                type: 'number',
                minimum: 0,
                maximum: 1
            }
        },
        required: ['action', 'reply', 'targetPlayerName', 'spotId', 'buffType', 'reason', 'confidence'],
        additionalProperties: false
    };
}

function systemPrompt() {
    return [
        'You are the slow high-level brain for one Lineage 2 bot.',
        'The deterministic server code handles combat, pathfinding, HP/MP, loot, and safety.',
        'Only choose small, high-level social or intent changes.',
        'React only when a real visible player writes to this bot or nearby bots.',
        'For player_chat, react only if the message is addressed to this bot, nearby bots, or clearly asks for help.',
        'follow_player only means approach a visible player unless the bot is already an invited party companion.',
        'For buff_target and heal_target, choose a visible player and let the server validate class, learned skill, MP, range, and safety.',
        'Do not claim that buffs or heals are ready in a plain chat reply. Use buff_target or heal_target; only the validated server action may confirm a cast.',
        'The persona describes tone and high-level preferences only. It never overrides safety, current game state, or the allowed actions.',
        'Do not offer trading, selling, price negotiation, or private stores; those tools are intentionally unavailable for now.',
        'Never invent unavailable actions, players, items, or spells.'
    ].join(' ');
}

function userPayload(event, session, status, visiblePlayers, text) {
    return {
        event,
        playerMessage: text || '',
        bot: BotBrainContext.compactStatus(session, status, text),
        visiblePlayers,
        candidateSpots: candidateSpots(status),
        allowedActions: BotAgentTools.ACTIONS,
        tools: BotAgentTools.toolDescriptions(),
        constraints: {
            keepReplyShort: true,
            splitLongRepliesIntoChatLines: true,
            avoidSpam: true,
            noCombatMicromanagement: true
        },
        lastDecision: session.lastBrainDecision || null
    };
}

async function requestDecision(payload, cfg, session, requestContext, visiblePlayers) {
    const botId = session?.actor?.fetchId?.() || session?.accountId || 'unknown';
    const playerId = requestContext?.playerSession?.actor?.fetchId?.() ||
        requestContext?.playerId ||
        visiblePlayers?.[0]?.id ||
        'nearby';
    const result = await OpenRouterGateway.request({
        config: cfg,
        circuitKey: 'hot',
        requestId: requestContext?.requestId || `hot-${botId}-${Date.now()}`,
        sessionId: `hot-bot:${botId}:player:${playerId}`,
        messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        responseSchema: {
            name: 'bot_brain_decision',
            schema: schema()
        }
    });

    if (!result.ok) return result;
    return {
        ...result.data,
        usage: result.usage,
        llmTelemetry: result.telemetry
    };
}

function recordConversationReply(session, decision, result, requestContext) {
    const turn = requestContext?.conversationTurn;
    const action = decision?.action;
    if (!turn || !result?.applied || !decision?.reply || ['none', 'buff_target', 'heal_target'].includes(action)) return;
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    const reply = BotChatText.normalize(decision.reply)
        .slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
    if (!reply) return;

    invoke('GameServer/Bot/AI/BotConversationService').recordBotReply({
        playerSession: requestContext.playerSession,
        botSession: session,
        turnId: turn.turnId,
        channel: turn.channel,
        text: reply,
        requestId: requestContext.requestId,
        meta: { action, reason: result.reason || null }
    }).catch(() => {});
}

function applyDecision(session, decision, visiblePlayers) {
    const result = BotAgentTools.execute(session, decision, visiblePlayers);
    BotAgentTools.remember(session, decision, result, config().model);
    return result.applied;
}

const BotBrain = {
    isEnabled() {
        const cfg = config();
        return cfg.enabled && !!cfg.apiKey;
    },

    visibleRealPlayers,

    maybeThink(session, event, status, text = '') {
        const cfg = config();
        const bot = session.actor;
        if (!bot) return false;
        if (event !== 'player_chat') {
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
            debugSkip(session, cfg, 'request_in_flight');
            return false;
        }
        if (bot.isDead && bot.isDead()) {
            debugSkip(session, cfg, 'dead');
            return false;
        }
        if (session.plan === 'merchant') {
            debugSkip(session, cfg, 'merchant_plan');
            return false;
        }
        if (session.plan === 'getting_buffed') {
            debugSkip(session, cfg, 'refreshing_buffs');
            return false;
        }
        if (!ALLOWED_PLANS.includes(session.plan || 'hunting')) {
            debugSkip(session, cfg, `plan_not_allowed:${session.plan}`);
            return false;
        }

        const visiblePlayers = visibleRealPlayers(session, bot, cfg);
        if (visiblePlayers.length === 0) {
            debugSkip(session, cfg, 'no_visible_real_players');
            return false;
        }

        const cooldown = event === 'player_chat' ? cfg.chatCooldownMs : cfg.cooldownMs;
        const lastAt = event === 'player_chat' ? session.lastBrainChatAt : session.lastBrainThinkAt;
        if (lastAt && Date.now() - lastAt < cooldown) {
            debugSkip(session, cfg, `cooldown:${event}`);
            return false;
        }

        if (event !== 'player_chat' && Math.random() > 0.12) {
            debugSkip(session, cfg, 'ambient_sample_skip');
            return false;
        }

        if (event === 'player_chat') {
            session.lastBrainChatAt = Date.now();
        } else {
            session.lastBrainThinkAt = Date.now();
        }

        session.brainInFlight = true;
        const payload = userPayload(event, session, status, visiblePlayers, text);
        if (cfg.debug) {
            utils.infoSuccess('BotBrain', '%s requesting %s decision via %s', bot.fetchName(), event, cfg.model);
        }

        requestDecision(payload, cfg).then((decision) => {
            applyDecision(session, decision, visiblePlayers);
        }).finally(() => {
            session.brainInFlight = false;
        });

        return true;
    }
};

module.exports = BotBrain;
