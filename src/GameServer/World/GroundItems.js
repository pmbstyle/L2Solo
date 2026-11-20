'use strict';

// Ground items of the world (`World.items`): the spawns list, and the items a
// party drop was made for, by its leader's id (NpcRewards `partyLootLeaderId`),
// so a party's loot scan reads its own drops instead of every item on the
// ground. `put` (SpawnItem) and `take` (PickupItem) are the only writers; a
// drop's leader is fixed when it spawns.
const NONE = new Set();

function leaderOf(item) {
    return Number(item?.model?.partyLootLeaderId ?? item?.partyLootLeaderId ?? 0);
}

function ownerOf(item) {
    return item?.model?.partyLootGroupKey || item?.partyLootGroupKey || leaderOf(item);
}

function put(items, item) {
    items.spawns.push(item);
    const leaderId = ownerOf(item);
    if (!leaderId || typeof leaderId === 'number' && leaderId <= 0) return item;
    items.byLeader ??= new Map();
    const owned = items.byLeader.get(leaderId) ?? new Set();
    owned.add(item);
    items.byLeader.set(leaderId, owned);
    return item;
}

// Removes the spawn at `index` and returns it.
function take(items, index) {
    const [item] = items.spawns.splice(index, 1);
    const leaderId = ownerOf(item);
    const owned = items.byLeader?.get(leaderId);
    if (owned?.delete(item) && owned.size === 0) items.byLeader.delete(leaderId);
    return item;
}

function ownedBy(items, leaderId) {
    const key = typeof leaderId === 'string' && leaderId.startsWith('command:') ? leaderId : Number(leaderId);
    return items?.byLeader?.get(key) ?? NONE;
}

module.exports = { put, take, ownedBy, leaderOf, ownerOf };
