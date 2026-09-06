const Capabilities = invoke('GameServer/Bot/AI/BotSkillCapabilities');
const ClassTactics = invoke('GameServer/Bot/AI/PartyClassTactics');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Effects = invoke('GameServer/Effects/EffectStore');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const SkillRules = invoke('GameServer/Skills/C4SkillRules');

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

function usable(actor, skill) {
    if (!skill || !Restrictions.canCast(actor) || actor.canUseSkill?.(skill) === false) return false;
    if (Number(skill.fetchConsumedMp?.() || 0) > Number(actor.fetchMp?.() || 0)) return false;
    const selfHp = skill.fetchSemantic?.()?.condition?.actorHpPercentAtMost;
    if (selfHp !== undefined && ratio(actor) * 100 > selfHp) return false;
    const requires = skill.fetchSemantic?.()?.requires || {};
    if (requires.itemKind === 'shield' && !ClassTactics.hasEquippedShield(actor)) return false;
    if (requires.weaponsAllowed && !(Number(requires.weaponsAllowed) & invoke('GameServer/Actor/Attack').weaponMaskFor(actor))) return false;
    return true;
}

function cast(session, actor, target, skill, Generics, reason, hostile = false) {
    if (!usable(actor, skill)) return false;
    // Cancel the old auto-attack before a control or heal; otherwise the next
    // queued swing can break Sleep or replace a friendly target mid-cast.
    stop(session, actor);
    session.lastCombatDecision = { action: hostile ? 'pvp_control' : 'pvp_support', reason,
        skillId: skill.fetchSelfId(), targetId: target.fetchId(), at: Date.now() };
    Generics.skillExec(session, actor, { id: target.fetchId(), selfId: skill.fetchSelfId(), ctrl: hostile });
    return true;
}

function support(session, bot, context, Generics, now) {
    if (bot.state?.fetchCasts?.()) return false;
    const wounded = context.members.map(member => member.actor)
        .filter(actor => ratio(actor) < 0.7 && Threats.distance(bot, actor) <= 900)
        .sort((a, b) => ratio(a) - ratio(b));
    const target = wounded[0];
    if (target) {
        const nativeParty = session.partyCompanion === true || context.members.some(member => member.followPlayerSession === session);
        const group = wounded.length >= 3 && nativeParty;
        const skills = Capabilities.healSkills(bot).filter(skill => usable(bot, skill))
            .filter(skill => skill.fetchTargetKind() !== 'party' || nativeParty);
        const chosen = [...skills].sort((a, b) => {
            const preferred = skill => (skill.fetchTargetKind() === 'party' && group ? 100000 : 0) + Number(skill.fetchPower?.() || 0);
            return preferred(b) - preferred(a);
        })[0];
        const claims = context.owner.pvpHealClaims || (context.owner.pvpHealClaims = new Map());
        for (const [key, expiry] of claims) if (expiry <= now) claims.delete(key);
        if (chosen && !claims.has(target.fetchId()) && cast(session, bot, target, chosen, Generics, 'wounded_party_member')) {
            const recipients = chosen.fetchTargetKind() === 'party' ? wounded : [target];
            for (const recipient of recipients) claims.set(recipient.fetchId(), now + 1500);
            return true;
        }
    }
    const recharge = Capabilities.manaRechargeSkill(bot);
    const drained = context.members.map(member => member.actor).find(actor => actor !== bot &&
        Roles.shouldRestForMana(actor) && actor.fetchMp() / Math.max(1, actor.fetchMaxMp()) < 0.2 &&
        Threats.distance(bot, actor) <= 900);
    if (drained && bot.fetchMp() / Math.max(1, bot.fetchMaxMp()) > 0.35 &&
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
        return skill.fetchSkillType?.() === SkillRules.EFFECT && skill.fetchTargetKind?.() === 'enemy' &&
            semantic.effectType === 'debuff' && !semantic.notUsedInC4 && !semantic.undeadOnly &&
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
            if (fleeing && !/sleep|fear|root|stun|slow/.test(effect)) continue;
            if (!effect || (target === primary && !fleeing && /sleep|fear/.test(effect))) continue;
            if (Threats.distance(bot, target) > Math.max(0, Number(skill.fetchDistance?.() || 0))) continue;
            if (Effects.list(target).some(entry => entry.key === effect || Number(entry.id) === Number(skill.fetchSelfId()))) continue;
            const key = `${target.fetchId()}:${effect}`;
            if (claims.has(key)) continue;
            if (cast(session, bot, target, skill, Generics, 'disable_aggressor', true)) {
                claims.set(key, now + 8000);
                return true;
            }
        }
    }
    return false;
}

module.exports = { usable, support, control, stop };
