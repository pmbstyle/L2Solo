const Capabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const ClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Effects = invoke('GameServer/Effects/EffectStore');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const SkillRules = invoke('GameServer/Skills/C4SkillRules');
const Intent = invoke('GameServer/Bot/AI/BotSkillIntent');

const ratio = actor => Number(actor.fetchHp?.() || 0) / Math.max(1, Number(actor.fetchMaxHp?.() || 1));

function stop(session, actor) {
    actor.attack?.abortCast?.(session, actor);
    actor.attack?.clearTimers?.();
    actor.attack?.resetQueuedEvent?.();
    actor.state?.setHits?.(false);
    actor.state?.setCasts?.(false);
    actor.storedAttack = undefined;
    actor.storedSpell = undefined;
    actor.automation?.abortAll?.(actor);
}

function followSummon(session, actor) {
    for (const pet of [actor?.summon, actor?.pet]) {
        if (pet && pet.controlMode !== 'follow' && Threats.alive(pet) && pet.automation?.scheduleAction &&
            Number(pet.fetchOwnerId?.()) === Number(actor?.fetchId?.())) {
            const Control = invoke('GameServer/Npc/SummonControl');
            // Follow refuses to move while an old hit/cast/chase is active.
            Control.stop(session, pet);
            Control.startFollowOwner(session, actor, pet);
        }
    }
}

function usable(actor, skill) {
    if (!Intent.usable(actor,skill)) return false;
    if (Number(skill.fetchConsumedMp?.() || 0) > Number(actor.fetchMp?.() || 0)) return false;
    const selfHp = skill.fetchSemantic?.()?.condition?.actorHpPercentAtMost;
    if (selfHp !== undefined && ratio(actor) * 100 > selfHp) return false;
    const requires = skill.fetchSemantic?.()?.requires || {};
    if (requires.itemKind === 'shield' && !ClassTactics.hasEquippedShield(actor)) return false;
    if (requires.weaponsAllowed && !(Number(requires.weaponsAllowed) & invoke('GameServer/Actor/Attack').weaponMaskFor(actor))) return false;
    return true;
}

function cast(session, actor, target, skill, Generics, reason, hostile = false) {
    if (!usable(actor, skill) || invoke('GameServer/Bot/AI/BotActionFeedback').blocked(actor,target,skill)) return false;
    // Cancel the old auto-attack before a control or heal; otherwise the next
    // queued swing can break Sleep or replace a friendly target mid-cast.
    stop(session, actor);
    if (actor.state?.fetchSeated?.()) {
        actor.state.setSeated(false);
        session.dataSendToOthers(invoke('GameServer/Network/Response').sitAndStand(actor), actor);
    }
    session.lastCombatDecision = { action: hostile ? 'pvp_control' : 'pvp_support', reason,
        skillId: skill.fetchSelfId(), targetId: target.fetchId(), at: Date.now() };
    Generics.skillExec(session, actor, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl: hostile });
    return true;
}

function alliedForHeal(provider, target) {
    if (provider === target) return true;
    const clanId = Number(provider.fetchClanId?.());
    if (clanId > 0 && clanId === Number(target.fetchClanId?.())) return true;
    const Pledge = invoke('GameServer/Network/Response/PledgeHelpers');
    const allyId = Number(Pledge.allyId(provider));
    return allyId > 0 && allyId === Number(Pledge.allyId(target));
}

function support(session, bot, context, Generics, now) {
    if (bot.state?.fetchCasts?.()) return false;
    const wounded = context.members.map(member => member.actor)
        .filter(actor => Intent.alive(actor) && ratio(actor) < 0.7 && Threats.distance(bot, actor) <= 900)
        .sort((a, b) => ratio(a) - ratio(b));
    for (const target of wounded) {
        const nativeParty = !!session.hotBackgroundPartyId || session.partyCompanion === true
            || context.members.some(member => member.followPlayerSession === session);
        const recipientsFor = skill => {
            const kind = skill.fetchTargetKind();
            if (kind === 'friendly') return Intent.inRange(bot, target, skill) ? [target] : [];
            if (kind === 'party' && !nativeParty) return [];
            const radius = Number(skill.fetchSemantic?.()?.radius || skill.fetchDistance?.() || 900);
            return wounded.filter(actor => Threats.distance(bot, actor) <= radius
                && (kind !== 'ally' || alliedForHeal(bot, actor)));
        };
        const skills = Capabilities.healSkills(bot).filter(skill => usable(bot, skill))
            .filter(skill => recipientsFor(skill).includes(target))
            .filter(skill => !skill.fetchSemantic?.()?.hot || !Intent.equivalentActive(target, skill));
        const chosen = [...skills].sort((a, b) => {
            const preferred = skill => {
                const semantic = skill.fetchSemantic?.() || {};
                const power = semantic.skillType === SkillRules.HEAL_PERCENT
                    ? target.fetchMaxHp() * Number(skill.fetchPower?.() || 0) / 100
                    : Number(semantic.hot?.heal ?? semantic.healPower ?? skill.fetchPower?.() ?? 0);
                return invoke('GameServer/Bot/AI/PartyHealPolicy').score({
                    missingHp: target.fetchMaxHp() - target.fetchHp(), maxHp: target.fetchMaxHp(),
                    power, cost: Number(skill.fetchConsumedMp?.() || 0), castMs: Number(skill.fetchHitTime?.() || 0),
                    periodic: !!semantic.hot, ticks: semantic.hot?.count,
                    recipients: recipientsFor(skill).length
                });
            };
            return preferred(b) - preferred(a);
        })[0];
        const claims = context.owner.pvpHealClaims || (context.owner.pvpHealClaims = new Map());
        for (const [key, expiry] of claims) if (expiry <= now) claims.delete(key);
        if (chosen && !claims.has(target.fetchId()) && cast(session, bot, target, chosen, Generics, 'wounded_party_member')) {
            // HoT upkeep must not reserve the target away from emergency heals.
            const duration = chosen.fetchSemantic?.()?.hot ? 250 : Math.max(1500, Number(chosen.fetchHitTime?.() || 0));
            for (const recipient of recipientsFor(chosen)) claims.set(recipient.fetchId(), now + duration);
            return true;
        }
    }
    const recharge = Capabilities.manaRechargeSkill(bot);
    const raid = context.raid === true;
    const drained = context.members.map(member => member.actor).filter(actor => actor !== bot && Intent.alive(actor) &&
        Roles.shouldRestForMana(actor) && actor.fetchMp() / Math.max(1, actor.fetchMaxMp()) < 0.2 &&
        (!raid || Roles.inferRole(bot) !== 'healer' || Roles.inferRole(actor) === 'healer') &&
        recharge && Intent.inRange(bot,actor,recharge))
        .sort((a, b) => Number(Roles.inferRole(b) === 'healer') - Number(Roles.inferRole(a) === 'healer'))[0];
    if (drained && (bot.fetchMp() - Number(recharge.fetchConsumedMp?.() || 0)) / Math.max(1, bot.fetchMaxMp()) > (raid ? 0.6 : 0.35) &&
        cast(session, bot, drained, recharge, Generics, 'party_mana')) return true;
    const self = ClassTactics.selfAction(bot, { role: Roles.inferRole(bot), activeMobs: context.threats.length });
    return !!self && cast(session, bot, bot, self.skill, Generics, self.reason);
}

function control(session, bot, context, primary, Generics, now, fleeing = false) {
    if (bot.state?.fetchCasts?.() || !Restrictions.canCast(bot)) return false;
    const claims = context.owner.pvpControlClaims || (context.owner.pvpControlClaims = new Map());
    for (const [key, expiry] of claims) if (expiry <= now) claims.delete(key);
    const skills = (bot.skillset?.fetchSkills?.() || bot.skillset?.skills || []).filter(skill => {
        const semantic = skill.fetchSemantic?.() || {};
        return (skill.fetchSkillType?.() === SkillRules.EFFECT && semantic.effectType === 'debuff'
            || [SkillRules.CANCEL,SkillRules.BANE].includes(skill.fetchSkillType?.())) && skill.fetchTargetKind?.() === 'enemy' &&
            !semantic.notUsedInC4 && !semantic.undeadOnly &&
            !['aura', 'area', 'front_area'].includes(semantic.sourceTarget) && usable(bot, skill);
    });
    // Control off-target aggressors before weakening the shared focus target.
    const others = context.threats.map(entry => entry.actor).filter(actor => actor !== primary);
    const targets = fleeing ? [primary, ...others] : [...others, primary];
    for (const target of targets) {
        if (Effects.impairments(target).disabled) continue;
        for (const skill of skills) {
            const semantic = skill.fetchSemantic();
            const effect = String(semantic.effect || '').toLowerCase();
            if (!Intent.debuffUseful(bot,target,skill,{primary:target===primary,fleeing})) continue;
            if (fleeing && !/sleep|fear|root|stun|slow/.test(effect)) continue;
            if (!effect && ![SkillRules.CANCEL,SkillRules.BANE].includes(skill.fetchSkillType?.())) continue;
            if (Threats.distance(bot, target) > Math.max(0, Number(skill.fetchDistance?.() || 0))) continue;
            if (Effects.list(target).some(entry => entry.key === effect || Number(entry.id) === Number(skill.fetchSelfId()))) continue;
            const key = `${target.fetchId()}:${effect || skill.fetchSelfId()}`;
            if (claims.has(key)) continue;
            if (cast(session, bot, target, skill, Generics, 'disable_aggressor', true)) {
                claims.set(key, now + 8000);
                return true;
            }
        }
    }
    return false;
}

module.exports = { usable, support, control, stop, followSummon };
