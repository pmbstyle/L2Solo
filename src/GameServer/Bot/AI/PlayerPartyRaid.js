const Safety = invoke('GameServer/Bot/AI/BotRaidSafety');
const Combat = invoke('GameServer/Bot/AI/PartyRaidCombat');
const State = invoke('GameServer/Bot/AI/PartyCombatState');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');

const ratio = actor => Number(actor.fetchHp()) / Math.max(1, Number(actor.fetchMaxHp()));
const location = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });

function decision(session, action, target, now) {
    session.lastDecision = { action, targetId: target?.fetchId?.() || null, at: now };
    session.roleDecision = { role: Roles.inferRole(session.actor), ...session.lastDecision, reason: action };
}

function hold(session, bot, action, target, now) {
    if (!bot.state.fetchCasts?.()) Tactics.stop(session, bot);
    Tactics.followSummon(session, bot);
    session.currentTargetId = undefined;
    bot.unselect?.();
    decision(session, action, target, now);
    return true;
}

function levelAllowed(actor, boss) {
    return !invoke('GameServer/RaidBoss/RaidCurse').isAboveRaidThreshold(actor, boss);
}

function retreat(session, bot, owner, raid, boss, members, now) {
    invoke('GameServer/Bot/AI/PartyPulling').cancel(owner);
    // Wait outside the encounter; keeping the boss selected cannot silently
    // start a second pull after the tank's death. No shared world HP is reset.
    const entities = Safety.raidEntities(raid).filter(Threats.alive);
    const living = members.filter(member => Threats.alive(member.actor));
    const safe = living.every(member => entities.every(npc => Threats.distance(member.actor, npc) >= 1800));
    if (safe && !Safety.raidHasPartyCombat(owner, raid)) {
        owner.partyRaidPullBlockedBossId = raid.bossId;
        owner.partyRaidEngagement = undefined;
        owner.partyRevivalAttempt = null;
        session.plan = 'following';
        session.raidSafetyResumePlan = undefined;
        return hold(session, bot, 'raid_retreat_complete', boss, now);
    }
    if (session.plan !== 'fleeing' || (!bot.state.fetchTowards?.()
        && Threats.distance(bot, boss) < 2200 && now - Number(session.playerRaidRetreatAt || 0) >= 1500)) {
        // The generic escape helper clears only its threat. A damage dealer
        // may still have an add selected, which is no longer a combat order.
        session.currentTargetId = undefined;
        bot.unselect?.();
        Safety.retreat(session, bot, boss, { distance: 2200 });
        session.playerRaidRetreatAt = now;
    }
    decision(session, 'raid_retreat_tank_lost', boss, now);
    return true;
}

function tick(session, bot, Generics, AI, now = Date.now()) {
    const owner = session?.followPlayerSession;
    if (!owner?.actor || !session.partyCompanion || bot.isDead?.() || !owner.actor.fetchIsOnline?.()) return false;
    const raid = Safety.syncPlayerPartyRaid(owner, now);
    if (!raid) return false;
    const boss = Safety.raidBossByObjectId(raid.bossId);
    if (!boss || boss.isDead?.()) return false;
    const allMembers = State.partySessions(owner, { includeDead: true })
        .filter(member => !Awareness.isDistantQuestCourier(member, owner));
    if (!raid.mainTankId) {
        raid.mainTankId = Roles.inferRole(owner.actor) === 'tank'
            ? owner.actor.fetchId() : raid.openerId;
    }
    const mainTank = allMembers.find(member => Number(member.actor.fetchId()) === Number(raid.mainTankId));
    const members = allMembers.filter(member => Threats.alive(member.actor)
        && (member === owner || levelAllowed(member.actor, boss)));
    if (raid.phase !== 'opening' && (!mainTank || !Threats.alive(mainTank.actor))) {
        const replacement = members.find(member => member !== owner && Roles.inferRole(member.actor) === 'tank'
            && Number(boss.fetchDestId?.()) === Number(member.actor.fetchId()));
        if (replacement) raid.mainTankId = replacement.actor.fetchId();
        else raid.phase = 'retreat';
    }
    if (raid.phase === 'retreat') return retreat(session, bot, owner, raid, boss, allMembers, now);
    if (!levelAllowed(bot, boss)) {
        Tactics.stop(session, bot);
        return hold(session, bot, 'raid_level_ineligible', boss, now);
    }
    const assignedTank = members.find(member => Number(member.actor.fetchId()) === Number(raid.mainTankId));
    if (!assignedTank) return hold(session, bot, 'raid_wait_tank', boss, now);

    const plan = Safety.botClanRaidCombatPlan(owner, boss);
    Combat.preserveControlledAdds(session, bot, plan);
    invoke('GameServer/Bot/AI/PartyPulling').beginRaid(owner, raid);
    if (!Restrictions.canUseBasicAction(bot)) return true;
    if (bot.state.fetchCasts?.() && !Restrictions.canCast(bot)) bot.attack?.abortCast?.(session, bot);
    if (bot.state.fetchCasts?.() && owner.partyRevivalAttempt?.providerId === bot.fetchId()) {
        Revival.tick(session, owner, Generics);
    }
    if (bot.state.fetchCasts?.()) return true;
    // Foreign raids preserve the existing escape rule. Field monsters already
    // attacking us are handled locally without starting a fresh farm pull.
    const incoming = Awareness.npcThreateningActor(session);
    if (incoming && Safety.isProtectedRaidEntity(incoming) && !Safety.belongsToRaid(incoming, raid)) {
        Safety.retreat(session, bot, incoming);
        return true;
    }
    const near = members.filter(member => Threats.distance(bot, member.actor) <= 1800);
    if (session.playerRaidResurrectionRecovery && ratio(bot) >= 0.65) session.playerRaidResurrectionRecovery = false;
    if (Tactics.support(session, bot, { owner, members: near, threats: [], raid: true }, Generics, now)) {
        decision(session, 'raid_support', null, now);
        return true;
    }
    // The common support selector casts only in range. Approach a wounded
    // member through native movement instead of leaving a low-HP opener stuck.
    if (Roles.inferRole(bot) === 'healer' && !Awareness.underDirectNpcAttack(session) && Restrictions.canMove(bot)) {
        const wounded = [...near].sort((a, b) => ratio(a.actor) - ratio(b.actor))
            .find(member => ratio(member.actor) < 0.7);
        const heal = wounded && invoke('GameServer/Bot/AI/BotSkillCapabilities')
            .selectHealSkill(bot, { emergency: ratio(wounded.actor) < 0.45 });
        const healRange = heal && (heal.fetchTargetKind() === 'friendly' ? Number(heal.fetchDistance())
            : Number(heal.fetchSemantic?.()?.radius || heal.fetchDistance() || 900));
        if (heal && Tactics.usable(bot, heal) && Threats.distance(bot, wounded.actor) > healRange) {
            if (bot.state.fetchTowards?.() && session.lastDecision?.action === 'raid_heal_approach'
                && session.lastDecision.targetId === wounded.actor.fetchId()) return true;
            Tactics.stop(session, bot);
            Combat.standForAction(session, bot);
            bot.moveTo({ from: location(bot), to: location(wounded.actor) });
            decision(session, 'raid_heal_approach', wounded.actor, now);
            return true;
        }
    }
    if (session.playerRaidResurrectionRecovery) {
        bot.automation.replenishVitals(bot);
        return hold(session, bot, 'raid_resurrection_recovery', boss, now);
    }
    const revival = Revival.tick(session, owner, Generics);
    if (revival.handled) {
        decision(session, 'raid_resurrect', revival.target || Safety.raidEntityByObjectId(revival.targetId), now);
        return true;
    }
    if (raid.phase === 'opening') {
        if (Revival.deadMembers(owner).length) return hold(session, bot, 'raid_wait_resurrection', boss, now);
        if (!Safety.isRaidOpenerReady(assignedTank.actor)) return hold(session, bot, 'raid_wait_tank_recovery', boss, now);
        if (assignedTank === owner || Roles.inferRole(assignedTank.actor) !== 'tank') {
            return hold(session, bot, 'raid_wait_player_opening', boss, now);
        }
        if (session === assignedTank && bot.state.fetchSeated?.()) {
            Combat.standForAction(session, bot);
            return hold(session, bot, 'raid_stand_before_opening', boss, now);
        }
        const origin = raid.pullOrigin;
        if (origin && members.some(member => Math.hypot(member.actor.fetchLocX() - origin.locX,
            member.actor.fetchLocY() - origin.locY) > Safety.RAID_PULL_RADIUS)) {
            if (Math.hypot(bot.fetchLocX() - origin.locX, bot.fetchLocY() - origin.locY) > Safety.RAID_PULL_RADIUS
                && !bot.state.fetchTowards?.() && Restrictions.canMove(bot)) {
                Tactics.stop(session, bot);
                Combat.standForAction(session, bot);
                bot.moveTo({ from: location(bot), to: origin });
                decision(session, 'raid_prepare_regroup', boss, now);
                return true;
            }
            if (bot.state.fetchTowards?.()) return true;
            return hold(session, bot, 'raid_wait_regroup', boss, now);
        }
        if (session === assignedTank && !bot.state.fetchTowards?.() && !bot.state.fetchHits?.()) {
            const previous = session.lastPathfinding;
            bot.moveTo?.({ from: location(bot), to: location(boss), previewOnly: true });
            if (session.lastPathfinding !== previous && session.lastPathfinding?.routeUsable === false) {
                owner.partyRaidPullBlockedBossId = raid.bossId;
                owner.partyRaidEngagement = undefined;
                invoke('GameServer/Bot/AI/PartyPulling').cancel(owner);
                return hold(session, bot, 'raid_unreachable', boss, now);
            }
        }
    }
    if (incoming && !Safety.isProtectedRaidEntity(incoming) && session !== assignedTank) {
        if (!bot.state.fetchTowards?.() && !bot.state.fetchHits?.()) AI.executeCombat(session, bot, incoming, Generics, { party: true });
        return true;
    }
    Combat.tick(session, bot, Generics, AI, { owner, members, near, raidPlan: plan,
        raidTank: assignedTank, playerLeader: owner, combatBuffs: Combat.combatRaidBuffs }, now);
    session.roleDecision = { role: Roles.inferRole(bot), ...session.lastDecision, reason: session.lastDecision?.action };
    return true;
}

module.exports = { tick, levelAllowed };
