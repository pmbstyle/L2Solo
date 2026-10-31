const EffectStore = invoke('GameServer/Effects/EffectStore');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const GameTime = invoke('GameServer/World/GameTime');
const SkillRequirements = invoke('GameServer/Skills/SkillRequirements');
const WeaponMask = invoke('GameServer/Skills/WeaponMask');

// posture: { seated } as if the actor sat or stood (a rest's choice,
// Automation's regen amounts); unset, its own state.
function multiplier(actor, stat, fallback = 1, posture = undefined) {
    return statValues(actor, stat, posture)
        .filter((value) => Number.isFinite(value))
        .reduce((total, value) => total * value, fallback);
}

function add(actor, stat, fallback = 0, posture = undefined) {
    return statValues(actor, stat, posture)
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
function statValues(actor, stat, posture = undefined) {
    const effects = EffectStore.list(actor);
    const gear = gearOf(actor);
    const situation = situationOf(actor, posture);
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
        // The skill's own shared semantic: passiveStats reads only condition,
        // requires and the stats rows, which come from the rule table alone
        // (an uncached resolve per lookup was 14% of sampled allocations, L126).
        const semantic = skill.fetchSemantic?.() || C4SkillRules.resolveCached({
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
    return new GearContext(actor?.backpack);
}

function situationOf(actor, posture = undefined) {
    return new SituationContext(actor, actor?.state, posture);
}

class GearContext {
    constructor(backpack) {
        this.backpack = backpack;
        this.cache = {};
    }

    armors() { return this.cache.armors ??= this.backpack?.fetchEquippedArmors?.() || []; }
    kindAt(slot) { return this.armors().find((item) => Number(item?.fetchSlot?.()) === slot)?.fetchKind?.(); }
    get weaponKind() {
        return this.cache.weaponKind ??= WeaponMask.weaponType(this.backpack?.fetchTotalWeaponKind?.() || '',
            this.backpack?.fetchEquippedWeapon?.()?.fetchSlot?.());
    }
    get armorKinds() { return this.cache.armorKinds ??= this.armors().map((item) => item?.fetchKind?.()); }
    get setKind() { return this.cache.setKind ??= SkillRequirements.wornSetKind(this.kindAt(15), this.kindAt(10), this.kindAt(11)); }
    get shield() { return this.cache.shield ??= Number(this.backpack?.fetchTotalShieldPDef?.()) > 0; }
}

class SituationContext {
    constructor(actor, state, posture = undefined) {
        this.actor = actor;
        this.state = state;
        this.posture = posture;
    }

    get hp() { return Number(this.actor?.fetchHp?.()) || 0; }
    get maxHp() { return Number(this.actor?.fetchMaxHp?.()) || 0; }
    get moving() { return this.posture ? false : !!this.state?.inMotion?.(); }
    get walking() { return this.posture ? false : !!this.state?.fetchWalkin?.(); }
    get seated() { return this.posture ? this.posture.seated === true : !!this.state?.fetchSeated?.(); }
    get night() {
        const actor = this.actor;
        const clock = actor?.gameTime || actor?.world?.gameTime;
        if (typeof clock?.isNight === 'function') return !!clock.isNight();
        if (typeof actor?.isNight === 'function') return !!actor.isNight();
        return GameTime.isNight();
    }
}

module.exports = {
    multiplier,
    add,
    situationalMultiplier
};
