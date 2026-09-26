// Ordinary C4 weapon SA and enchanted duals. Hero weapons have a separate ruleset.
const catalog = require('../../../data/Items/weapon_sa.json');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const SkillModel = invoke('GameServer/Model/Skill');

// Corrections to incomplete Lisvus entries; sources and compatibility policy in data/Items/WEAPON_SA.md.
const HP_DRAIN = new Set([6584, 6591, 6598]);
const CRITICAL_DRAIN = { 4694: 9, 4789: 6, 4795: 10, 4804: 14, 4807: 16, 5604: 19, 5646: 11, 6308: 9 };

function definition(item) {
    return catalog.weapons[Number(item?.fetchSelfId?.())] || null;
}
function equipped(actor) {
    return actor?.backpack?.fetchEquippedWeapon?.()
        || actor?.backpack?.fetchItems?.().find(item => item.fetchEquipped?.() && definition(item)) || null;
}
function effect(item, baseStats = {}, baseConditions = []) {
    const data = definition(item);
    if (!data) return null;
    // Inline item values override duplicate item_skill values, never stack twice.
    const stats = { ...baseStats, ...data.stats };
    const itemId = Number(item.fetchSelfId());
    if (HP_DRAIN.has(itemId)) stats.absorbDam = 3;
    const uniqueConditions = new Map();
    for (const entry of [...baseConditions, ...data.conditionalStats]) {
        const key = JSON.stringify(entry.condition);
        const previous = uniqueConditions.get(key);
        uniqueConditions.set(key, { condition: entry.condition, stats: { ...previous?.stats, ...entry.stats } });
    }
    const conditions = [...uniqueConditions.values()].filter(entry => {
        return Number(item.fetchEnchantLevel?.() || 0) >= Number(entry.condition.minEnchantLevel || 0);
    }).map(entry => ({ condition: entry.condition, stats: { ...entry.stats } }));
    return {
        key: `equipment_item_skill:${item.fetchId?.() || itemId}:sa`, id: data.passive?.skillId || itemId,
        level: data.passive?.level || 1, type: 'item_passive', name: data.name,
        category: 'equipment_item_skill', dispellable: false, stats, conditionalStats: conditions
    };
}
function hasRisk(actor) {
    const data = definition(equipped(actor));
    return !!data && /Rsk\./.test(data.name);
}
function bowMpCost(weapon, rng = Math.random) {
    const normal = Math.max(0, Number(weapon?.fetchConsumedMp?.()) || 0);
    const cheap = definition(weapon)?.cheapShot;
    return cheap && rng() * 100 < cheap.chance ? Math.min(normal, cheap.mp) : normal;
}
function soulshotCost(weapon, rng = Math.random) {
    const normal = Math.max(0, Number(weapon?.fetchSoulshot?.()) || 0);
    const miser = definition(weapon)?.miser;
    return miser && rng() * 100 < miser.chance ? Math.min(normal, miser.count) : normal;
}
function attackAngle(actor) { return definition(equipped(actor))?.attackAngle || 120; }
function pvpMultiplier(actor, target, kind) {
    // Match the combat dispatcher: player/bot actors, never NPCs or raid bosses.
    if (!(Number(actor?.fetchId?.()) >= 2000000 && Number(target?.fetchId?.()) >= 2000000)) return 1;
    return EffectStats.multiplier(actor, kind === 'magic' ? 'pvpMagicalDmg' : kind === 'skill' ? 'pvpPhysSkillsDmg' : 'pvpPhysDmg');
}
function criticalAnger(actor, weapon = equipped(actor)) {
    return Number(weapon?.fetchSelfId?.()) === 4681 && Number(actor?.fetchHp?.()) > 12 ? 248 : 0;
}
function recoverHp(actor, amount) {
    const hp = Number(actor.fetchHp?.()) || 0;
    if (hp <= 0 || actor.state?.fetchDead?.()) return 0;
    const healed = Math.max(0, Math.min(amount, Number(actor.fetchMaxHp?.()) - hp));
    if (healed > 0) {
        actor.setHp(hp + healed);
        actor.statusUpdateVitals?.(actor);
    }
    return healed;
}
function procSkill(descriptor) {
    const raw = catalog.procs[`${descriptor.skillId}-${descriptor.level}`];
    if (!raw) return null;
    const skill = new SkillModel({ ...raw });
    skill.semantic = { ...skill.fetchSemantic(), ...raw.semantic };
    if ([3075, 3079].includes(descriptor.skillId)) {
        // Missing in both available C4 datapacks: bounded compatibility duration.
        Object.assign(skill.semantic, { skillType: 'effect', effect: 'paralyze', effectType: 'debuff',
            target: 'enemy', trait: 'paralyze', durationMs: 15000, stackFamily: 'paralyze', stackOrder: 1 });
    }
    return skill;
}
function runProc(session, actor, target, descriptor, attack, rng) {
    if (actor?.fetchHp?.() <= 0 || actor?.state?.fetchDead?.()) return null;
    if (!descriptor || target?.state?.fetchDead?.() || target?.isDead?.() || target?.fetchHp?.() <= 0) return null;
    if (rng() * 100 >= descriptor.chance) return null;
    const skill = procSkill(descriptor);
    if (!skill) return null;
    // Procs have no extra MP/item/reuse cost and must not inherit or consume the cast's shots.
    const shots = [actor.soulshotLoaded, actor.spiritshotLoaded, actor.blessedSpiritshotLoaded];
    actor.soulshotLoaded = actor.spiritshotLoaded = actor.blessedSpiritshotLoaded = false;
    try {
        const result = invoke('GameServer/Skills/C4SkillEffects').execute(session, actor, target, skill, { attack, rng, magicSkill: skill.fetchSpell() });
        if (result.damage > 0) attack.hit(session, actor, target, result.damage, { skill });
        return result;
    } finally {
        [actor.soulshotLoaded, actor.spiritshotLoaded, actor.blessedSpiritshotLoaded] = shots;
    }
}
function onCritical(session, actor, target, { weapon = equipped(actor), damage = 0, hpDamage = damage, anger = false, attack, rng = Math.random } = {}) {
    if (!weapon || weapon !== equipped(actor) || damage <= 0 || actor.fetchHp?.() <= 0 || actor.state?.fetchDead?.()) return null;
    const id = Number(weapon.fetchSelfId());
    if (anger && id === 4681) {
        actor.setHp?.(Math.max(1, actor.fetchHp() - 12));
        actor.statusUpdateVitals?.(actor);
    }
    if (HP_DRAIN.has(id)) return null; // Continuous melee drain, not a critical proc.
    if (CRITICAL_DRAIN[id]) return { heal: recoverHp(actor, Math.min(hpDamage, CRITICAL_DRAIN[id])) };
    return runProc(session, actor, target, definition(weapon)?.oncrit, attack, rng);
}
function onCast(session, actor, target, trigger, { weapon = equipped(actor), outcome = {}, attack, rng = Math.random } = {}) {
    if (!weapon || weapon !== equipped(actor) || !trigger?.fetchSpell?.() || actor.fetchHp?.() <= 0 || actor.state?.fetchDead?.()) return null;
    const semantic = trigger.fetchSemantic?.() || {};
    if (semantic.operateType === 'toggle' || semantic.toggle || semantic.itemSkill || outcome.rejected) return null;
    const offensive = trigger.fetchTargetKind?.() === 'enemy' || semantic.target === 'enemy';
    if (Number(weapon.fetchSelfId()) === 5606 && offensive) {
        if (target?.fetchHp?.() <= 0 || target?.state?.fetchDead?.() || rng() >= 0.3) return null;
        const damage = Math.round(invoke('GameServer/Formulas').calcMagicDamage(actor.fetchCollectiveMAtk(), 8, target.fetchCollectiveMDef(), {}) * pvpMultiplier(actor, target, 'magic'));
        attack.hit(session, actor, target, damage, { skill: trigger });
        return { damage };
    }
    const descriptor = definition(weapon)?.oncast;
    if (!descriptor) return null;
    const skill = procSkill(descriptor);
    if (!skill || (skill.fetchSemantic().effectType !== 'buff') !== offensive) return null;
    return runProc(session, actor, target, descriptor, attack, rng);
}

module.exports = { catalog, definition, equipped, effect, hasRisk, bowMpCost, soulshotCost, attackAngle,
    pvpMultiplier, criticalAnger, recoverHp, procSkill, onCritical, onCast };
