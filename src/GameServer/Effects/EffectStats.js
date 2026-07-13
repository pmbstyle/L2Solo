const EffectStore = invoke('GameServer/Effects/EffectStore');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');

function multiplier(actor, stat, fallback = 1) {
    return statValues(actor, stat)
        .filter((value) => Number.isFinite(value))
        .reduce((total, value) => total * value, fallback);
}

function add(actor, stat, fallback = 0) {
    return statValues(actor, stat)
        .filter((value) => Number.isFinite(value))
        .reduce((total, value) => total + value, fallback);
}

function statValues(actor, stat) {
    return [
        ...EffectStore.list(actor).map((effect) => Number(effect.stats?.[stat])),
        ...passiveStatValues(actor, stat)
    ];
}

function passiveStatValues(actor, stat) {
    const skills = actor?.skillset?.fetchSkills?.() || [];
    return skills
        .filter((skill) => skill?.fetchPassive?.() === true)
        .map((skill) => C4SkillRules.resolve({
            selfId: skill.fetchSelfId?.(),
            name: skill.fetchName?.(),
            level: skill.fetchLevel?.()
        }))
        .flatMap((semantic) => passiveValuesForSemantic(actor, semantic, stat))
        .filter((value) => Number.isFinite(value));
}

function passiveValuesForSemantic(actor, semantic, stat) {
    if (!matchesCondition(actor, semantic.condition) || !matchesRequirements(actor, semantic.requires)) return [];
    return [
        Number(semantic.stats?.[stat]),
        ...(semantic.conditionalStats || [])
            .filter((entry) => matchesCondition(actor, entry.condition))
            .map((entry) => Number(entry.stats?.[stat]))
    ];
}

function matchesCondition(actor, condition = {}) {
    condition = condition || {};
    if (condition.actorHpPercentAtMost !== undefined) {
        const maxHp = Number(actor?.fetchMaxHp?.()) || 0;
        const hp = Number(actor?.fetchHp?.()) || 0;
        if (!maxHp || hp / maxHp * 100 > Number(condition.actorHpPercentAtMost)) return false;
    }

    const state = actor?.state;
    const moving = !!state?.inMotion?.();
    if (condition.moving !== undefined && moving !== condition.moving) return false;
    if (condition.walking !== undefined && !!state?.fetchWalkin?.() !== condition.walking) return false;
    if (condition.seated !== undefined && !!state?.fetchSeated?.() !== condition.seated) return false;
    if (condition.night !== undefined) {
        const clock = actor?.gameTime || actor?.world?.gameTime;
        const night = typeof clock?.isNight === 'function'
            ? !!clock.isNight()
            : typeof actor?.isNight === 'function'
                ? !!actor.isNight()
                // L2's world day is four real hours: each game hour lasts ten minutes.
                : Math.floor(Date.now() / 600000) % 24 < 6 || Math.floor(Date.now() / 600000) % 24 >= 18;
        if (night !== condition.night) return false;
    }
    return true;
}

function matchesRequirements(actor, requires = {}) {
    requires = requires || {};
    if (requires.weaponKinds) {
        const kind = actor?.backpack?.fetchTotalWeaponKind?.();
        if (!requires.weaponKinds.includes(kind)) return false;
    }
    if (requires.armorKind) {
        const equipped = actor?.backpack?.fetchEquippedArmors?.() || [];
        if (!equipped.some((item) => item?.fetchKind?.() === requires.armorKind)) return false;
    }
    if (requires.shield && !(Number(actor?.backpack?.fetchTotalShieldPDef?.()) > 0)) return false;
    return true;
}

module.exports = {
    multiplier,
    add
};
