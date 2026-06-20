const ServerResponse = invoke('GameServer/Network/Response');
const SpotService    = invoke('GameServer/Bot/AI/SpotService');

const ALLOWED_PLANS = ['hunting', 'following', 'resting', 'shopping', 'pk_hunting', 'merchant'];
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

function bool(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function num(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function config() {
    const optn = options.default.OpenRouter || {};
    return {
        enabled: bool(optn.enabled, false),
        apiKey: process.env.OPENROUTER_API_KEY || optn.apiKey || '',
        model: process.env.OPENROUTER_MODEL || optn.model || 'google/gemini-2.5-flash-lite',
        temperature: num(optn.temperature, 0.35),
        maxTokens: num(optn.maxTokens, 160),
        timeoutMs: num(optn.timeoutMs, 3500),
        cooldownMs: num(optn.cooldownMs, 45000),
        chatCooldownMs: num(optn.chatCooldownMs, 12000),
        visibilityRadius: num(optn.visibilityRadius, 6000),
        maxPromptPrice: num(optn.maxPromptPrice, 0),
        maxCompletionPrice: num(optn.maxCompletionPrice, 0),
        debug: bool(optn.debug, false)
    };
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

function compactStatus(status) {
    if (!status || !status.available) return status;
    return {
        name: status.name,
        level: status.level,
        classId: status.classId,
        mode: status.mode,
        intent: status.intent,
        role: status.role,
        vitals: {
            hpPct: Math.round(status.vitals.hpPct * 100),
            mpPct: Math.round(status.vitals.mpPct * 100)
        },
        target: status.target ? {
            type: status.target.type,
            name: status.target.name || null,
            level: status.target.level || null,
            dead: status.target.dead,
            distance: status.target.distance ? Math.round(status.target.distance) : null
        } : null,
        party: status.party ? {
            leader: status.party.leader?.name || null,
            stance: status.party.stance,
            role: status.party.role
        } : null,
        nearby: status.nearby,
        blockers: status.blockers,
        spot: status.spot ? {
            id: status.spot.id,
            name: status.spot.name,
            minLevel: status.spot.minLevel,
            maxLevel: status.spot.maxLevel,
            density: status.spot.density
        } : null
    };
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
                enum: ['none', 'say', 'follow_player', 'stay_here', 'hunt', 'rest', 'shop', 'move_to_spot']
            },
            reply: {
                type: 'string',
                description: 'Short in-character bot line, max 120 chars. Empty string when no reply is needed.'
            },
            targetPlayerName: {
                type: 'string',
                description: 'Visible player name for follow_player, or empty string.'
            },
            spotId: {
                type: 'string',
                description: 'Candidate spot id for move_to_spot, or empty string.'
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
        required: ['action', 'reply', 'targetPlayerName', 'spotId', 'reason', 'confidence'],
        additionalProperties: false
    };
}

function systemPrompt() {
    return [
        'You are the slow high-level brain for one Lineage 2 SimPlayer bot.',
        'The deterministic server code handles combat, pathfinding, HP/MP, loot, and safety.',
        'Only choose small, high-level social or intent changes.',
        'React only when a real visible player would notice it.',
        'For ambient events, usually choose none unless a reply or plan change would make the world feel alive.',
        'For player_chat, react only if the message is addressed to this bot, nearby bots, or clearly asks for help.',
        'follow_player only means approach a visible player unless the bot is already an invited party companion.',
        'Never invent unavailable actions, players, items, or spells.'
    ].join(' ');
}

function userPayload(event, session, status, visiblePlayers, text) {
    return {
        event,
        playerMessage: text || '',
        bot: compactStatus(status),
        visiblePlayers,
        candidateSpots: candidateSpots(status),
        allowedActions: ['none', 'say', 'follow_player', 'stay_here', 'hunt', 'rest', 'shop', 'move_to_spot'],
        constraints: {
            keepReplyShort: true,
            avoidSpam: true,
            noCombatMicromanagement: true
        },
        lastDecision: session.lastBrainDecision || null
    };
}

async function requestDecision(payload, cfg) {
    if (typeof fetch !== 'function') {
        utils.infoWarn('BotBrain', 'global fetch is unavailable; OpenRouter brain disabled for this runtime');
        return null;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);

    const provider = {};
    if (cfg.maxPromptPrice > 0 || cfg.maxCompletionPrice > 0) {
        provider.max_price = {};
        if (cfg.maxPromptPrice > 0) provider.max_price.prompt = cfg.maxPromptPrice;
        if (cfg.maxCompletionPrice > 0) provider.max_price.completion = cfg.maxCompletionPrice;
    }

    const body = {
        model: cfg.model,
        messages: [
            { role: 'system', content: systemPrompt() },
            { role: 'user', content: JSON.stringify(payload) }
        ],
        temperature: cfg.temperature,
        max_tokens: cfg.maxTokens,
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'bot_brain_decision',
                strict: true,
                schema: schema()
            }
        }
    };

    if (Object.keys(provider).length > 0) {
        body.provider = provider;
    }

    try {
        const response = await fetch(OPENROUTER_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${cfg.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost',
                'X-OpenRouter-Title': 'L2Node SimPlayers'
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            utils.infoWarn('BotBrain', 'OpenRouter request failed: %d %s', response.status, detail.slice(0, 180));
            return null;
        }

        const json = await response.json();
        const content = json.choices?.[0]?.message?.content;
        if (!content) return null;

        const decision = JSON.parse(content);
        decision.usage = json.usage || null;
        return decision;
    } catch (err) {
        if (err.name !== 'AbortError') {
            utils.infoWarn('BotBrain', 'OpenRouter error: %s', err.message);
        }
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function findVisiblePlayerByName(name, visiblePlayers) {
    if (!name) return null;

    const lookup = String(name).toLowerCase();
    const visible = visiblePlayers.find((player) => player.name.toLowerCase() === lookup);
    if (!visible) return null;

    const World = invoke('GameServer/World/World');
    return World.user.sessions.find((session) =>
        isRealPlayer(session) &&
        session.actor.fetchId() === visible.id
    ) || null;
}

function responseTargetSession(decision, visiblePlayers) {
    return findVisiblePlayerByName(decision?.targetPlayerName, visiblePlayers) ||
        findVisiblePlayerByName(visiblePlayers[0]?.name, visiblePlayers);
}

function say(session, text, targetSession = null) {
    const clean = String(text || '').trim().slice(0, 120);
    if (!clean) return;
    const BotAI = invoke('GameServer/Bot/BotAI');
    if (targetSession) {
        BotAI.tell(session, targetSession, clean);
    } else {
        BotAI.say(session, clean);
    }
}

function sit(session, bot) {
    if (bot.state.fetchSeated()) return;
    bot.state.setSeated(true);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
}

function stand(session, bot) {
    if (!bot.state.fetchSeated()) return;
    bot.state.setSeated(false);
    session.dataSendToOthers(ServerResponse.sitAndStand(bot), bot);
}

function applyMoveToSpot(session, bot, spotId) {
    const spot = SpotService.findById(spotId);
    if (!spot) return false;

    const assignedSpot = SpotService.assignSpot(session, spot);
    const targetLoc = SpotService.randomPointNear(spot);
    session.initialSpawnCoord = { ...assignedSpot.center };
    session.lastSpotMoveAt = Date.now();
    session.noTargetTicks = 0;

    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: targetLoc
    });

    return true;
}

function startShopping(session, bot) {
    const BotAI = invoke('GameServer/Bot/BotAI');
    const closestTown = BotAI.getClosestTown(bot.fetchLocX(), bot.fetchLocY());
    session.preShopLocation = { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() };
    session.plan = 'shopping';
    session.shopTimer = Date.now();
    session.shoppingTarget = undefined;
    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: { locX: closestTown.x, locY: closestTown.y, locZ: closestTown.z }
    });
}

function isPartyCompanionOf(session, targetSession) {
    return session.partyCompanion === true && session.followPlayerSession === targetSession;
}

function approachPlayer(session, bot, targetSession) {
    const player = targetSession?.actor;
    if (!player) return false;

    const dx = player.fetchLocX() - bot.fetchLocX();
    const dy = player.fetchLocY() - bot.fetchLocY();
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= 350) return true;

    bot.moveTo({
        from: { locX: bot.fetchLocX(), locY: bot.fetchLocY(), locZ: bot.fetchLocZ() },
        to: {
            locX: player.fetchLocX() + utils.oneFromSpan(-80, 80),
            locY: player.fetchLocY() + utils.oneFromSpan(-80, 80),
            locZ: player.fetchLocZ()
        }
    });

    return true;
}

function applyDecision(session, decision, visiblePlayers) {
    const bot = session.actor;
    if (!bot || !decision || decision.confidence < 0.45) return false;

    const action = decision.action;
    const targetSession = responseTargetSession(decision, visiblePlayers);
    let applied = false;

    if (action === 'none') {
        applied = true;
    } else if (action === 'say') {
        say(session, decision.reply, targetSession);
        applied = true;
    } else if (action === 'follow_player') {
        if (targetSession) {
            stand(session, bot);
            if (isPartyCompanionOf(session, targetSession)) {
                session.plan = 'following';
                session.botStay = false;
                say(session, decision.reply || `Following you, ${targetSession.actor.fetchName()}!`, targetSession);
            } else {
                approachPlayer(session, bot, targetSession);
                say(session, decision.reply || `Coming closer. Invite me if you want party follow.`, targetSession);
            }
            applied = true;
        }
    } else if (action === 'stay_here') {
        session.botStay = true;
        session.stayLocation = {
            locX: bot.fetchLocX(),
            locY: bot.fetchLocY(),
            locZ: bot.fetchLocZ()
        };
        if (session.followPlayerSession && session.partyCompanion === true) {
            session.plan = 'following';
        }
        say(session, decision.reply || 'Holding this position.', targetSession);
        applied = true;
    } else if (action === 'hunt') {
        stand(session, bot);
        session.plan = 'hunting';
        session.followPlayerSession = null;
        session.partyCompanion = false;
        session.botStay = false;
        say(session, decision.reply, targetSession);
        applied = true;
    } else if (action === 'rest') {
        session.plan = 'resting';
        session.currentTargetId = undefined;
        bot.unselect();
        sit(session, bot);
        say(session, decision.reply, targetSession);
        applied = true;
    } else if (action === 'shop') {
        startShopping(session, bot);
        say(session, decision.reply, targetSession);
        applied = true;
    } else if (action === 'move_to_spot') {
        if (applyMoveToSpot(session, bot, decision.spotId)) {
            say(session, decision.reply, targetSession);
            applied = true;
        }
    }

    if (applied) {
        session.lastBrainDecision = {
            action: decision.action,
            reason: decision.reason,
            at: Date.now(),
            model: config().model,
            usage: decision.usage ? {
                promptTokens: decision.usage.prompt_tokens,
                completionTokens: decision.usage.completion_tokens,
                cost: decision.usage.cost
            } : null
        };
    }

    return applied;
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
