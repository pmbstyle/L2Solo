const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');

const RAID_LEVEL_MAX_DIFFERENCE = 8;
const RAID_CURSE_SKILL_ID = 4215;
const PETRIFICATION_SKILL_ID = 4515;
const RAID_CURSE_DURATION_MS = 60 * 60 * 1000;
const PETRIFICATION_DURATION_MS = 120 * 1000;

function actorId(actor) {
    return Number(actor?.fetchId?.() || 0);
}

function combatLevel(actor) {
    const ownLevel = Number(actor?.fetchLevel?.() || 0);
    if (!actor?.fetchIsSummon?.()) return ownLevel;

    const ownerId = Number(actor?.fetchOwnerId?.() || 0);
    if (!ownerId) return ownLevel;

    try {
        const World = invoke('GameServer/World/World');
        const owner = (World.user?.sessions || [])
            .map((session) => session?.actor)
            .find((candidate) => actorId(candidate) === ownerId);
        return Math.max(ownLevel, Number(owner?.fetchLevel?.() || 0));
    } catch (_) {
        return ownLevel;
    }
}

function isRaidBoss(target) {
    return target?.fetchIsRaidBoss?.() === true || target?.model?.raidBoss === true;
}

function isAboveRaidThreshold(actor, boss) {
    return combatLevel(actor) > Number(boss?.fetchLevel?.() || 0) + RAID_LEVEL_MAX_DIFFERENCE;
}

function currentCombatTargetId(target) {
    const automationTarget = target?.automation?.fetchDestId?.();
    if (automationTarget !== undefined && automationTarget !== null) return Number(automationTarget);

    const selectedTarget = target?.fetchDestId?.();
    if (target?.state?.fetchCombats?.() === true && selectedTarget !== undefined && selectedTarget !== null) {
        return Number(selectedTarget);
    }

    return null;
}

function isCurrentlyAttackingBoss(target, boss) {
    const bossId = Number(boss?.fetchId?.() || 0);
    const currentTargetId = currentCombatTargetId(target);
    if (currentTargetId !== null) return currentTargetId === bossId;

    // Real actors expose at least one live target API. Once that API reports
    // no combat target, a historical raidBossAttackTargetId must not keep
    // cursing support casters after they retarget or leave combat.
    const hasTargetApi = typeof target?.automation?.fetchDestId === 'function'
        || typeof target?.fetchDestId === 'function'
        || typeof target?.state?.fetchCombats === 'function';
    if (hasTargetApi) return false;

    // Keep compatibility with lightweight actors used by isolated tests.
    return Number(target?.model?.raidBossAttackTargetId || 0) === bossId;
}

function raidBossesAttackedBy(target) {
    const targetId = actorId(target);
    if (!targetId) return [];

    try {
        const World = invoke('GameServer/World/World');
        return (World.npc?.spawns || []).filter((boss) => (
            isRaidBoss(boss) &&
            isCurrentlyAttackingBoss(target, boss) &&
            (boss.model?.raidAttackers instanceof Set
                ? boss.model.raidAttackers.has(targetId)
                : Array.isArray(boss.model?.raidAttackers) && boss.model.raidAttackers.includes(targetId))
        ));
    } catch (_) {
        return [];
    }
}

function applyEffect(session, target, effect) {
    if (!target || !effect) return null;
    const applied = EffectStore.apply(target, effect);
    if (!applied) return null;

    EffectTicker.scheduleExpiry(session, target, applied);
    EffectRestrictions.interruptOnApply(target?.session || session, target, applied, effect.source);
    EffectTicker.refreshEffects(session, target);
    if (Object.keys(applied.stats || {}).length > 0) {
        try {
            invoke('GameServer/Actor/Generics/CalculateStats')(target?.session || session, target);
        } catch (_) {}
    }
    return applied;
}

function applyRaidCurse(session, actor, boss) {
    return applyEffect(session, actor, {
        key: 'raid_curse',
        id: RAID_CURSE_SKILL_ID,
        level: 1,
        name: 'Raid Curse',
        type: 'debuff',
        category: 'silence',
        dispellable: false,
        stats: { physicalMute: true, magicMute: true },
        durationMs: RAID_CURSE_DURATION_MS,
        source: boss
    });
}

function applyPetrification(session, actor, boss) {
    return applyEffect(session, actor, {
        key: 'raid_petrification',
        id: PETRIFICATION_SKILL_ID,
        level: 1,
        name: 'Petrification',
        type: 'debuff',
        category: 'paralyze',
        dispellable: false,
        durationMs: PETRIFICATION_DURATION_MS,
        source: boss
    });
}

function normalAttackBlocked(session, actor, target) {
    if (!isRaidBoss(target) || !isAboveRaidThreshold(actor, target)) return false;
    applyPetrification(session, actor, target);
    return true;
}

function skillBlocked(session, actor, targets, skill) {
    const semantic = skill?.fetchSemantic?.() || {};
    const directBoss = (targets || []).find((target) => isRaidBoss(target) && isAboveRaidThreshold(actor, target));
    if (directBoss) {
        applyRaidCurse(session, actor, directBoss);
        return true;
    }

    // C4 also curses a high-level support caster when the selected ally has
    // already attacked a raid boss. This is the native callSkill guard for
    // non-offensive skills; offensive skills are handled by the direct check.
    const offensiveTargets = new Set(['enemy', 'unlockable', 'corpse_mob']);
    const offensive = offensiveTargets.has(semantic.target) && semantic.effectType !== 'buff';
    if (!offensive) {
        for (const target of targets || []) {
            const boss = raidBossesAttackedBy(target)
                .find((candidate) => isAboveRaidThreshold(actor, candidate));
            if (boss) {
                applyRaidCurse(session, actor, boss);
                return true;
            }
        }
    }

    return false;
}

module.exports = {
    RAID_LEVEL_MAX_DIFFERENCE,
    RAID_CURSE_SKILL_ID,
    PETRIFICATION_SKILL_ID,
    combatLevel,
    isRaidBoss,
    isAboveRaidThreshold,
    normalAttackBlocked,
    skillBlocked
};
