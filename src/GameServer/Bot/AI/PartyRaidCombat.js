const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Tactics = invoke('GameServer/Bot/AI/BotPvpTactics');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const ClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const SkillCapabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const Support = invoke('GameServer/Bot/AI/BotSupportPlanner');

const RAID_ACTION_RETRY_MS = 8000;
const RAID_AGGRESSION_RETRY_MS = 5000;
const RAID_RECOVERY_BUFF_WAIT_MS = 8000;
const ratio = (value, max) => Number(value || 0) / Math.max(1, Number(max || 1));

function mainRaidTank(members, party) {
    return members.find((member) => (
        Number(member.actor.fetchId?.() || 0) === Number(party?.leaderId || 0)
        && Roles.inferRole(member.actor) === 'tank'
    )) || members.find((member) => Roles.inferRole(member.actor) === 'tank') || null;
}

function raidActionKey(target, skill) {
    const effect = String(skill?.fetchSemantic?.()?.effect || '').toLowerCase();
    return `${Number(target?.fetchId?.() || 0)}:${effect || Number(skill?.fetchSelfId?.() || 0)}`;
}

function raidClaimMap(owner) {
    return owner.backgroundRaidActionClaims || (owner.backgroundRaidActionClaims = new Map());
}

function canAttemptRaidAction(owner, target, skill, now, retryMs = RAID_ACTION_RETRY_MS) {
    const claims = raidClaimMap(owner);
    for (const [key, until] of claims) if (Number(until) <= now) claims.delete(key);
    return Number(claims.get(raidActionKey(target, skill)) || 0) <= now;
}

function rememberRaidAction(owner, target, skill, now, retryMs = RAID_ACTION_RETRY_MS) {
    raidClaimMap(owner).set(raidActionKey(target, skill), now + retryMs);
}

function raidMinionPickup(owner, members, raidPlan, mainTank, now, playerLeader) {
    const Effects = invoke('GameServer/Effects/EffectStore');
    // Capability, not the inferred party role: music fighters can also have
    // Aggression. A holder remains valid while its skill is on reuse, so two
    // rescuers do not continually pull the same add away from one another.
    const holders = members.filter(member => member === mainTank
        || SkillCapabilities.aggressionSkill(member.actor));
    const holderIds = new Set(holders.map(member => member.actor.fetchId()));
    const providers = holders.filter(member => member !== mainTank && member !== playerLeader
        && !member.actor.state.fetchCasts?.()
        && Restrictions.canUseBasicAction(member.actor)
        && ClassTactics.usable(member.actor, SkillCapabilities.aggressionSkill(member.actor), 0.08));
    const targets = raidPlan.minions.filter(target => {
        if (target === raidPlan.boss || !Threats.alive(target)) return false;
        const victimId = Number(target.fetchDestId?.() || 0);
        if (holderIds.has(victimId) || !members.some(member => member.actor.fetchId() === victimId)) return false;
        const effects = Effects.impairments(target);
        // Leave safely controlled adds alone and do not pull unengaged adds.
        return !effects.disabled && !effects.rooted;
    });
    const priority = target => {
        const victim = members.find(member => member.actor.fetchId() === Number(target.fetchDestId?.()));
        const role = Roles.inferRole(victim.actor);
        return ['healer', 'buffer'].includes(role) && !Roles.isPartyMusicFighter(victim.actor) ? 0
            : ['archer', 'mage'].includes(role) ? 1 : 2;
    };
    targets.sort((a, b) => priority(a) - priority(b)
        || Number(b === raidPlan.focusMinion) - Number(a === raidPlan.focusMinion)
        || a.fetchId() - b.fetchId());
    for (const target of targets) {
        const candidates = providers.filter(member => {
            const skill = SkillCapabilities.aggressionSkill(member.actor);
            const distance = Threats.distance(member.actor, target);
            return distance <= 1800
                && (Restrictions.canMove(member.actor) || distance <= Number(skill.fetchDistance?.() || 0))
                && canAttemptRaidAction(owner, target, skill, now, RAID_AGGRESSION_RETRY_MS);
        });
        candidates.sort((a, b) => Threats.distance(a.actor, target) - Threats.distance(b.actor, target)
            || a.actor.fetchId() - b.actor.fetchId());
        if (candidates.length) return { provider: candidates[0], target,
            skill: SkillCapabilities.aggressionSkill(candidates[0].actor) };
    }
    return null;
}

function castRaidSkill(session, bot, target, skill, Generics) {
    standForAction(session, bot);
    Tactics.stop(session, bot);
    session.currentTargetId = target.fetchId();
    bot.select({ id: target.fetchId() });
    Generics.skillExec(session, bot, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl: true });
}

function standForAction(session, bot) {
    if (!bot.state.fetchSeated()) return;
    bot.state.setSeated(false);
    session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
}

function combatRaidBuffs(session, owner, members, Generics, now) {
    const supportMembers = members.filter(s => !['tank', 'healer'].includes(Roles.inferRole(s.actor)));
    const recoveryOptions = { raidRecovery: true, allowAttackInterrupt: true };
    for (const member of members.filter(s => s.hotRaidNeedsRebuff)) {
        member.hotRaidRebuffUntil ||= now + RAID_RECOVERY_BUFF_WAIT_MS;
        if (now >= member.hotRaidRebuffUntil || !Support.hasPendingAction(
            [{ actor: member.actor }], supportMembers.map(s => s.actor), recoveryOptions)) {
            member.hotRaidNeedsRebuff = false;
            member.hotRaidRebuffUntil = undefined;
        }
    }
    const recovering = members.filter(s => s.hotRaidNeedsRebuff);
    const providers = supportMembers.filter(s => !s.actor.state.fetchCasts?.() && !s.pendingSupportCast
        && Restrictions.canCast(s.actor)).map(s => s.actor);
    const recipients = (recovering.length ? recovering : members).map(s => ({ actor: s.actor, leader: s === owner }));
    const action = Support.nextPartyAction(recipients, providers, recovering.length
        ? recoveryOptions : { musicOnly: true, allowAttackInterrupt: true });
    if (!action || action.provider !== session.actor) return false;
    // Battle rebuffs never drag a provider through the encounter to reach an
    // outlying recipient. Other members keep their native attack cycles.
    if (!invoke('GameServer/Bot/AI/BotSkillIntent').inRange(session.actor, action.target, action.skill)) return false;
    Tactics.stop(session, session.actor);
    standForAction(session, session.actor);
    Support.queueSupportCast(session, action);
    Generics.skillExec(session, session.actor, { id: action.target.fetchId(), selfId: action.skill.fetchSelfId(), ctrl: false });
    session.lastDecision = { action: 'raid_rebuff', skillId: action.skill.fetchSelfId(), targetId: action.target.fetchId(), at: now };
    return true;
}

function preserveControlledAdds(session, bot, raidPlan) {
    if (raidPlan.minions.length <= 1) return;
    const Effects = invoke('GameServer/Effects/EffectStore');
    if ([bot.summon, bot.pet].some(pet => pet && raidPlan.minions.some(add =>
        Number(pet.attackTargetId) === Number(add.fetchId()) && Effects.impairments(add).disabled))) {
        Tactics.followSummon(session, bot);
    }
}

function tick(session, bot, Generics, AI, context, now = Date.now()) {
    const { owner, members, near = members, raidPlan, raidTank, partyId = null, playerLeader = null, combatBuffs } = context;
    const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
    preserveControlledAdds(session, bot, raidPlan);
    if (!Restrictions.canUseBasicAction(bot)) return true;
    if (bot.state.fetchCasts?.() && !Restrictions.canCast(bot)) bot.attack?.abortCast?.(session, bot);
    if (bot.state.fetchCasts?.()) return true;
    const role = Roles.inferRole(bot);
    let combatTarget = raidPlan.boss;
    const isRaidTank = session === raidTank;
    const bossHeldByTank = !!raidTank && Threats.alive(raidTank.actor) && Number(raidPlan.boss.fetchDestId?.()) === Number(raidTank.actor.fetchId());
    if (bossHeldByTank) owner.raidOpenedBossId = raidPlan.boss.fetchId();
    const attackers = [raidPlan.boss, ...raidPlan.minions]
        .filter(npc => Threats.alive(npc) && Number(npc.fetchDestId?.()) === Number(bot.fetchId()));
    const defense = attackers.length ? ClassTactics.selfAction(bot, {
        role, activeMobs: attackers.length, raidBoss: true, target: attackers[0]
    }) : null;
    if (defense) {
        castRaidSkill(session, bot, bot, defense.skill, Generics);
        session.lastDecision = { action: 'raid_defense', skillId: defense.skill.fetchSelfId(),
            targetId: bot.fetchId(), partyId, at: now };
        return true;
    }
    if (!isRaidTank) {
        const pickup = raidMinionPickup(owner, members, raidPlan, raidTank, now, playerLeader);
        if (pickup?.provider === session) {
            rememberRaidAction(owner, pickup.target, pickup.skill, now, RAID_AGGRESSION_RETRY_MS);
            castRaidSkill(session, bot, pickup.target, pickup.skill, Generics);
            session.lastDecision = { action: 'raid_taunt_add', targetId: pickup.target.fetchId(),
                skillId: pickup.skill.fetchSelfId(), partyId, at: now };
            return true;
        }
    }
    if (!isRaidTank && !bossHeldByTank && (owner.raidOpenedBossId !== raidPlan.boss.fetchId()
        || Number(raidPlan.boss.fetchDestId?.()) === Number(bot.fetchId()))) {
        Tactics.stop(session, bot);
        Tactics.followSummon(session, bot);
        session.currentTargetId = undefined;
        bot.unselect?.();
        session.lastDecision = { action: 'raid_wait_tank', targetId: raidPlan.boss.fetchId(),
            partyId, at: now };
        return true;
    }

    if (!isRaidTank && combatBuffs?.(session, owner, near, Generics, now)) return true;
    if (!isRaidTank && session.hotRaidNeedsRebuff) {
        Tactics.stop(session, bot);
        session.currentTargetId = undefined;
        bot.unselect?.();
        session.lastDecision = { action: 'raid_wait_minimal_rebuff', until: session.hotRaidRebuffUntil,
            partyId, at: now };
        return true;
    }
    combatTarget = isRaidTank
        ? raidPlan.boss
        : (raidPlan.focusMinion || raidPlan.boss);

    if (isRaidTank && Number(raidPlan.boss.fetchDestId?.() || 0) !== Number(bot.fetchId())) {
        const aggression = SkillCapabilities.aggressionSkill(bot);
        if (aggression && ClassTactics.usable(bot, aggression, 0.08)
            && canAttemptRaidAction(owner, raidPlan.boss, aggression, now, RAID_AGGRESSION_RETRY_MS)) {
            rememberRaidAction(owner, raidPlan.boss, aggression, now, RAID_AGGRESSION_RETRY_MS);
            castRaidSkill(session, bot, raidPlan.boss, aggression, Generics);
            session.lastDecision = { action: 'raid_taunt_boss', targetId: raidPlan.boss.fetchId(),
                skillId: aggression.fetchSelfId(), partyId, at: now };
            return true;
        }
    }

    const canAttempt = (raidTarget, skill) => canAttemptRaidAction(owner, raidTarget, skill, now)
        && (role !== 'healer' || Threats.distance(bot, raidTarget) <= Number(skill.fetchDistance?.() || 0));
    // Silence/magic mute must not strand melee support classes in a loop
    // of rejected control and debuff casts. Sword Singers and Bladedancers
    // are physical fighters after their party music is applied, so when
    // casting is unavailable they must fall through to executeCombat and
    // use their weapon normally.
    if (!isRaidTank && Restrictions.canCast(bot)) {
        const control = ClassTactics.supportCrowdControl(bot, raidPlan.minions, {
            raid: true,
            primaryTargetId: raidPlan.focusMinion?.fetchId?.() || null,
            canAttempt
        });
        if (control) {
            rememberRaidAction(owner, control.target, control.skill, now);
            castRaidSkill(session, bot, control.target, control.skill, Generics);
            session.lastDecision = { action: 'raid_control_add', targetId: control.target.fetchId(),
                skillId: control.skill.fetchSelfId(), partyId, at: now };
            return true;
        }
        const debuff = ClassTactics.raidDebuffAction(bot,
            [raidPlan.boss, raidPlan.focusMinion].filter(Boolean), {
                primaryTargetId: raidPlan.boss.fetchId(),
                canAttempt
            });
        if (debuff) {
            rememberRaidAction(owner, debuff.target, debuff.skill, now);
            castRaidSkill(session, bot, debuff.target, debuff.skill, Generics);
            session.lastDecision = { action: 'raid_debuff', targetId: debuff.target.fetchId(),
                skillId: debuff.skill.fetchSelfId(), partyId, at: now };
            return true;
        }
    }
    // Support adapters already attempted healing/resurrection. Full MP or an
    // unsafe sitting position must never turn the healer into a damage slot.
    if (role === 'healer') {
        if (bot.state.fetchHits?.()) Tactics.stop(session, bot);
        if (session.currentTargetId || bot.fetchDestId?.()) bot.unselect?.();
        session.currentTargetId = undefined;
        Tactics.followSummon(session, bot);
        if (raidTank && Threats.distance(bot, raidTank.actor) > 700 && Restrictions.canMove(bot)) {
            standForAction(session, bot);
            if (!bot.state.fetchTowards?.()) {
                Tactics.stop(session, bot);
                const point = actor => ({ locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() });
                bot.moveTo({ from: point(bot), to: point(raidTank.actor) });
            }
            session.lastDecision = { action: 'raid_heal_approach', targetId: raidTank.actor.fetchId(), partyId, at: now };
            return true;
        }
        // Regenerate seated only in a safe support position. Hysteresis avoids
        // repeated stand/sit packets near full MP; preserve an active heal route.
        if (!attackers.length && !Awareness.underDirectNpcAttack(session)
            && !bot.state.fetchTowards?.() && near.every(s => Threats.distance(bot, s.actor) <= 900)
            && ratio(bot.fetchMp(), bot.fetchMaxMp()) < (bot.state.fetchSeated() ? 0.98 : 0.9)) {
            if (!bot.state.fetchSeated()) {
                Tactics.stop(session, bot);
                bot.state.setSeated(true);
                session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(bot), bot);
            }
            bot.automation.replenishVitals(bot);
            session.lastDecision = { action: 'raid_healer_recovery', partyId, at: now };
        } else {
            standForAction(session, bot);
            session.lastDecision = { action: 'raid_healer_ready', partyId, at: now };
        }
        return true;
    }
    standForAction(session, bot);
    if (session.currentTargetId !== combatTarget.fetchId()) {
        Tactics.stop(session, bot);
        session.currentTargetId = combatTarget.fetchId();
        bot.select({ id: combatTarget.fetchId() });
    }
    session.lastDecision = { action: session === raidTank ? 'raid_hold_boss'
        : combatTarget === raidPlan.boss ? 'raid_damage_boss' : 'raid_focus_add',
        targetId: combatTarget.fetchId(), partyId, at: now };
    // Attack.meleeHit owns the whole native weapon cycle and repeats it when
    // the cycle completes. Re-dispatching attackExec from every bot AI tick
    // stacks parallel hit timers and floods nearby clients with shot-charge
    // and attack packets. Movement and casts likewise already own their
    // completion callbacks; wait for that action slot before choosing another
    // ordinary combat action.
    if (bot.state.fetchTowards?.() || bot.state.fetchHits?.() || bot.state.fetchCasts?.()) {
        return true;
    }
    AI.executeCombat(session, bot, combatTarget, Generics, {
        party: true,
        playerPartyRaidLeaderSession: playerLeader,
        autonomousClanRaid: !playerLeader
    });
    return true;
}

module.exports = { mainRaidTank, standForAction, combatRaidBuffs, preserveControlledAdds, tick };
