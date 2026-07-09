const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const BuffCatalog = invoke('GameServer/Effects/BuffCatalog');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const Formulas = invoke('GameServer/Formulas');
const ServerResponse = invoke('GameServer/Network/Response');

const COND_BEHIND = 0x0008;
const COND_CRIT = 0x0010;

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
        mpRestore: 0,
        cpRestore: 0,
        spReward: 0,
        charges: null,
        aggroDamage: 0,
        aggroReduced: false,
        aggroReduction: 0,
        aggroRemoved: false,
        selfEffect: null,
        cancelled: []
    };

    if (semantic.skillType === C4SkillRules.SUMMON) {
        result.summon = applySummon(session, actor, target, skill, semantic, magicSkill, context.attack);
        result.rejected = !result.summon;
        return result;
    }

    if (semantic.skillType === C4SkillRules.SOULSHOT || semantic.skillType === C4SkillRules.SPIRITSHOT) {
        result.shotLoaded = applyShot(actor, semantic);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HEAL) {
        result.heal = applyHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HEAL_PERCENT) {
        result.heal = applyHealPercent(session, actor, target, skill, semantic, magicSkill, context.attack);
        if (semantic.manaHealPercent) {
            result.mpRestore = applyManaHealPercent(session, actor, target, skill, semantic, magicSkill, context.attack);
        }
        return result;
    }

    if (semantic.skillType === C4SkillRules.HEAL_STATIC) {
        result.heal = applyHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HEAL_HOT) {
        result.heal = applyHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        result.effect = applyEffect(session, target, skill, semantic, actor);
        return result;
    }

    if (semantic.skillType === C4SkillRules.HOT) {
        result.effect = applyEffect(session, target, skill, semantic, actor);
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.MANA_HOT) {
        result.effect = applyEffect(session, target, skill, semantic, actor);
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

    if (semantic.skillType === C4SkillRules.MANA_HEAL) {
        result.mpRestore = applyManaHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.COMBAT_POINT_HEAL) {
        result.cpRestore = applyCombatPointHeal(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.GIVE_SP) {
        result.spReward = applyGiveSp(session, actor, target, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.CHARGE) {
        result.charges = applyCharge(session, actor, skill, semantic, magicSkill, context.attack);
        return result;
    }

    if (semantic.skillType === C4SkillRules.DRAIN_SOUL) {
        result.absorbedSoul = applyDrainSoul(actor, target);
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
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

    if (semantic.mobOnly && !isAttackableNpc(target)) {
        clearLoadedShot(context.attack, actor, magicSkill);
        result.effectResisted = true;
        return result;
    }

    if (semantic.undeadOnly && !isUndead(target)) {
        clearLoadedShot(context.attack, actor, magicSkill);
        result.effectResisted = true;
        return result;
    }

    if (semantic.skillType === C4SkillRules.AGGRO_REMOVE) {
        if (resistEffect(actor, target, skill, semantic, magicSkill, rng)) {
            result.effectResisted = true;
        } else {
            result.aggroRemoved = true;
        }
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.AGGRO_DAMAGE) {
        result.aggroDamage = calcAggroDamage(skill, target);
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.AGGRO_REDUCE) {
        result.aggroReduced = true;
        result.aggroReduction = Math.max(0, Number(skill.fetchPower?.()) || 0);
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.AGGRO_REDUCE_CHAR) {
        if (resistEffect(actor, target, skill, semantic, magicSkill, rng)) {
            result.effectResisted = true;
        } else {
            result.aggroReduced = true;
        }
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.CANCEL) {
        if (resistEffect(actor, target, skill, semantic, magicSkill, rng)) {
            result.effectResisted = true;
        } else {
            result.cancelled = applyCancel(session, target, semantic, rng);
        }
        clearLoadedShot(context.attack || actor.attack, actor, magicSkill);
        return result;
    }

    if (semantic.skillType === C4SkillRules.DRAIN) {
        const drain = applyDrain(session, actor, target, skill, semantic, magicSkill, context.attack, rng);
        result.damage = drain.damage;
        result.heal = drain.heal;
        return result;
    }

    if (semantic.skillType === C4SkillRules.DAMAGE || semantic.skillType === C4SkillRules.DAMAGE_EFFECT || semantic.skillType === C4SkillRules.DEATH_LINK) {
        result.damage = context.attack.prepareSkillDamage(actor, target, skill, magicSkill, rng);
    }

    if (semantic.skillType === C4SkillRules.EFFECT || semantic.skillType === C4SkillRules.DAMAGE_EFFECT) {
        const resisted = isOffensive(semantic) && resistEffect(actor, target, skill, semantic, magicSkill, rng);
        if (resisted) {
            result.effectResisted = true;
        } else {
            result.effect = applyEffect(session, target, skill, semantic, actor);
        }
    }

    if (semantic.selfEffect) {
        result.selfEffect = applyEffect(session, actor, skill, {
            ...semantic,
            ...semantic.selfEffect,
            stats: semantic.selfEffect.stats || {}
        }, actor);
    }

    return result;
}

function applyHeal(session, actor, target, skill, semantic, magicSkill, attack) {
    const usedSpiritshot = !!actor.spiritshotLoaded;
    const usedBlessedSpiritshot = usedSpiritshot && !!actor.blessedSpiritshotLoaded;
    const amount = Math.round(Formulas.calcHealAmount(
        semantic.healPower ?? skill.fetchPower(),
        {
            spiritshot: usedSpiritshot && skill.fetchSsBoost() > 0,
            blessedSpiritshot: usedBlessedSpiritshot && skill.fetchSsBoost() > 0
        }
    ));

    const maxHp = Number(target.fetchMaxHp?.()) || 0;
    const currentHp = Number(target.fetchHp?.()) || 0;
    const nextHp = maxHp > 0 ? Math.min(maxHp, currentHp + amount) : currentHp + amount;
    target.setHp(nextHp);
    refreshVitals(session, actor, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return Math.max(0, nextHp - currentHp);
}

function applyShot(actor, semantic) {
    if (semantic.skillType === C4SkillRules.SOULSHOT) {
        actor.soulshotLoaded = true;
        return 'soulshot';
    }

    actor.spiritshotLoaded = true;
    actor.blessedSpiritshotLoaded = !!semantic.blessedSpiritshot;
    return actor.blessedSpiritshotLoaded ? 'blessedSpiritshot' : 'spiritshot';
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

function applyManaHeal(session, actor, target, skill, semantic, magicSkill, attack) {
    const amount = Math.round(Number(semantic.manaPower ?? skill.fetchPower()) || 0);
    const maxMp = Number(target.fetchMaxMp?.()) || 0;
    const currentMp = Number(target.fetchMp?.()) || 0;
    const nextMp = maxMp > 0 ? Math.min(maxMp, currentMp + amount) : currentMp + amount;
    target.setMp(nextMp);
    refreshVitals(session, actor, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return Math.max(0, nextMp - currentMp);
}

function applyManaHealPercent(session, actor, target, skill, semantic, magicSkill, attack) {
    const power = Number(semantic.manaHealPercent) || 0;
    const maxMp = Number(target.fetchMaxMp?.()) || 0;
    const currentMp = Number(target.fetchMp?.()) || 0;
    const amount = Math.round(maxMp * power / 100);
    const nextMp = maxMp > 0 ? Math.min(maxMp, currentMp + amount) : currentMp + amount;
    target.setMp(nextMp);
    refreshVitals(session, actor, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return Math.max(0, nextMp - currentMp);
}

function applyCombatPointHeal(session, actor, target, skill, semantic, magicSkill, attack) {
    const amount = Math.round(Number(skill.fetchPower?.()) || 0);
    const maxCp = Number(target.fetchMaxCp?.()) || 0;
    const currentCp = Number(target.fetchCp?.()) || 0;
    const nextCp = maxCp > 0 ? Math.min(maxCp, currentCp + amount) : currentCp + amount;
    if (typeof target.setCp === 'function') {
        target.setCp(nextCp);
    }
    refreshCp(session, actor, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return Math.max(0, nextCp - currentCp);
}

function applyGiveSp(session, actor, target, skill, semantic, magicSkill, attack) {
    const amount = Math.round(Number(skill.fetchPower?.()) || 0);
    const currentSp = Number(target.fetchSp?.()) || 0;
    if (typeof target.setSp === 'function') {
        target.setSp(currentSp + amount);
    }
    refreshUserInfo(session, target);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return amount;
}

function applyCharge(session, actor, skill, semantic, magicSkill, attack) {
    const maxCharges = Math.max(0, Number(semantic.maxCharges ?? skill.fetchPower?.()) || 0);
    const current = Math.max(0, Number(actor.fetchCharges?.() ?? actor.charges ?? 0) || 0);
    const next = maxCharges > 0 ? Math.min(maxCharges, current + 1) : current + 1;
    if (typeof actor.setCharges === 'function') {
        actor.setCharges(next);
    } else {
        actor.charges = next;
    }
    refreshEtcStatus(session, actor);
    clearLoadedShot(attack || actor.attack, actor, magicSkill);
    return next;
}

function applyDrainSoul(actor, target) {
    if (target?.fetchAttackable?.() !== true) return false;
    if (target?.isDead?.() || target?.state?.fetchDead?.() === true) return false;

    if (typeof target.addAbsorber === 'function') {
        target.addAbsorber(actor);
        return true;
    }

    return false;
}

function applySummon(session, actor, target, skill, semantic, magicSkill, attack) {
    const failure = validateSummonUse(actor, target, skill);
    if (failure) {
        clearLoadedShot(attack || actor.attack, actor, magicSkill);
        return null;
    }

    return consumeSkillItems(session, actor, skill, () => {
        const npcData = fetchSummonNpcData(skill);
        if (!npcData) return null;

        const Npc = invoke('GameServer/Npc/Npc');
        const World = invoke('GameServer/World/World');
        const coords = fetchSummonCoords(actor, target, skill);
        const npc = new Npc(World.npc.nextId++, {
            ...utils.crushOb(npcData),
            ...coords,
            title: actor.fetchName?.() || '',
            ownerId: actor.fetchId?.() || 0,
            ownerName: actor.fetchName?.() || '',
            summonSkillId: skill.fetchSelfId?.() || 0,
            summonLifeTime: skill.fetchSummonTotalLifeTime?.() || 0,
            isSummon: true
        });

        World.npc.spawns.push(npc);
        World.indexSpawnsInGrid?.();

        actor.summon = npc;
        session.summon = npc;

        session.dataSendToMeAndOthers?.(ServerResponse.npcInfo(npc), npc);
        const SummonControl = invoke('GameServer/Npc/SummonControl');
        SummonControl.startFollowOwner(session, actor, npc);
        clearLoadedShot(attack || actor.attack, actor, magicSkill);
        return npc;
    });
}

function validateSummonUse(actor, target, skill) {
    if (skill.fetchSkillType?.() !== C4SkillRules.SUMMON) {
        return null;
    }

    if (skill.fetchSummonIsCubic?.()) {
        return 'Cubic summon runtime is not implemented yet.';
    }

    const npcId = Number(skill.fetchSummonNpcId?.()) || 0;
    if (!npcId || !fetchSummonNpcData(skill)) {
        return 'Summon template is missing.';
    }

    const activeSummon = actor?.summon || actor?.pet;
    if (activeSummon && activeSummon.state?.fetchDead?.() !== true && activeSummon.isDead?.() !== true) {
        return 'You already have a servitor.';
    }

    if (!hasRequiredSkillItems(actor, skill)) {
        return 'Not enough required items.';
    }

    return null;
}

function fetchSummonNpcData(skill) {
    const npcId = Number(skill.fetchSummonNpcId?.()) || 0;
    if (!npcId) return null;

    const DataCache = invoke('GameServer/DataCache');
    const npcData = DataCache.npcs?.find((npc) => Number(npc.selfId) === npcId);
    if (npcData) {
        return structuredClone(npcData);
    }

    const fallback = fetchSummonNpcFallback(DataCache, skill);
    if (!fallback) {
        return null;
    }

    const cloned = structuredClone(fallback);
    cloned.selfId = npcId;
    cloned.template.name = summonDisplayName(skill, cloned.template.name);
    return cloned;
}

function fetchSummonNpcFallback(DataCache, skill) {
    const skillData = DataCache.skills?.find((entry) => Number(entry.selfId) === Number(skill.fetchSelfId?.()));
    const currentLevel = Number(skill.fetchLevel?.()) || 1;
    const levelCandidates = (skillData?.levels || [])
        .map((level) => ({
            level: Number(level.level) || 0,
            npc: DataCache.npcs?.find((npc) => Number(npc.selfId) === Number(level.npcId))
        }))
        .filter((entry) => entry.npc)
        .sort((a, b) => Math.abs(a.level - currentLevel) - Math.abs(b.level - currentLevel));

    if (levelCandidates.length > 0) {
        return levelCandidates[0].npc;
    }

    const name = String(skill.fetchName?.() || '').toLowerCase();
    const fallbackIds = summonFamilyFallbackIds(name);
    return fallbackIds
        .map((id) => DataCache.npcs?.find((npc) => Number(npc.selfId) === id))
        .find(Boolean) || null;
}

function summonFamilyFallbackIds(name) {
    if (name.includes('panther')) return [12184, 12183, 12182, 12181];
    if (name.includes('unicorn') || name.includes('seraphim')) return [12064, 12357, 12065, 12358];
    if (name.includes('nightshade') || name.includes('shadow') || name.includes('silhouette')) return [12070, 12366, 12071, 12367];
    if (name.includes('cat') || name.includes('mew') || name.includes('kat')) return [12006, 12348, 12007, 12349];
    if (name.includes('golem')) return [12021, 22421];
    return [];
}

function summonDisplayName(skill, fallbackName) {
    const skillName = String(skill.fetchName?.() || '').replace(/^Summon\s+/i, '').trim();
    return skillName || fallbackName;
}

function hasRequiredSkillItems(actor, skill) {
    const itemId = Number(skill.fetchItemConsumeId?.()) || 0;
    const count = Number(skill.fetchItemConsumeCount?.()) || 0;
    if (!itemId || count <= 0) return true;

    const item = actor?.backpack?.fetchItemFromSelfId?.(itemId);
    return (Number(item?.fetchAmount?.()) || 0) >= count;
}

function consumeSkillItems(session, actor, skill, callback) {
    const itemId = Number(skill.fetchItemConsumeId?.()) || 0;
    const count = Number(skill.fetchItemConsumeCount?.()) || 0;
    if (!itemId || count <= 0) {
        return callback();
    }

    const item = actor?.backpack?.fetchItemFromSelfId?.(itemId);
    if (!item || (Number(item.fetchAmount?.()) || 0) < count) {
        return null;
    }

    let result = null;
    actor.backpack.deleteItem(session, item.fetchId(), count, () => {
        result = callback();
    });
    return result;
}

function fetchSummonCoords(actor, target, skill) {
    const anchor = skill.fetchTargetKind?.() === 'corpse_mob' && target ? target : actor;
    const head = Number(actor.fetchHead?.()) || 0;
    const angle = (head / 65535) * Math.PI * 2;
    const distance = Math.max(40, Number(actor.fetchRadius?.()) || 0);

    return {
        locX: Math.round((Number(anchor.fetchLocX?.()) || 0) + Math.cos(angle) * distance),
        locY: Math.round((Number(anchor.fetchLocY?.()) || 0) + Math.sin(angle) * distance),
        locZ: Number(anchor.fetchLocZ?.()) || 0,
        head
    };
}

function applyDrain(session, actor, target, skill, semantic, magicSkill, attack, rng) {
    let damage = 0;

    if (semantic.target === 'corpse_mob') {
        clearLoadedShot(attack || actor.attack, actor, magicSkill);
    } else {
        damage = attack.prepareSkillDamage(actor, target, skill, magicSkill, rng);
    }

    const amount = Formulas.calcDrainHeal({
        damage,
        targetHp: target.fetchHp?.(),
        absorbPart: semantic.absorbPart,
        absorbAbs: semantic.absorbAbs
    });
    const maxHp = Number(actor.fetchMaxHp?.()) || 0;
    const currentHp = Number(actor.fetchHp?.()) || 0;
    const nextHp = maxHp > 0 ? Math.min(maxHp, currentHp + amount) : currentHp + amount;
    actor.setHp(nextHp);
    refreshVitals(session, actor, actor);
    return { damage, heal: Math.max(0, nextHp - currentHp) };
}

function applyEffect(session, target, skill, semantic, source = session?.actor) {
    const durationMs = Number(skill.fetchBuffTime()) || 0;
    if (!durationMs || !semantic.effect) return null;

    const effect = EffectStore.apply(target, {
        key: semantic.effect,
        id: skill.fetchSelfId(),
        level: skill.fetchLevel(),
        name: skill.fetchName(),
        type: semantic.effectType || 'buff',
        category: semantic.effectTrait || semantic.trait || semantic.effect,
        dispellable: semantic.dispellable,
        stats: semantic.stats || {},
        dot: dotFromSkill(skill, semantic),
        manaDot: manaDotFromSkill(skill, semantic),
        manaHot: manaHotFromSkill(skill, semantic),
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

    if (effect?.manaDot) {
        EffectTicker.applyManaDot(session, session?.actor, target, effect);
    }

    if (effect?.manaHot) {
        EffectTicker.applyManaHot(session, session?.actor, target, effect);
    }

    if (effect?.hot) {
        EffectTicker.applyHot(session, session?.actor, target, effect);
    }

    EffectTicker.scheduleExpiry(session, target, effect);
    EffectRestrictions.interruptOnApply(target?.session || session, target, effect, source);
    refreshEffects(session, target);
    return effect;
}

function applyCleanse(session, target, semantic) {
    const removed = [];
    (semantic.cleanse || []).forEach((entry) => {
        if (entry.skillId) {
            removed.push(...EffectStore.removeBySkillId(target, entry.skillId, entry.maxLevel ?? Infinity));
            return;
        }
        removed.push(...EffectStore.removeByCategory(target, entry.category, entry.maxLevel ?? Infinity));
    });
    if (removed.length) {
        refreshEffects(session, target);
    }
    return removed;
}

function applyCancel(session, target, semantic, rng) {
    const removed = [];
    const maxToRemove = Number(semantic.maxCancelled) || 0;
    EffectStore.list(target, { includeBuffs: true, includeDebuffs: false }).forEach((effect) => {
        if (effect.dispellable === false) return;
        if (maxToRemove > 0 && removed.length >= maxToRemove) return;

        const rate = Math.max(25, Math.min(75, 150 / (1 + (Number(effect.level) || 1))));
        if (rng() * 100 < rate && EffectStore.remove(target, effect.key)) {
            removed.push(effect);
        }
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

function manaDotFromSkill(skill, semantic) {
    if (!semantic.manaDot) return null;
    return {
        count: semantic.manaDot.count,
        intervalMs: semantic.manaDot.intervalMs,
        damage: semantic.manaDot.damage ?? damageByLevel(skill, semantic.manaDot) ?? skill.fetchPower()
    };
}

function manaHotFromSkill(skill, semantic) {
    if (!semantic.manaHot) return null;
    return {
        count: semantic.manaHot.count,
        intervalMs: semantic.manaHot.intervalMs,
        heal: semantic.manaHot.heal ?? skill.fetchPower()
    };
}

function damageByLevel(skill, dot) {
    if (!dot.damageByLevel) return null;
    const values = dot.damageByLevel;
    const index = Math.max(0, Math.min(values.length - 1, (Number(skill.fetchLevel()) || 1) - 1));
    return values[index];
}

function calcAggroDamage(skill, target) {
    const power = Math.max(0, Number(skill.fetchPower?.()) || 0);
    const level = Math.max(1, Number(target.fetchLevel?.()) || 1);
    return Math.floor((150 * power) / (level + 7));
}

function rollBlow(actor, target, semantic, attack, rng) {
    const condition = Number(semantic.requires?.condition) || 0;
    if ((condition & COND_BEHIND) !== 0 && !attack?.isBehindTarget?.(actor, target)) {
        return false;
    }

    if (condition !== 0 && (condition & COND_CRIT) === 0) {
        return true;
    }

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
        resistModifier: traitResistModifier(target, semantic.effectTrait || semantic.trait)
    });
    return !(chance >= rng() * 100);
}

const RESIST_STAT_BY_TRAIT = {
    shock: 'stunResist'
};

function traitResistModifier(target, trait) {
    const stat = RESIST_STAT_BY_TRAIT[trait] || `${trait}Resist`;
    const resist = EffectStats.add(target, stat);
    const vulnerability = EffectStats.multiplier(target, `${trait}Vuln`, 1);
    return Math.max(0, 1 - (resist / 100)) * Math.max(0, vulnerability);
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

function isAttackableNpc(target) {
    return target?.fetchAttackable?.() === true;
}

function isUndead(target) {
    return target?.fetchUndead?.() === true;
}

function clearLoadedShot(attack, actor, magicSkill) {
    if (attack?.clearLoadedShot) attack.clearLoadedShot(actor, magicSkill);
    else if (magicSkill) {
        actor.spiritshotLoaded = false;
        actor.blessedSpiritshotLoaded = false;
    }
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

function refreshCp(session, actor, target) {
    const packet = ServerResponse.statusUpdate(target.fetchId(), [
        { id: 0x21, value: Math.round(Number(target.fetchCp?.()) || 0) }
    ]);
    if (target?.session?.dataSendToMe) {
        target.session.dataSendToMe(packet);
    } else if (target === session?.actor && session?.dataSendToMe) {
        session.dataSendToMe(packet);
    } else if (actor?.statusUpdateVitals) {
        actor.statusUpdateVitals(target);
    }
}

function refreshUserInfo(session, target) {
    const packet = ServerResponse.userInfo(target);
    if (target?.session?.dataSendToMe) {
        target.session.dataSendToMe(packet);
    } else if (target === session?.actor && session?.dataSendToMe) {
        session.dataSendToMe(packet);
    }
}

function refreshEtcStatus(session, actor) {
    const packet = ServerResponse.etcStatusUpdate(actor);
    if (actor?.session?.dataSendToMe) {
        actor.session.dataSendToMe(packet);
    } else if (actor === session?.actor && session?.dataSendToMe) {
        session.dataSendToMe(packet);
    }
}

function refreshEffects(session, target) {
    const packet = ServerResponse.abnormalStatusUpdate.fromActor(target);
    if (target?.session?.dataSendToMe) {
        target.session.dataSendToMe(packet);
    } else if (target === session?.actor && session?.dataSendToMe) {
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
    execute,
    validateSummonUse,
    hasRequiredSkillItems
};
