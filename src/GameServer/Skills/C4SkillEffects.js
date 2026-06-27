const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const Formulas = invoke('GameServer/Formulas');
const ServerResponse = invoke('GameServer/Network/Response');

function execute(session, actor, target, skill, context = {}) {
    const semantic = skill.fetchSemantic();
    const magicSkill = context.magicSkill ?? skill.fetchSpell();
    const rng = context.rng || Math.random;
    const result = {
        skillType: semantic.skillType,
        damage: 0,
        heal: 0,
        effect: null,
        missed: false,
        resisted: false,
        effectResisted: false,
        lethal: false,
        mpRestore: 0
    };

    if (semantic.skillType === C4SkillRules.HEAL) {
        result.heal = applyHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HEAL_PERCENT) {
        result.heal = applyHealPercent(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HEAL_HOT) {
        result.heal = applyHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        result.effect = applyEffect(session, target, skill, semantic);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HOT) {
        result.effect = applyEffect(session, target, skill, semantic);
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.CLEANSE) {
        result.cleansed = applyCleanse(session, target, semantic);
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HEAL_CLEANSE) {
        result.heal = applyHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        result.cleansed = applyCleanse(session, target, semantic);
        return result;
    }

    if (semantic.skillType === C4SkillRules.MANA_RECHARGE) {
        result.mpRestore = applyManaRecharge(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.BLOW) {
        if (!rollBlow(actor, target, semantic, context.attack, rng)) {
            clearLoadedShot(context.attack, actor, magicSkill);
            result.missed = true;
            return result;
        }

        result.damage = context.attack.prepareSkillDamage(actor, target, skill, magicSkill, rng);
        result.lethal = applyLethal(target, semantic, rng, result);
        return result;
    }

    if (magicSkill && isOffensive(semantic) && !rollMagicSuccess(actor, target, skill, semantic, rng)) {
        clearLoadedShot(context.attack, actor, magicSkill);
        result.resisted = true;
        return result;
    }

    if (semantic.skillType === C4SkillRules.DAMAGE || semantic.skillType === C4SkillRules.DAMAGE_EFFECT) {
        result.damage = context.attack.prepareSkillDamage(actor, target, skill, magicSkill, rng);
    }

    if (semantic.skillType === C4SkillRules.EFFECT || semantic.skillType === C4SkillRules.DAMAGE_EFFECT) {
        const resisted = isOffensive(semantic) && resistEffect(actor, target, skill, semantic, magicSkill, rng);
        if (resisted) {
            result.effectResisted = true;
        } else {
            result.effect = applyEffect(session, target, skill, semantic);
        }
    }

    return result;
}

function applyHeal(session, actor, target, skill, semantic, magicSkill, attack) {
    const usedSpiritshot = !!actor.spiritshotLoaded;
    const amount = Math.round(Formulas.calcHealAmount(
        semantic.healPower ?? skill.fetchPower(),
        { spiritshot: usedSpiritshot && skill.fetchSsBoost() > 0 }
    ));

    const maxHp = Number(target.fetchMaxHp?.()) || 0;
    const currentHp = Number(target.fetchHp?.()) || 0;
    const nextHp = maxHp > 0 ? Math.min(maxHp, currentHp + amount) : currentHp + amount;
    target.setHp(nextHp);
    refreshVitals(session, actor, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return Math.max(0, nextHp - currentHp);
}

function applyHealPercent(session, actor, target, skill, semantic, magicSkill, attack) {
    const power = Number(semantic.healPower ?? skill.fetchPower()) || 0;
    const maxHp = Number(target.fetchMaxHp?.()) || 0;
    const currentHp = Number(target.fetchHp?.()) || 0;
    const amount = Math.round(maxHp * power / 100);
    const nextHp = maxHp > 0 ? Math.min(maxHp, currentHp + amount) : currentHp + amount;
    target.setHp(nextHp);
    refreshVitals(session, actor, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return Math.max(0, nextHp - currentHp);
}

function applyManaRecharge(session, actor, target, skill, semantic, magicSkill, attack) {
    const amount = Formulas.calcManaRechargeAmount({
        power: semantic.manaPower ?? skill.fetchPower(),
        gainMp: EffectStats.add(target, 'gainMp'),
        casterLevel: actor.fetchLevel?.(),
        targetLevel: target.fetchLevel?.()
    });
    const maxMp = Number(target.fetchMaxMp?.()) || 0;
    const currentMp = Number(target.fetchMp?.()) || 0;
    const nextMp = maxMp > 0 ? Math.min(maxMp, currentMp + amount) : currentMp + amount;
    target.setMp(nextMp);
    refreshVitals(session, actor, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return Math.max(0, nextMp - currentMp);
}

function applyEffect(session, target, skill, semantic) {
    const durationMs = Number(skill.fetchBuffTime()) || 0;
    if (!durationMs || !semantic.effect) return null;

    const effect = EffectStore.apply(target, {
        key: semantic.effect,
        id: skill.fetchSelfId(),
        level: skill.fetchLevel(),
        name: skill.fetchName(),
        type: semantic.effectType || 'buff',
        category: semantic.trait || semantic.effect,
        stats: semantic.stats || {},
        dot: dotFromSkill(skill, semantic),
        hot: hotFromSkill(skill, semantic),
        durationMs
    });

    const buff = BuffCatalog.byTypeOrKey(semantic.effect);
    if (buff && semantic.effectType === 'buff') {
        if (!target.activeBuffs) target.activeBuffs = {};
        target.activeBuffs[buff.key] = Date.now() + durationMs;
    }

    if (effect?.dot) {
        EffectTicker.applyDot(session, session?.actor, target, effect);
    }

    if (effect?.hot) {
        EffectTicker.applyHot(session, session?.actor, target, effect);
    }

    EffectRestrictions.interruptOnApply(target?.session || session, target, effect);
    refreshEffects(session, target);
    return effect;
}

function applyCleanse(session, target, semantic) {
    const removed = [];
    (semantic.cleanse || []).forEach((entry) => {
        removed.push(...EffectStore.removeByCategory(target, entry.category, entry.maxLevel ?? Infinity));
    });
    if (removed.length) {
        refreshEffects(session, target);
    }
    return removed;
}

function dotFromSkill(skill, semantic) {
    if (!semantic.dot) return null;
    return {
        count: semantic.dot.count,
        intervalMs: semantic.dot.intervalMs,
        damage: semantic.dot.damage ?? damageByLevel(skill, semantic.dot) ?? skill.fetchPower()
    };
}

function hotFromSkill(skill, semantic) {
    if (!semantic.hot) return null;
    return {
        count: semantic.hot.count,
        intervalMs: semantic.hot.intervalMs,
        heal: semantic.hot.heal ?? skill.fetchPower()
    };
}

function damageByLevel(skill, dot) {
    if (!dot.damageByLevel) return null;
    const values = dot.damageByLevel;
    const index = Math.max(0, Math.min(values.length - 1, (Number(skill.fetchLevel()) || 1) - 1));
    return values[index];
}

function rollBlow(actor, target, semantic, attack, rng) {
    let chance = Number(semantic.blowChance) || 50;
    if (attack?.isBehindTarget?.(actor, target)) chance += 20;
    else if (attack?.isFacing?.(target, actor, 120)) chance -= 20;
    chance = Math.max(5, Math.min(95, chance));
    return chance >= rng() * 100;
}

function rollMagicSuccess(actor, target, skill, semantic, rng) {
    const chance = Formulas.calcMagicSuccessRate({
        attackerLevel: actor.fetchLevel?.(),
        targetLevel: target.fetchLevel?.(),
        magicLevel: semantic.magicLevel,
        levelDepend: semantic.levelDepend
    });
    return chance >= rng() * 100;
}

function resistEffect(actor, target, skill, semantic, magicSkill, rng) {
    const chance = Formulas.calcSkillEffectSuccessRate({
        baseChance: semantic.baseLandRate,
        magic: magicSkill,
        mAtk: actor.fetchCollectiveMAtk?.(),
        mDef: target.fetchCollectiveMDef?.(),
        blessedSpiritshot: !!actor.blessedSpiritshotLoaded,
        attackerLevel: actor.fetchLevel?.(),
        targetLevel: target.fetchLevel?.(),
        magicLevel: semantic.magicLevel,
        levelDepend: semantic.levelDepend,
        resistModifier: traitResistModifier(target, semantic.trait)
    });
    return !(chance >= rng() * 100);
}

const RESIST_STAT_BY_TRAIT = {
    shock: 'stunResist'
};

function traitResistModifier(target, trait) {
    const stat = RESIST_STAT_BY_TRAIT[trait] || `${trait}Resist`;
    const resist = EffectStats.add(target, stat);
    return Math.max(0, 1 - (resist / 100));
}

function applyLethal(target, semantic, rng, result) {
    const lethal = semantic.lethal || {};
    const maxHp = Number(target.fetchMaxHp?.()) || 0;
    const currentHp = Number(target.fetchHp?.()) || 0;
    if (maxHp <= 1 || currentHp <= 1) return false;

    const killChance = Number(lethal.killChance) || 0;
    if (killChance > 0 && killChance >= rng() * 100) {
        result.damage = Math.max(result.damage, currentHp - 1);
        return true;
    }

    const halfKillChance = Number(lethal.halfKillChance) || 0;
    if (halfKillChance > 0 && halfKillChance >= rng() * 100) {
        result.damage = Math.max(result.damage, currentHp - Math.max(1, Math.floor(maxHp / 2)));
        return true;
    }

    return false;
}

function isOffensive(semantic) {
    return semantic.target !== 'self' && semantic.effectType !== 'buff';
}

function clearLoadedShot(attack, actor, magicSkill) {
    if (attack?.clearLoadedShot) attack.clearLoadedShot(actor, magicSkill);
    else if (magicSkill) actor.spiritshotLoaded = false;
    else actor.soulshotLoaded = false;
}

function refreshVitals(session, actor, target) {
    if (target?.statusUpdateVitals) {
        target.statusUpdateVitals(target);
    } else if (actor?.statusUpdateVitals) {
        actor.statusUpdateVitals(target);
    }

    if (target?.session && target.session !== session && target.session.actor?.statusUpdateVitals) {
        target.session.actor.statusUpdateVitals(target);
    }
}

function refreshEffects(session, target) {
    const packet = ServerResponse.abnormalStatusUpdate.fromActor(target);
    if (target?.session?.dataSendToMe) {
        target.session.dataSendToMe(packet);
    } else if (session?.dataSendToMe) {
        session.dataSendToMe(packet);
    }

    try {
        const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
        if (target?.session) PartyCompanionService.updateActorEffects(target.session);
    } catch (err) {
        utils.infoWarn('SkillEffects', 'party effect refresh failed: %s', err.message);
    }
}

module.exports = {
    execute
};
