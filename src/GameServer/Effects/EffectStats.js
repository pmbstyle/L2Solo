const EffectStore = invoke('GameServer/Effects/EffectStore');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const GameTime = invoke('GameServer/World/GameTime');
const SkillRequirements = invoke('GameServer/Skills/SkillRequirements');

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

function situationalMultiplier(actor, stat, context = {}, fallback = 1) {
    const position = context.behind
        ? 'behind'
        : context.front
            ? 'front'
            : 'side';
    const gear = gearOf(actor);
    return EffectStore.list(actor)
        .flatMap((effect) => effect.situationalStats || [])
        .filter((entry) => entry.position === position && SkillRequirements.requirementsMet(entry.requires, gear))
        .map((entry) => Number(entry.stats?.[stat]))
        .filter((value) => Number.isFinite(value))
        .reduce((total, value) => total * value, fallback);
}

// Gear and situation are read once per lookup, and only when a rule asks.
function statValues(actor, stat) {
    const effects = EffectStore.list(actor);
    const gear = gearOf(actor);
    const situation = situationOf(actor);
    const values = effects.map((effect) => Number(effect.stats?.[stat]));
    for (const effect of effects) {
        for (const entry of effect.conditionalStats || []) {
            if (SkillRequirements.conditionMet(entry.condition, situation)
                && SkillRequirements.requirementsMet(entry.requires, gear)) values.push(Number(entry.stats?.[stat]));
        }
    }
    const skills = [
        ...(actor?.skillset?.fetchSkills?.() || []),
        ...(actor?.fetchPassiveSkills?.() || [])
    ];
    for (const skill of skills) {
        if (skill?.fetchPassive?.() !== true) continue;
        const semantic = C4SkillRules.resolve({
            selfId: skill.fetchSelfId?.(),
            name: skill.fetchName?.(),
            level: skill.fetchLevel?.()
        });
        for (const stats of SkillRequirements.passiveStats(semantic, gear, situation)) values.push(Number(stats?.[stat]));
    }
    return values;
}

// What the actor wears, from its backpack. Each field is read on first use
// and kept for the rest of the lookup.
function gearOf(actor) {
    const backpack = actor?.backpack;
    const cache = {};
    const armors = () => cache.armors ??= backpack?.fetchEquippedArmors?.() || [];
    const kindAt = (slot) => armors().find((item) => Number(item?.fetchSlot?.()) === slot)?.fetchKind?.();
    return {
        get weaponKind() { return cache.weaponKind ??= backpack?.fetchTotalWeaponKind?.() || ''; },
        get armorKinds() { return cache.armorKinds ??= armors().map((item) => item?.fetchKind?.()); },
        get setKind() { return cache.setKind ??= SkillRequirements.wornSetKind(kindAt(15), kindAt(10), kindAt(11)); },
        get shield() { return cache.shield ??= Number(backpack?.fetchTotalShieldPDef?.()) > 0; }
    };
}

function situationOf(actor) {
    const state = actor?.state;
    return {
        get hp() { return Number(actor?.fetchHp?.()) || 0; },
        get maxHp() { return Number(actor?.fetchMaxHp?.()) || 0; },
        get moving() { return !!state?.inMotion?.(); },
        get walking() { return !!state?.fetchWalkin?.(); },
        get seated() { return !!state?.fetchSeated?.(); },
        get night() {
            const clock = actor?.gameTime || actor?.world?.gameTime;
            if (typeof clock?.isNight === 'function') return !!clock.isNight();
            if (typeof actor?.isNight === 'function') return !!actor.isNight();
            return GameTime.isNight();
        }
    };
}

module.exports = {
    multiplier,
    add,
    situationalMultiplier
};
