// Event-driven target tracking for hot party casts. A target owns only the
// casts that are currently in flight against it, so death handling touches a
// handful of casters instead of polling HP or scanning every online bot.
const castsByTarget = new WeakMap();
const castByActor = new WeakMap();

function pending(target) {
    const entries = [...(castsByTarget.get(target) || [])];
    return entries.filter(entry => {
        if (Date.now() <= entry.landsAt + 1500) return true;
        clear(entry.actor);
        return false;
    });
}

function scopeFor(session) {
    const owner = session?.partyCompanion ? session.followPlayerSession : session;
    const commander = invoke('GameServer/Bot/AI/ClanCommandParty').commanderFor(owner);
    return commander?.commandParties?.size ? commander : null;
}

function effectKey(skill) {
    const semantic = skill?.fetchSemantic?.() || {};
    if (semantic.skillType === 'aggroDamage') return 'aggression';
    const effect = String(semantic.effect || '').toLowerCase();
    return /^(root|sleep|stun|paralyze|fear)$/.test(effect) ? 'control'
        : semantic.stackFamily || effect || null;
}

function expectedDamage(actor, target, skill) {
    const Rules = invoke('GameServer/Skills/C4SkillRules');
    if (![Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN, Rules.BLOW].includes(skill?.fetchSkillType?.())) return 0;
    const stat = (body, name) => Number(body?.[`fetchCollective${name}`]?.() ?? body?.[`fetch${name}`]?.()) || 0;
    const magic = skill.fetchSpell?.() === true;
    const attack = stat(actor, magic ? 'MAtk' : 'PAtk'), defense = stat(target, magic ? 'MDef' : 'PDef');
    const power = Number(skill.fetchPower?.()) || 0;
    if (!(attack > 0 && defense > 0 && power > 0)) return 0;
    const Hit = invoke('GameServer/Combat/HitRules'), View = invoke('GameServer/Combat/CombatantView');
    const damage = magic ? Hit.expectedMagicSkill(View.view({ mAtk: attack }), View.view({ mDef: defense }), { power })
        : Hit.expectedPhysicalSkill(View.view({ pAtk: attack }), View.view({ pDef: defense }), { power, blow: skill.fetchSkillType() === Rules.BLOW });
    return Math.max(0, Number(damage) || 0) * 0.8;
}

function isDamageSkill(skill) {
    const Rules = invoke('GameServer/Skills/C4SkillRules');
    return [Rules.DAMAGE, Rules.DAMAGE_EFFECT, Rules.DRAIN, Rules.BLOW, Rules.DEATH_LINK, Rules.FATAL]
        .includes(skill?.fetchSkillType?.());
}

function protectedControl(scope, target) {
    if (!target || Number(scope?.actor?.fetchDestId?.()) === Number(target.fetchId?.())) return false;
    const effects = invoke('GameServer/Effects/EffectStore');
    if (effects.list(target).some(effect => /^(sleep|fear)$/.test(effect.key || effect.category))) return true;
    return pending(target).some(entry => entry.scope === scope
        && /^(sleep|fear)$/.test(entry.skill?.fetchSemantic?.()?.effect || ''));
}

// Rechecked by the native cast boundary as well as the planner. Only accepted
// in-flight casts reserve a target; interruption/impact/death releases them.
function mayCast(session, target, skill) {
    const scope = scopeFor(session);
    if (skill?.fetchTargetKind?.() !== 'enemy' || !session?.partyCompanion) return true;
    if (!invoke('GameServer/Bot/AI/ClanCommandParty').canAttack(session, target)) return false;
    if (!scope) return true;
    const semantic = skill.fetchSemantic?.() || {}, key = effectKey(skill);
    if (key === 'aggression' && semantic.sourceTarget !== 'aura'
        && !invoke('GameServer/Bot/AI/ClanCommandParty').canTaunt(session, target)) return false;
    const entries = pending(target).filter(entry => entry.scope === scope && entry.actor !== session.actor);
    if (/^(sleep|fear)$/.test(semantic.effect || '') && entries.some(entry => isDamageSkill(entry.skill))) return false;
    if (key && entries.some(entry => effectKey(entry.skill) === key)) return false;
    if (key === 'control') {
        const impairment = invoke('GameServer/Effects/EffectStore').impairments(target);
        if (impairment.disabled || impairment.rooted) return false;
    }
    if (expectedDamage(session.actor, target, skill) > 0) {
        if (protectedControl(scope, target)) return false;
        const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
        const hitMs = Utility.skillHitMs({ castSpd: Math.max(1, Utility.statOf(session.actor, 'CastSpd')),
            atkSpd: Math.max(1, Utility.statOf(session.actor, 'AtkSpd')) }, skill);
        const incoming = entries.filter(entry => entry.landsAt <= Date.now() + hitMs)
            .reduce((sum, entry) => sum + expectedDamage(entry.actor, target, entry.skill), 0);
        if (incoming >= Number(target.fetchHp?.()) && incoming > 0) return false;
        if (['area', 'front_area', 'aura'].includes(semantic.sourceTarget)) {
            const center = semantic.sourceTarget === 'aura' ? session.actor : target;
            const nearby = invoke('GameServer/World/World').fetchNpcsInRadius(center.fetchLocX(), center.fetchLocY(), Number(semantic.radius) || 0);
            if (nearby.some(npc => protectedControl(scope, npc))) return false;
        }
    }
    return true;
}

function isTrackable(session, target, skill) {
    return (session?.partyCompanion === true && !!session.followPlayerSession || !!scopeFor(session)) &&
        (target?.fetchAttackable?.() === true || !!scopeFor(session) && target?.fetchIsOnline?.() === true) &&
        skill?.fetchTargetKind?.() === 'enemy';
}

function clear(actor) {
    const entry = actor ? castByActor.get(actor) : null;
    if (!entry) return false;

    castByActor.delete(actor);
    const targetCasts = castsByTarget.get(entry.target);
    if (targetCasts) {
        targetCasts.delete(entry);
        if (targetCasts.size === 0) castsByTarget.delete(entry.target);
    }
    if (actor.attack?.activePartyCast === entry) {
        actor.attack.activePartyCast = null;
    }
    return true;
}

function begin(session, actor, target, skill) {
    clear(actor);
    if (!isTrackable(session, target, skill)) return false;

    const entry = {
        session,
        actor,
        target,
        skill,
        scope: scopeFor(session),
        landsAt: Date.now() + Math.max(1, Number(skill.fetchCalculatedHitTime?.() || skill.fetchHitTime?.() || 1000)),
        targetId: Number(target.fetchId?.() || 0) || null,
        skillId: Number(skill.fetchSelfId?.() || 0) || null
    };
    let targetCasts = castsByTarget.get(target);
    if (!targetCasts) {
        targetCasts = new Set();
        castsByTarget.set(target, targetCasts);
    }
    targetCasts.add(entry);
    castByActor.set(actor, entry);
    if (actor.attack) actor.attack.activePartyCast = entry;
    return true;
}

function cancelForDeadNpc(npc) {
    const targetCasts = castsByTarget.get(npc);
    if (!targetCasts || targetCasts.size === 0) return 0;

    const entries = [...targetCasts];
    castsByTarget.delete(npc);
    let cancelled = 0;

    entries.forEach((entry) => {
        castByActor.delete(entry.actor);
        if (entry.actor?.attack?.activePartyCast === entry) {
            entry.actor.attack.activePartyCast = null;
        }
        if (!entry.session?.partyCompanion || !entry.actor?.state?.fetchCasts?.()) return;
        if (entry.actor.attack?.abortCast?.(entry.session, entry.actor) !== true) return;

        entry.session.lastCombatDecision = {
            action: 'cast_cancelled',
            reason: 'target_died',
            targetId: entry.targetId,
            skillId: entry.skillId,
            at: Date.now()
        };
        cancelled += 1;
    });

    return cancelled;
}

function trackedCount(target) {
    return castsByTarget.get(target)?.size || 0;
}

module.exports = { begin, clear, cancelForDeadNpc, isTrackable, trackedCount, mayCast, scopeFor, protectedControl, expectedDamage, isDamageSkill };
