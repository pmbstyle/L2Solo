'use strict';

const ItemTemplateIndex = require('../../Item/ItemTemplateIndex');
const InventorySummary = require('./InventorySummary');
const PickupCapacity = require('../../Inventory/PickupCapacity');
const DataCache = invoke('GameServer/DataCache');

// A far bot's loot in its bag, one rule for the round that picks it up (its running
// bag, BackgroundResolver.resolveSolo) and the step that keeps it (BotLifeState.prepareResolve).
// Both threads. Adena is the wallet's, not a stack here: the caller adds it.

function itemTemplate(selfId) {
    return ItemTemplateIndex.find(DataCache.items, selfId) || null;
}

function itemName(selfId, fallback = '') {
    return itemTemplate(selfId)?.template?.name || fallback || `Item ${selfId}`;
}

function itemStackable(selfId, item = {}) {
    const template = itemTemplate(selfId);
    if (template) return template.etc?.stackable === true;
    if (typeof item.fetchStackable === 'function') return !!item.fetchStackable();
    return item.stackable === true;
}

// C4 pickup (PickupCapacity.refusal, the rule a body near a player picks up by) on a far
// round's running bag, solo (BackgroundResolver.resolveSolo) and party
// (BackgroundPartyResolver): a drop past the bag's slots (limit, InventoryLimits.forState)
// or carrying load (maxLoad, the fight profile's) stays on the ground. Returns
// { kept, refused }: the drops picked up, in order, and how many stayed.
function keep(bag, loot, limit, maxLoad) {
    const counts = invoke('GameServer/Bot/Population/SurvivalFloor').stateInventory({ inventory: bag || {} }, DataCache.items);
    const kept = [];
    let refused = 0;
    for (const item of loot || []) {
        const drop = { stackable: itemStackable(item.selfId, item), amount: Number(item.amount || 0),
            mass: Math.max(0, Number(itemTemplate(item.selfId)?.template?.mass ?? item.mass ?? 0)) };
        const has = Number(bag?.[item.selfId]?.amount) > 0 || kept.some(other => Number(other.selfId) === Number(item.selfId));
        if (PickupCapacity.refusal({ ...counts, limit, maxLoad, held: has }, drop)) {
            refused += 1;
            continue;
        }
        counts.slots += drop.stackable ? Number(!has) : drop.amount;
        counts.load += drop.mass * drop.amount;
        kept.push(item);
    }
    return { kept, refused };
}

// The bag with the drops added (a new object; the stacks it changes are new too).
function addTo(bag, items) {
    const inventory = { ...(bag || {}) };
    for (const item of items || []) {
        if (Number(item.selfId) === 57) continue;
        const key = String(item.selfId);
        const previous = inventory[key] || {};
        const template = itemTemplate(item.selfId);
        const amount = Number(item.amount || 0);
        const kind = item.kind || previous.kind || template?.template?.kind || '';
        const protectedStarterLoot = Number(item.sourceMobLevel || 0) > 0
            && Number(item.sourceMobLevel) <= 5
            && !String(kind).startsWith('Other.Material')
            ? amount
            : 0;
        const nextAmount = Number(previous.amount || 0) + amount;
        const starterMobLootAmount = Math.min(
            nextAmount,
            Number(previous.starterMobLootAmount || 0) + protectedStarterLoot
        );
        // Loot adds to the stack the bag holds: its worn copies, instances and
        // reserves stay (a looted second dagger must not unequip the first).
        const acquired = {
            ...previous,
            selfId: item.selfId,
            name: item.name || previous.name || itemName(item.selfId),
            amount: nextAmount,
            kind,
            rank: item.rank || previous.rank || template?.etc?.rank || 'none',
            stackable: itemStackable(item.selfId, item),
            slot: Number(previous.slot || template?.etc?.slot || 0),
            ...(starterMobLootAmount > 0 ? { starterMobLootAmount } : {})
        };
        // Loot grows the bag without replacing its physical copies or worn
        // slots. New gear gets anonymous +0 copies until the native sync.
        if (acquired.stackable) delete acquired.instances;
        else acquired.instances = previous.instances || [];
        inventory[key] = InventorySummary.completeInstances(acquired);
    }
    return inventory;
}

module.exports = { addTo, keep, itemTemplate, itemName, itemStackable };
