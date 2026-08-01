const ServerResponse = invoke('GameServer/Network/Response');
const SpotService = invoke('GameServer/Bot/AI/SpotService');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');
const BotRoles = invoke('GameServer/Bot/AI/BotRoles');
const BotSkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const BotToolRegistry = invoke('GameServer/Bot/AI/BotToolRegistry');
const BotCombatUtility = invoke('GameServer/Bot/AI/BotCombatUtility');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const HotBotPolicyOverlay = invoke('GameServer/Bot/AI/HotBotPolicyOverlay');
const Attack = invoke('GameServer/Actor/Attack');

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
    'heal_target',
    'set_pull_policy',
    'assign_puller',
    'unassign_puller',
    'set_skill_priority',
    'clear_skill_priority',
    'set_combat_stance',
    'list_safe_loadouts',
    'equip_candidate',
    'optimize_equipment'
];

const PK_LOCKED_ACTIONS = new Set([
    'follow_player', 'stay_here', 'hunt', 'rest', 'shop', 'move_to_spot',
    'set_pull_policy', 'assign_puller', 'unassign_puller',
    'set_skill_priority', 'clear_skill_priority', 'set_combat_stance',
    'list_safe_loadouts', 'equip_candidate', 'optimize_equipment'
]);

function clean(text) {
    const BotChatText = invoke('GameServer/Bot/AI/BotChatText');
    return BotChatText.normalize(text).slice(0, BotChatText.DEFAULT_LINE_LIMIT * BotChatText.DEFAULT_MAX_LINES);
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
    if (session.partyCompanion === true && session.followPlayerSession) {
        return false;
    }

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
    if (session.partyCompanion === true && session.followPlayerSession) {
        return false;
    }

    const BotAI = invoke('GameServer/Bot/BotAI');
    const BotTownTravel = invoke('GameServer/Bot/AI/BotTownTravel');
    return BotTownTravel.request(session, bot, BotAI, 'Heading to town to sell and restock.') !== 'companion';
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
    const skill = BotSkillCapabilities.buffSkill(bot, buffType);
    if (!skill) return { applied: false, reason: 'buff_not_learned' };
    if (bot.fetchMp() < skill.fetchConsumedMp()) return { applied: false, reason: 'low_mp_for_buff' };
    if (distance2d(bot, target) > 900) return { applied: false, reason: 'target_too_far' };

    const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
    BotPartyChat.expectSkillResult(session, {
        target,
        targetSession,
        skill,
        kind: 'support'
    });
    invoke(path.actor).skillExec(session, bot, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl: false });
    return { applied: true, reason: `buff_requested:${buffType}` };
}

function applyHealTarget(session, bot, decision, targetSession) {
    const target = targetSession?.actor;
    if (!target) return { applied: false, reason: 'invalid_heal_target' };
    if (!BotRoles.isHealer(bot)) return { applied: false, reason: 'bot_cannot_heal' };
    const skill = BotSkillCapabilities.healSkill(bot);
    if (!skill) return { applied: false, reason: 'heal_not_learned' };
    if (bot.fetchMp() < skill.fetchConsumedMp()) return { applied: false, reason: 'low_mp_for_heal' };
    if (distance2d(bot, target) > 900) return { applied: false, reason: 'target_too_far' };

    const BotPartyChat = invoke('GameServer/Bot/AI/BotPartyChat');
    BotPartyChat.expectSkillResult(session, {
        target,
        targetSession,
        skill,
        kind: 'heal'
    });
    invoke(path.actor).skillExec(session, bot, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl: false });

    return { applied: true, reason: 'heal_requested' };
}

function executeLegacy(session, decision, visiblePlayers) {
    const bot = session.actor;
    if (!bot || !decision || Number(decision.confidence || 0) < 0.45) {
        return { applied: false, reason: 'low_confidence_or_missing_context' };
    }

    const action = decision.action;
    const targetSession = responseTargetSession(decision, visiblePlayers);

    // A chaotic character remains autonomous.  Chat may make it talk, but may
    // never turn it into a callable companion or redirect its hunting route.
    if (session.plan === 'pk_hunting' && PK_LOCKED_ACTIONS.has(action)) {
        return { applied: false, reason: 'pk_hunting_autonomous' };
    }

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
        if (session.partyCompanion === true && session.followPlayerSession) {
            session.plan = 'hunting';
            session.botStay = false;
            say(session, decision.reply || 'Hunting with the party.', targetSession);
            return { applied: true, reason: 'party_hunt' };
        }

        session.plan = 'hunting';
        session.followPlayerSession = null;
        session.partyCompanion = false;
        session.botStay = false;
        say(session, decision.reply, targetSession);
        return { applied: true, reason: 'hunt' };
    }
    if (action === 'rest') {
        const hpRatio = bot.fetchHp() / Math.max(1, bot.fetchMaxHp());
        const mpRatio = bot.fetchMp() / Math.max(1, bot.fetchMaxMp());
        if (hpRatio >= 0.95 && mpRatio >= 0.95) {
            stand(session, bot);
            session.currentTargetId = undefined;
            if (session.partyCompanion === true && session.followPlayerSession) {
                session.plan = 'following';
            } else {
                session.plan = 'hunting';
            }
            say(session, decision.reply || "I'm already recovered.", targetSession);
            return { applied: true, reason: 'already_recovered' };
        }

        session.plan = 'resting';
        session.currentTargetId = undefined;
        bot.unselect();
        sit(session, bot);
        say(session, decision.reply, targetSession);
        return { applied: true, reason: 'rest' };
    }
    if (action === 'shop') {
        if (startShopping(session, bot)) {
            say(session, decision.reply, targetSession);
        } else {
            say(session, decision.reply || 'I will stay with the party and sell later.', targetSession);
        }
        return { applied: true, reason: 'shop' };
    }
    if (action === 'move_to_spot') {
        if (session.partyCompanion === true && session.followPlayerSession) {
            say(session, decision.reply || 'I will stay with the party.', targetSession);
            return { applied: true, reason: 'party_companion_stays_with_party' };
        }

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

function partyLeaderFor(session) {
    return session?.partyCompanion === true && session.followPlayerSession
        ? session.followPlayerSession
        : null;
}

function isAuthorizedPartyLeader(context) {
    const session = context?.session;
    const player = context?.requestContext?.playerSession;
    const leader = partyLeaderFor(session);
    if (!leader?.actor || !player?.actor || !player.actor.fetchIsOnline?.()) return false;
    if (String(player.accountId || '').startsWith('bot_')) return false;
    return Number(player.actor.fetchId?.()) === Number(leader.actor.fetchId?.());
}

function controllerContext(context) {
    const player = context?.requestContext?.playerSession;
    return {
        ownerId: player?.actor?.fetchId?.() || null,
        ownerName: player?.actor?.fetchName?.() || null,
        reason: context?.decision?.reason || 'player_policy_request',
        ttlMs: context?.decision?.policyTtlMs
    };
}

function policyActionResult(session, patch, context, reason) {
    const policy = HotBotPolicyOverlay.set(session, patch, controllerContext(context));
    return { applied: true, reason, policy: HotBotPolicyOverlay.status(session) || policy };
}

function applyPullPolicy(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    if (!leader) return { applied: false, reason: 'not_a_party_companion' };

    const current = PartyCompanionService.getSettings(leader);
    const requestedPermission = String(context.decision.pullPermission || '').toLowerCase();
    const requestedMode = String(context.decision.pullMode || '').toLowerCase();
    const permission = ['allow', 'deny'].includes(requestedPermission)
        ? requestedPermission
        : requestedMode === 'off' ? 'deny' : 'allow';
    const mode = permission === 'deny'
        ? 'off'
        : ['auto', 'leader', 'bot'].includes(requestedMode) ? requestedMode : (current.pullMode || 'auto');
    if (mode === 'bot' && !session.actor) return { applied: false, reason: 'puller_not_available' };

    const pullerId = mode === 'bot' ? Number(session.actor.fetchId()) : null;
    PartyCompanionService.updateSettings(leader, { pullMode: mode, pullerId });
    PartyCompanionService.refreshPanel(leader);
    return policyActionResult(session, {
        pull: { permission, mode, pullerId }
    }, context, `pull_policy:${permission}:${mode}`);
}

function assignPuller(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    if (!leader || !session.actor) return { applied: false, reason: 'not_a_party_companion' };
    const requestedId = Number(context.decision.pullerId || 0);
    if (requestedId && requestedId !== Number(session.actor.fetchId())) return { applied: false, reason: 'puller_must_be_target' };

    PartyCompanionService.updateSettings(leader, {
        pullMode: 'bot',
        pullerId: session.actor.fetchId()
    });
    PartyCompanionService.refreshPanel(leader);
    return policyActionResult(session, {
        pull: { permission: 'allow', mode: 'bot', pullerId: session.actor.fetchId() }
    }, context, 'puller_assigned');
}

function unassignPuller(context) {
    const session = context.session;
    const leader = partyLeaderFor(session);
    if (!leader || !session.actor) return { applied: false, reason: 'not_a_party_companion' };
    const settings = PartyCompanionService.getSettings(leader);
    if (settings.pullMode !== 'bot' || Number(settings.pullerId || 0) !== Number(session.actor.fetchId())) {
        return { applied: true, reason: 'puller_not_assigned' };
    }

    // Unassigning one member returns to the existing automatic policy. It
    // never turns pull off globally and never silently assigns another bot.
    PartyCompanionService.updateSettings(leader, { pullMode: 'auto', pullerId: null });
    PartyCompanionService.refreshPanel(leader);
    return policyActionResult(session, {
        pull: { permission: 'allow', mode: 'auto', pullerId: null }
    }, context, 'puller_unassigned');
}

function learnedSkill(session, skillId) {
    const actor = session?.actor;
    const skill = actor?.skillset?.fetchSkill?.(Number(skillId)) ||
        (actor?.skillset?.skills || []).find((candidate) => Number(candidate.fetchSelfId?.()) === Number(skillId));
    if (!skill || skill.fetchPassive?.()) return { skill: null, reason: 'skill_not_learned' };
    const semantic = skill.fetchSemantic?.() || {};
    if (semantic.notUsedInC4 || skill.fetchTargetKind?.() !== 'enemy' || !BotCombatUtility.OFFENSIVE_TYPES.has(skill.fetchSkillType?.())) {
        return { skill: null, reason: 'skill_not_combat_eligible' };
    }
    const allowedWeapons = Number(semantic.requires?.weaponsAllowed || 0);
    if (allowedWeapons && (allowedWeapons & Attack.weaponMaskFor(session.actor)) === 0) {
        return { skill: null, reason: 'skill_incompatible' };
    }
    return { skill, reason: null };
}

function setSkillPriority(context) {
    const session = context.session;
    const skillId = Number(context.decision.skillId || 0);
    const resolved = learnedSkill(session, skillId);
    if (resolved.reason) return { applied: false, reason: resolved.reason };

    const current = HotBotPolicyOverlay.get(session)?.skillPriorities || {};
    const weight = Number(context.decision.skillPriority ?? context.decision.weight);
    if (!Number.isFinite(weight) || weight < -50 || weight > 50) return { applied: false, reason: 'invalid_skill_priority' };
    const priorities = { ...current };
    if (weight === 0) delete priorities[String(skillId)];
    else priorities[String(skillId)] = weight;
    return policyActionResult(session, { skillPriorities: priorities }, context, `skill_priority:${skillId}:${Math.round(weight)}`);
}

function clearSkillPriority(context) {
    const session = context.session;
    const skillId = Number(context.decision.skillId || 0);
    if (!skillId) return { applied: false, reason: 'invalid_skill_id' };
    const current = { ...(HotBotPolicyOverlay.get(session)?.skillPriorities || {}) };
    delete current[String(skillId)];
    return policyActionResult(session, { skillPriorities: current }, context, `skill_priority_cleared:${skillId}`);
}

function setCombatStance(context) {
    const stance = String(context.decision.combatStance || '').toLowerCase();
    if (!HotBotPolicyOverlay.STANCES.includes(stance)) return { applied: false, reason: 'invalid_combat_stance' };
    return policyActionResult(context.session, { combatStance: stance }, context, `combat_stance:${stance}`);
}

function listSafeLoadouts(context) {
    const loadouts = BotEquipmentUpgrade.listSafeLoadouts(context.session);
    return { applied: true, reason: 'safe_loadouts', loadouts };
}

function equipCandidate(context) {
    const result = BotEquipmentUpgrade.applyCandidate(context.session, context.decision.itemId);
    if (!result.applied) return result;
    return { ...result, policy: HotBotPolicyOverlay.status(context.session) };
}

function optimizeEquipment(context) {
    const upgrades = BotEquipmentUpgrade.applyBestUpgrades(context.session);
    if (!upgrades.length) return { applied: false, reason: 'no_safe_upgrade' };
    return {
        applied: true,
        reason: 'equipment_optimized',
        upgrades: upgrades.map(({ item, slot, score }) => ({
            itemId: item.fetchId(),
            name: item.fetchName(),
            slot,
            score
        }))
    };
}

function registerTools() {
    const descriptions = {
        none: 'Do nothing when no useful response is needed.',
        say: 'Send a short in-character reply to the target visible player.',
        follow_player: 'Approach a visible player. Real party follow still requires an invite.',
        stay_here: 'Hold the current position.',
        hunt: 'Return to independent hunting.',
        rest: 'Sit and recover.',
        shop: 'Go to town for normal restock behavior.',
        move_to_spot: 'Move to one of the provided candidate spot ids.',
        buff_target: 'Apply a supported buff to a visible player if class, MP, and range allow it.',
        heal_target: 'Heal a visible player if class, MP, and range allow it.',
        set_pull_policy: 'Set the party pull permission and mode for this companion, with a bounded hot-session expiry.',
        assign_puller: 'Assign this party companion as the dedicated puller without issuing combat commands.',
        unassign_puller: 'Release this companion from dedicated pulling and return to the existing automatic policy.',
        set_skill_priority: 'Adjust one learned offensive skill preference within a bounded combat score range.',
        clear_skill_priority: 'Clear one temporary offensive skill preference.',
        set_combat_stance: 'Set a bounded offensive combat stance; safety and support priorities remain authoritative.',
        list_safe_loadouts: 'List inventory equipment candidates that are compatible and strictly improve a slot.',
        equip_candidate: 'Equip one validated inventory upgrade through the native backpack persistence path.',
        optimize_equipment: 'Equip all currently safe inventory upgrades through the native backpack path.'
    };

    const controlActions = new Set([
        'set_pull_policy', 'assign_puller', 'unassign_puller',
        'set_skill_priority', 'clear_skill_priority', 'set_combat_stance',
        'list_safe_loadouts', 'equip_candidate', 'optimize_equipment'
    ]);
    const executors = {
        set_pull_policy: applyPullPolicy,
        assign_puller: assignPuller,
        unassign_puller: unassignPuller,
        set_skill_priority: setSkillPriority,
        clear_skill_priority: clearSkillPriority,
        set_combat_stance: setCombatStance,
        list_safe_loadouts: listSafeLoadouts,
        equip_candidate: equipCandidate,
        optimize_equipment: optimizeEquipment
    };

    ACTIONS.forEach((name) => {
        BotToolRegistry.register({
            name,
            description: descriptions[name],
            kind: controlActions.has(name) && name === 'list_safe_loadouts' ? 'read' : controlActions.has(name) ? 'mutation' : 'intent',
            risk: controlActions.has(name) ? 'medium' : 'low',
            mutating: !['none', 'say', 'list_safe_loadouts'].includes(name),
            available(session) {
                if (!session) return true;
                if (session.plan === 'merchant' || session.plan === 'getting_buffed') {
                    return ['none', 'say'].includes(name);
                }
                if (session.plan === 'pk_hunting' && PK_LOCKED_ACTIONS.has(name)) return false;
                if (controlActions.has(name) && !(session.partyCompanion === true && session.followPlayerSession)) return false;
                if (name === 'buff_target') {
                    try { if (!BotRoles.canBuff(session.actor)) return false; } catch (_) { return true; }
                }
                if (name === 'heal_target') {
                    try { if (!BotRoles.isHealer(session.actor)) return false; } catch (_) { return true; }
                }
                return true;
            },
            authorize: controlActions.has(name) ? isAuthorizedPartyLeader : undefined,
            execute(context) {
                if (executors[name]) return executors[name](context);
                return executeLegacy(context.session, context.decision, context.visiblePlayers || []);
            }
        });
    });
}

registerTools();

function execute(session, decision, visiblePlayers, requestContext = null) {
    const outcome = BotToolRegistry.execute({
        session,
        decision,
        visiblePlayers,
        requestContext,
        expectedWorldRevision: requestContext?.worldRevision
    });
    const { idempotent, ...publicOutcome } = outcome;
    return { ...publicOutcome, applied: outcome.applied, reason: outcome.reason };
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
            promptTokens: decision.usage.promptTokens ?? decision.usage.prompt_tokens,
            completionTokens: decision.usage.completionTokens ?? decision.usage.completion_tokens,
            cachedPromptTokens: decision.usage.cachedPromptTokens ?? decision.usage.prompt_tokens_details?.cached_tokens,
            totalTokens: decision.usage.totalTokens ?? decision.usage.total_tokens,
            cost: decision.usage.cost
        } : null
    };
}

function toolDescriptions(session = null) {
    return BotToolRegistry.descriptors(session);
}

function availableActions(session = null) {
    return BotToolRegistry.availableNames(session);
}

function worldRevision(session) {
    return BotToolRegistry.worldRevision(session);
}

function rejectionReply(result = {}) {
    switch (result.reason) {
        case 'stale_world_state': return 'The situation changed, so I did not make that move.';
        case 'one_mutation_per_turn': return 'I can only change one thing at a time.';
        case 'low_confidence': return 'I am not certain enough to change that safely.';
        case 'not_authorized': return 'I cannot change that under the current party authority.';
        case 'pk_hunting_autonomous': return 'I am staying focused on my current fight.';
        case 'tool_unavailable': return 'That action is not available to me right now.';
        case 'not_a_party_companion': return 'I can only change hot party policy while I am your companion.';
        case 'incompatible_item':
        case 'not_an_upgrade':
        case 'no_safe_upgrade': return 'I could not find a safe equipment upgrade for this situation.';
        case 'unsafe_combat_state': return 'I will finish the current action before changing equipment.';
        case 'skill_not_learned':
        case 'skill_not_combat_eligible':
        case 'skill_incompatible': return 'That skill cannot be used as a combat preference.';
        case 'invalid_skill_priority':
        case 'invalid_combat_stance': return 'That preference is outside my safe combat settings.';
        default: return 'I cannot do that safely right now.';
    }
}

module.exports = {
    ACTIONS,
    availableActions,
    execute,
    remember,
    rejectionReply,
    toolDescriptions,
    worldRevision
};
