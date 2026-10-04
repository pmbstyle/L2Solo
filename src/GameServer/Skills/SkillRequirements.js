// When a passive skill (and each of its conditional stat blocks) applies:
// one rule for hot EffectStats and the cold combat profile.
//
// `gear` is what the character wears:
//   { weaponKind, armorKinds (kinds of the worn armour pieces), setKind, shield }
// `situation` is the moment of the lookup:
//   { hp, maxHp, moving, walking, seated, night }
// A caller may give either as getters: a field is read only when a rule asks.

// The armour kind C4 counts as worn for "using kind" conditions
// (Lisvus Inventory.java:750-767 worn mask): a full-body armour alone, or a
// chest and legs of the same kind; '' when chest and legs differ.
function wornSetKind(fullBodyKind, chestKind, legsKind) {
    if (fullBodyKind) return fullBodyKind;
    return chestKind && chestKind === legsKind ? chestKind : '';
}

function requirementsMet(requires, gear) {
    if (!requires) return true;
    if (requires.weaponKinds && !requires.weaponKinds.includes(gear.weaponKind)) return false;
    if (requires.armorKind && !gear.armorKinds.includes(requires.armorKind)) return false;
    if (requires.armorKinds && !requires.armorKinds.some((kind) => gear.armorKinds.includes(kind))) return false;
    if (requires.excludedArmorKinds && requires.excludedArmorKinds.some((kind) => gear.armorKinds.includes(kind))) return false;
    if (requires.armorSetKind && gear.setKind !== requires.armorSetKind) return false;
    if (requires.excludedArmorSetKinds && requires.excludedArmorSetKinds.includes(gear.setKind)) return false;
    if (requires.shield && !gear.shield) return false;
    return true;
}

function conditionMet(condition, situation) {
    if (!condition) return true;
    if (condition.actorHpPercentAtMost !== undefined) {
        const maxHp = situation.maxHp;
        if (!maxHp || situation.hp > maxHp * Number(condition.actorHpPercentAtMost) / 100) return false;
    }
    if (condition.moving !== undefined && situation.moving !== condition.moving) return false;
    if (condition.walking !== undefined && situation.walking !== condition.walking) return false;
    if (condition.seated !== undefined && situation.seated !== condition.seated) return false;
    if (condition.night !== undefined && situation.night !== condition.night) return false;
    return true;
}

// The stat blocks of one resolved passive skill that apply: none when the
// skill's own condition or requirements fail, otherwise its stats plus every
// conditional block whose condition and requirements hold.
function passiveStats(semantic, gear, situation) {
    if (!conditionMet(semantic.condition, situation) || !requirementsMet(semantic.requires, gear)) return [];
    const stats = semantic.stats ? [semantic.stats] : [];
    for (const entry of semantic.conditionalStats || []) {
        if (conditionMet(entry.condition, situation) && requirementsMet(entry.requires, gear)) stats.push(entry.stats);
    }
    return stats;
}

module.exports = { wornSetKind, requirementsMet, conditionMet, passiveStats };
