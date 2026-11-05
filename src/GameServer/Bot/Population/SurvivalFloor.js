'use strict';

const ItemIndex = require('../../Item/ItemTemplateIndex');
const InventoryLimits = require('../../Inventory/InventoryLimits');
const ArrowStock = require('../../Inventory/ArrowStock');
const actorBags = new WeakMap();

// These are C4 limits, not a desired stock or a reason to recover at low HP.
const inventoryLimit = InventoryLimits.capacity;

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
    // One stat source list per call: every skill's two multipliers read it.
    let sources = null;
    const multiplier = stat => Profile.statMultiplier(profile, stat, timestamp,
        sources ||= Profile.fightSources(profile, timestamp).sources);
    return Profile.offensiveSkills(profile).filter(skill => {
        const semantic = Rules.resolveCached(skill);
        return Number(state.stats?.coldCombat?.cooldowns?.[skill.selfId] || 0) <= timestamp
            && Number(skill.hp || 0) < Number(state.vitals?.hp ?? profile.maxHp)
            && (!semantic.requires?.charges || Number(state.stats?.coldCombat?.charges || 0) >= Number(semantic.requires.charges));
    }).map(skill => {
        const stat = skill.spell ? 'magicalMpConsumeMul' : 'physicalMpConsumeMul';
        const equipment = skill.spell ? 'magicalMpConsumeRateMul' : 'physicalMpConsumeRateMul';
        return Math.max(0, Math.floor(Number(skill.mp || 0) * multiplier(stat) * multiplier(equipment) + 1e-9));
    });
}

// Weight penalty 1 is only the C4 walking-speed step. During the sale retry
// (ItemDisposition.saleRetryHolds: nothing new since the last visit) it waits
// like a half-full bag and the bot hunts on, spending its shots, instead of
// flying back to a town that bought nothing. Unused arrows the NPC
// sale takes (ItemDisposition.unusedArrowCandidates, the sale's own lines) do
// not wait; heavier steps and full bags stay the floor. bag: the state or the
// live actor; asState: that bag as a state for the sale, built only when arrows are held.
// holds: whether the retry holds, asked only at penalty 1 with a retry saved.
function saleRetryWaits(floor, state, timestamp, bag = state, asState = () => bag,
    holds = () => invoke('GameServer/Bot/Economy/ItemDisposition').saleRetryHolds({ ...asState(), stats: state.stats })) {
    return floor?.reason === 'overweight' && floor.weightPenalty === 1
        && state?.stats?.marketSellSeen && typeof invoke === 'function' && holds()
        && !(ArrowStock.unused(bag).length > 0
            && invoke('GameServer/Bot/Economy/ItemDisposition').unusedArrowCandidates(asState()).length > 0) ? null : floor;
}

function forState(state, timestamp = Date.now(), inputs = null) {
    if (!state) return null;
    if (state.activity === 'dead' || Number(state.vitals?.hp) <= 0) return { reason: 'dead', action: 'revive' };
    if (inputs || typeof invoke !== 'function') {
        return saleRetryWaits(evaluate({ hp: state.vitals?.hp, mp: state.vitals?.mp, ...stateInventory(state, inputs?.items),
            slotLimit: InventoryLimits.forState(state, inputs || {}), ...inputs }), state, timestamp);
    }
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const Roles = invoke('GameServer/Bot/AI/BotRoles');
    const profile = Profile.profileFor(state, timestamp);
    // evaluate reads the cast costs only for a role that rests for mana.
    const manaRequired = Roles.shouldRestForMana(state);
    return saleRetryWaits(evaluate({ hp: state.vitals?.hp, mp: state.vitals?.mp ?? profile.maxMp,
        manaRequired, castCosts: manaRequired ? stateCastCosts(state, profile, timestamp) : [],
        ...stateInventory(state, invoke('GameServer/DataCache').items),
        slotLimit: InventoryLimits.forState(state, profile), maxLoad: profile.maxLoad }), state, timestamp);
}

// The bag part of the floor alone (no slot, overweight; dead first, as in
// forState): what a sale trip answers, without the cast costs and the mana
// read forState pays. The author's thresholds, the same evaluate.
function bagFor(state, timestamp = Date.now()) {
    if (!state) return null;
    const Profile = invoke('GameServer/Bot/Population/ColdCombatProfile'); // lazy: worker as forState.
    const items = invoke('GameServer/DataCache').items; // lazy: worker as forState.
    const profile = Profile.profileFor(state, timestamp);
    const floor = evaluate({ dead: state.activity === 'dead', hp: state.vitals?.hp, ...stateInventory(state, items),
        slotLimit: InventoryLimits.forState(state, profile), maxLoad: profile.maxLoad });
    return saleRetryWaits(floor, state, timestamp);
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
        full: Number(bag.slots >= InventoryLimits.forActor(actor)) };
}

// A hot bag's sale retry, held while its bag and saved retry are the same
// (a buyer of its goods is read again at the next bag change, as sellTripDue).
const actorRetries = new WeakMap();
function actorRetryHolds(actor, state) {
    const bag = actorInventory(actor), seen = state?.stats?.marketSellSeen, held = actorRetries.get(actor.backpack);
    if (held?.items === bag.items && held.count === bag.count && held.revision === bag.revision && held.seen === seen) return held.holds;
    const holds = invoke('GameServer/Bot/Economy/ItemDisposition').saleRetryHolds({
        ...invoke('GameServer/Bot/Economy/MarketListingPolicy').actorState({ actor, coldLifeState: state }), stats: state.stats });
    actorRetries.set(actor.backpack, { items: bag.items, count: bag.count, revision: bag.revision, seen, holds });
    return holds;
}

// A hot solo hunter carries its life state in the session (`coldLifeState`),
// where the hot sale visit writes the same retry (HuntingState pauseSelling).
function forActor(actor, state = null, timestamp = Date.now()) {
    if (!actor) return null;
    // lazy: worker the cold worker loads this file (BackgroundResolver); forActor is hot only.
    const Attack = invoke('GameServer/Actor/Attack');
    const Roles = invoke('GameServer/Bot/AI/BotRoles'); // lazy: worker as Attack above.
    // evaluate reads the cast costs only for a role that rests for mana.
    const manaRequired = Roles.shouldRestForMana(actor);
    const mask = manaRequired ? Attack.weaponMaskFor(actor) : 0;
    const costs = !manaRequired ? [] : (actor.skillset?.fetchSkills?.() || []).filter(skill => {
        const semantic = skill.fetchSemantic?.() || {};
        return !skill.fetchPassive?.() && semantic.target === 'enemy' && !semantic.notUsedInC4
            && (!semantic.requires?.weaponsAllowed || (Number(semantic.requires.weaponsAllowed) & mask) !== 0)
            && Number(semantic.requires?.charges || 0) <= Number(actor.fetchCharges?.() || 0)
            && (!actor.canUseSkill || actor.canUseSkill(skill))
            && Number(skill.fetchConsumedHp?.() || 0) < Number(actor.fetchHp?.());
    })
        .map(skill => Attack.prototype.skillMpCost(actor, skill));
    return saleRetryWaits(evaluate({ dead: actor.isDead?.() === true, hp: actor.fetchHp?.(), mp: actor.fetchMp?.(),
        manaRequired, castCosts: costs,
        ...actorInventory(actor), slotLimit: InventoryLimits.forActor(actor), maxLoad: actor.fetchMaxLoad?.() || 0 }),
    state, timestamp, actor, () => invoke('GameServer/Bot/Economy/MarketListingPolicy').actorState({ actor, coldLifeState: state }),
    () => actorRetryHolds(actor, state));
}

module.exports = { evaluate, forState, bagFor, forActor, bagMarks, stateInventory, inventoryLimit, weightPenalty };
