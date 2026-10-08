'use strict';

const ItemIndex = require('../../Item/ItemTemplateIndex');
const actorBags = new WeakMap();

// These are C4 limits, not a desired stock or a reason to recover at low HP.
function inventoryLimit(race) { return Number(race) === 4 ? 100 : 80; }

function weightPenalty(load, maximum) {
    if (!(maximum > 0)) return 0;
    const share = load / maximum;
    return share >= 1 ? 4 : share >= 0.8 ? 3 : share >= 2 / 3 ? 2 : share >= 0.5 ? 1 : 0;
}

function evaluate({ dead = false, hp, mp, manaRequired = false, castCosts = [], slots = 0,
    slotLimit = 80, load = 0, maxLoad = 0 } = {}) {
    if (dead || (Number.isFinite(Number(hp)) && Number(hp) <= 0)) return { reason: 'dead', action: 'revive' };
    if (manaRequired && castCosts.length && !castCosts.some(cost => Number(cost) <= Number(mp))) {
        return { reason: 'no_mp', action: 'rest' };
    }
    const penalty = weightPenalty(load, maxLoad);
    if (slots >= slotLimit) return { reason: 'no_slot', action: 'unload', slots, limit: slotLimit, weightPenalty: penalty };
    if (penalty) return { reason: 'overweight', action: 'unload', load, maxLoad, weightPenalty: penalty };
    return null;
}

function stateInventory(state, items = []) {
    let slots = 0;
    let load = 0;
    for (const item of Object.values(state.inventory || {})) {
        const amount = Math.max(0, Number(item?.amount || 0));
        if (!amount) continue;
        const template = ItemIndex.find(items, Number(item.selfId));
        const stackable = item.stackable ?? template?.etc?.stackable;
        slots += Array.isArray(item.instances) ? item.instances.length : stackable === false ? amount : 1;
        load += amount * Math.max(0, Number(template?.template?.mass ?? item.mass ?? 0));
    }
    return { slots, load };
}

function stateCastCosts(state, profile, timestamp) {
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Rules = invoke('GameServer/Skills/C4SkillRules');
    return Profile.offensiveSkills(profile).filter(skill => {
        const semantic = Rules.resolveCached(skill);
        return Number(state.stats?.coldCombat?.cooldowns?.[skill.selfId] || 0) <= timestamp
            && Number(skill.hp || 0) < Number(state.vitals?.hp ?? profile.maxHp)
            && (!semantic.requires?.charges || Number(state.stats?.coldCombat?.charges || 0) >= Number(semantic.requires.charges));
    }).map(skill => {
        const stat = skill.spell ? 'magicalMpConsumeMul' : 'physicalMpConsumeMul';
        const equipment = skill.spell ? 'magicalMpConsumeRateMul' : 'physicalMpConsumeRateMul';
        return Math.max(0, Math.floor(Number(skill.mp || 0) * Profile.statMultiplier(profile, stat, timestamp)
            * Profile.statMultiplier(profile, equipment, timestamp) + 1e-9));
    });
}

function forState(state, timestamp = Date.now(), inputs = null) {
    if (!state) return null;
    if (state.activity === 'dead' || Number(state.vitals?.hp) <= 0) return { reason: 'dead', action: 'revive' };
    if (inputs || typeof invoke !== 'function') {
        return evaluate({ hp: state.vitals?.hp, mp: state.vitals?.mp, ...stateInventory(state, inputs?.items),
            slotLimit: inventoryLimit(inputs?.race ?? state.stats?.race), ...inputs });
    }
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Roles = invoke('GameServer/Bot/AI/BotRoles');
    const profile = Profile.profileFor(state, timestamp);
    return evaluate({ hp: state.vitals?.hp, mp: state.vitals?.mp ?? profile.maxMp,
        manaRequired: Roles.shouldRestForMana(state), castCosts: stateCastCosts(state, profile, timestamp),
        ...stateInventory(state, invoke('GameServer/DataCache').items), slotLimit: inventoryLimit(profile.race), maxLoad: profile.maxLoad });
}

function actorInventory(actor) {
    const backpack = actor.backpack;
    if (!backpack) return { slots: 0, load: 0 };
    const items = backpack.fetchItems?.() || [];
    const revision = Number(backpack.inventoryRevision || 0);
    const cached = actorBags.get(backpack);
    if (cached?.items === items && cached.count === items.length && cached.revision === revision) return cached;
    invoke('GameServer/Model/Item').bindInventory(backpack, items);
    const bag = { items, count: items.length, revision, slots: items.length, load: backpack.fetchTotalLoad?.() || 0 };
    actorBags.set(backpack, bag);
    return bag;
}

function bagMarks(actor) {
    const bag = actorInventory(actor);
    return { weight: weightPenalty(bag.load, actor.fetchMaxLoad?.() || 0),
        full: Number(bag.slots >= inventoryLimit(actor.fetchRace?.())) };
}

function forActor(actor) {
    if (!actor) return null;
    const Attack = invoke('GameServer/Actor/Attack');
    const Roles = invoke('GameServer/Bot/AI/BotRoles');
    const mask = Attack.weaponMaskFor(actor);
    const costs = (actor.skillset?.fetchSkills?.() || []).filter(skill => {
        const semantic = skill.fetchSemantic?.() || {};
        return !skill.fetchPassive?.() && semantic.target === 'enemy' && !semantic.notUsedInC4
            && (!semantic.requires?.weaponsAllowed || (Number(semantic.requires.weaponsAllowed) & mask) !== 0)
            && Number(semantic.requires?.charges || 0) <= Number(actor.fetchCharges?.() || 0)
            && (!actor.canUseSkill || actor.canUseSkill(skill))
            && Number(skill.fetchConsumedHp?.() || 0) < Number(actor.fetchHp?.());
    })
        .map(skill => Attack.prototype.skillMpCost(actor, skill));
    return evaluate({ dead: actor.isDead?.() === true, hp: actor.fetchHp?.(), mp: actor.fetchMp?.(),
        manaRequired: Roles.shouldRestForMana(actor), castCosts: costs,
        ...actorInventory(actor), slotLimit: inventoryLimit(actor.fetchRace?.()), maxLoad: actor.fetchMaxLoad?.() || 0 });
}

module.exports = { evaluate, forState, forActor, bagMarks, stateInventory, inventoryLimit, weightPenalty };
