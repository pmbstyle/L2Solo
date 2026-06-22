const ServerResponse = invoke('GameServer/Network/Response');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');

const SUPPORT_BUFF_MP_COST = 20;
const HEAL_MP_COST = 15;

const ACTIONS = [
    'none',
    'say',
    'follow_player',
    'stay_here',
    'hunt',
    'rest',
    'shop',
    'move_to_spot',
    'buff_target',
    'heal_target'
];

function clean(text) {
    return String(text || '').trim().slice(0, 120);
}

function isRealPlayer(session) {
    return session &&
        session.actor &&
        session.actor.fetchIsOnline() &&
        session.accountId &&
        !session.accountId.startsWith('bot_');
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
    const line = clean(text);
    if (!line) return false;

    const BotAI = invoke('GameServer/Bot/BotAI');
    if (targetSession) {
        BotAI.tell(session, targetSession, line);
    } else {
        BotAI.say(session, line);
    }
    return true;
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

function distance2d(a, b) {
    const dx = a.fetchLocX() - b.fetchLocX();
    const dy = a.fetchLocY() - b.fetchLocY();
    return Math.sqrt(dx * dx + dy * dy);
}

function applyBuffTarget(session, bot, decision, targetSession) {
    const target = targetSession?.actor;
    const buffType = String(decision.buffType || '').toLowerCase();
    if (!target || !BotBuffs.SUPPORT_BUFFS[buffType]) return { applied: false, reason: 'invalid_buff_target' };
    if (!BotRoles.canBuff(bot)) return { applied: false, reason: 'bot_cannot_buff' };
    if (bot.fetchMp() < SUPPORT_BUFF_MP_COST) return { applied: false, reason: 'low_mp_for_buff' };
    if (distance2d(bot, target) > 900) return { applied: false, reason: 'target_too_far' };

    const result = BotBuffs.applySupportBuff(targetSession, target, buffType, invoke(path.actor));
    if (!result) return { applied: false, reason: 'buff_failed' };

    bot.setMp(Math.max(0, bot.fetchMp() - SUPPORT_BUFF_MP_COST));
    bot.statusUpdateVitals(bot);
    say(session, decision.reply || `${result.name} on ${target.fetchName()}.`, targetSession);
    return { applied: true, reason: `buff:${buffType}` };
}

function applyHealTarget(session, bot, decision, targetSession) {
    const target = targetSession?.actor;
    if (!target) return { applied: false, reason: 'invalid_heal_target' };
    if (!BotRoles.isHealer(bot)) return { applied: false, reason: 'bot_cannot_heal' };
    if (bot.fetchMp() < HEAL_MP_COST) return { applied: false, reason: 'low_mp_for_heal' };
    if (distance2d(bot, target) > 900) return { applied: false, reason: 'target_too_far' };

    targetSession.dataSendToMe(
        ServerResponse.skillStarted(bot, target.fetchId(), {
            fetchSelfId: () => 1011,
            fetchCalculatedHitTime: () => 1000,
            fetchReuseTime: () => 1000
        })
    );

    setTimeout(() => {
        if (target.isDead && target.isDead()) return;
        target.setHp(target.fetchMaxHp());
        target.statusUpdateVitals(target);
        bot.setMp(Math.max(0, bot.fetchMp() - HEAL_MP_COST));
        bot.statusUpdateVitals(bot);
        say(session, decision.reply || `Healing you, ${target.fetchName()}.`, targetSession);
    }, 1000);

    return { applied: true, reason: 'heal_target' };
}

function execute(session, decision, visiblePlayers) {
    const bot = session.actor;
    if (!bot || !decision || Number(decision.confidence || 0) < 0.45) {
        return { applied: false, reason: 'low_confidence_or_missing_context' };
    }

    const action = decision.action;
    const targetSession = responseTargetSession(decision, visiblePlayers);

    if (action === 'none') {
        return { applied: true, reason: 'none' };
    }
    if (action === 'say') {
        return { applied: say(session, decision.reply, targetSession), reason: 'say' };
    }
    if (action === 'follow_player') {
        if (!targetSession) return { applied: false, reason: 'missing_target_player' };
        stand(session, bot);
        if (isPartyCompanionOf(session, targetSession)) {
            session.plan = 'following';
            session.botStay = false;
            say(session, decision.reply || `Following you, ${targetSession.actor.fetchName()}!`, targetSession);
        } else {
            approachPlayer(session, bot, targetSession);
            say(session, decision.reply || `Coming closer. Invite me if you want party follow.`, targetSession);
        }
        return { applied: true, reason: 'follow_player' };
    }
    if (action === 'stay_here') {
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
        return { applied: true, reason: 'stay_here' };
    }
    if (action === 'hunt') {
        stand(session, bot);
        session.plan = 'hunting';
        session.followPlayerSession = null;
        session.partyCompanion = false;
        session.botStay = false;
        say(session, decision.reply, targetSession);
        return { applied: true, reason: 'hunt' };
    }
    if (action === 'rest') {
        session.plan = 'resting';
        session.currentTargetId = undefined;
        bot.unselect();
        sit(session, bot);
        say(session, decision.reply, targetSession);
        return { applied: true, reason: 'rest' };
    }
    if (action === 'shop') {
        startShopping(session, bot);
        say(session, decision.reply, targetSession);
        return { applied: true, reason: 'shop' };
    }
    if (action === 'move_to_spot') {
        const applied = applyMoveToSpot(session, bot, decision.spotId);
        if (applied) say(session, decision.reply, targetSession);
        return { applied, reason: applied ? 'move_to_spot' : 'invalid_spot' };
    }
    if (action === 'buff_target') {
        return applyBuffTarget(session, bot, decision, targetSession);
    }
    if (action === 'heal_target') {
        return applyHealTarget(session, bot, decision, targetSession);
    }

    return { applied: false, reason: `unknown_action:${action}` };
}

function remember(session, decision, result, model) {
    if (!result?.applied) return;
    session.lastBrainDecision = {
        action: decision.action,
        reason: decision.reason || result.reason,
        appliedReason: result.reason,
        at: Date.now(),
        model,
        usage: decision.usage ? {
            promptTokens: decision.usage.prompt_tokens,
            completionTokens: decision.usage.completion_tokens,
            cost: decision.usage.cost
        } : null
    };
}

function toolDescriptions() {
    return [
        { action: 'none', description: 'Do nothing when no useful response is needed.' },
        { action: 'say', description: 'Send a short in-character reply to the target visible player.' },
        { action: 'follow_player', description: 'Approach a visible player. Real party follow still requires an invite.' },
        { action: 'stay_here', description: 'Hold the current position.' },
        { action: 'hunt', description: 'Return to independent hunting.' },
        { action: 'rest', description: 'Sit and recover.' },
        { action: 'shop', description: 'Go to town for normal restock behavior.' },
        { action: 'move_to_spot', description: 'Move to one of the provided candidate spot ids.' },
        { action: 'buff_target', description: 'Apply a supported buff to a visible player if class, MP, and range allow it.' },
        { action: 'heal_target', description: 'Heal a visible player if class, MP, and range allow it.' }
    ];
}

module.exports = {
    ACTIONS,
    execute,
    remember,
    toolDescriptions
};
