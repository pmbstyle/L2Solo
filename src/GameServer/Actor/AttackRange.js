const DataCache = invoke('GameServer/DataCache');
const EffectStats = invoke('GameServer/Effects/EffectStats');

const BOW_ATTACK_RANGE = 700;
const MELEE_ATTACK_RANGE = 40;
const POLEARM_ATTACK_RANGE = 66;

function equippedWeapon(actor) {
    return actor?.backpack?.fetchEquippedWeapon?.() || null;
}

function cachedWeapon(actor) {
    if (!actor?.fetchWeapon || !Array.isArray(DataCache.items)) {
        return null;
    }

    const selfId = Number(actor.fetchWeapon());
    return DataCache.items.find((item) => Number(item.selfId) === selfId) || null;
}

function weaponKind(actor, weapon = equippedWeapon(actor) || cachedWeapon(actor)) {
    return weapon?.fetchKind?.()
        || weapon?.model?.kind
        || weapon?.template?.kind
        || actor?.backpack?.fetchTotalWeaponKind?.()
        || '';
}

function itemAttackRange(weapon) {
    const range = weapon?.fetchAttackRange?.()
        ?? weapon?.model?.attackRange
        ?? weapon?.model?.pAtkRange
        ?? weapon?.stats?.attackRange
        ?? weapon?.stats?.pAtkRange
        ?? weapon?.attackRange
        ?? weapon?.pAtkRange;
    const normalized = Number(range);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function fetchNormalAttackRange(actor, data = {}) {
    const requestedRange = Math.max(0, Number(data.range) || 0);
    if (requestedRange > 0) {
        return requestedRange;
    }

    const weapon = equippedWeapon(actor) || cachedWeapon(actor);
    const explicitWeaponRange = itemAttackRange(weapon);
    if (explicitWeaponRange > 0) {
        return explicitWeaponRange;
    }

    const kind = weaponKind(actor, weapon);
    if (kind === 'Weapon.Bow') {
        return BOW_ATTACK_RANGE + EffectStats.add(actor, 'pAtkRangeAdd');
    }

    if (kind === 'Weapon.Pole') {
        return POLEARM_ATTACK_RANGE;
    }

    return kind ? MELEE_ATTACK_RANGE : 0;
}

function collisionRadius(creature) {
    const radius = creature?.fetchRadius?.()
        ?? creature?.model?.radius
        ?? creature?.collision?.radius
        ?? 0;
    const normalized = Number(radius);
    return Number.isFinite(normalized) && normalized > 0 ? normalized : 0;
}

function distance2d(source, target) {
    const dx = (Number(target?.fetchLocX?.()) || 0) - (Number(source?.fetchLocX?.()) || 0);
    const dy = (Number(target?.fetchLocY?.()) || 0) - (Number(source?.fetchLocY?.()) || 0);
    return Math.sqrt((dx ** 2) + (dy ** 2));
}

function effectiveRange(source, target, attackRange) {
    return Math.max(0, Number(attackRange) || 0)
        + collisionRadius(source)
        + collisionRadius(target);
}

function isWithinRange(source, target, attackRange) {
    return distance2d(source, target) <= effectiveRange(source, target, attackRange);
}

function maxKnownTargetRadius() {
    if (!Array.isArray(DataCache.npcs)) {
        return 0;
    }

    return DataCache.npcs.reduce((max, npc) => Math.max(max, collisionRadius(npc)), 0);
}

function targetQueryRadius(source, attackRange) {
    return Math.max(0, Number(attackRange) || 0)
        + collisionRadius(source)
        + maxKnownTargetRadius();
}

module.exports = {
    BOW_ATTACK_RANGE,
    MELEE_ATTACK_RANGE,
    POLEARM_ATTACK_RANGE,
    collisionRadius,
    effectiveRange,
    fetchNormalAttackRange,
    isWithinRange,
    targetQueryRadius,
    weaponKind,
};
