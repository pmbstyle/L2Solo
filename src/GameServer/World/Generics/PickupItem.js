const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const PickupCapacity = require('../../Inventory/PickupCapacity');
const GroundItemVisibility = require('../GroundItemVisibility');

// A drop refused for room stays on the ground; the party's loot scan leaves
// it alone until a bag changes (PartyCompanionService.lootBagsKey).
function rejectCapacity(session, reason, item) {
    session.dataSendToMe(ServerResponse.actionFailed());
    if (reason === 'slots' || reason === 'weight') {
        item.partyLootRefusedBags = PartyCompanionService.lootBagsKey(PartyCompanionService.groundLootLeader(session));
        ConsoleText.transmit(session, reason === 'slots'
            ? ConsoleText.caption.inventoryFull : ConsoleText.caption.loadLimitExceeded);
    }
}

function pickupItem(session, actor, item) {
    if (!actor || session?.actor !== actor || !actor.backpack ||
        actor.isDead?.() || actor.fetchIsOnline?.() === false) return false;
    if (!PartyCompanionService.canPickupLoot(session)) return false;
    const id     = item.fetchId();
    const spawnIndex = this.items.spawns.findIndex((spawn) => spawn.fetchId() === id);
    if (spawnIndex < 0) return false;

    const canonicalItem = this.items.spawns[spawnIndex];
    const selfId = canonicalItem.fetchSelfId();
    const amount = canonicalItem.fetchAmount();
    let capacityFailure;
    const allocations = selfId === 57
        ? PartyCompanionService.adenaAllocations(session, amount, canonicalItem)
        : [{ session: PartyCompanionService.resolveLootSession(session, selfId, canonicalItem, {
            canReceive(recipient) {
                const { reason } = PickupCapacity.check(recipient?.actor, selfId, amount, canonicalItem);
                if (reason) capacityFailure ||= reason;
                return !reason;
            }
        }), amount }];
    // Validate every recipient before claiming the drop, so a stale session
    // cannot crash the award or consume loot without receiving it.
    if (!allocations.length || allocations.some((entry) => !entry.session?.actor?.backpack ||
        entry.session.actor.isDead?.() || entry.session.actor.fetchIsOnline?.() === false)) {
        if (capacityFailure) rejectCapacity(session, capacityFailure, canonicalItem);
        return false;
    }

    const releases = [];
    for (const entry of allocations) {
        const reservation = PickupCapacity.reserve(entry.session.actor, selfId, entry.amount, canonicalItem);
        if (!reservation.release) {
            releases.forEach(done => done());
            rejectCapacity(session, reservation.reason, canonicalItem);
            return false;
        }
        releases.push(reservation.release);
    }

    // PickupExec resolves the ground object before the actor finishes moving.
    // A player and a bot can therefore both hold the same stale reference and
    // reach this method on adjacent timers. Removing the canonical spawn first
    // makes the claim atomic in the world event loop: only one caller may award
    // the item, distribute Adena, delete the object, or emit pickup text.
    const [claimedItem] = this.items.spawns.splice(spawnIndex, 1);

    let scheduled = 0;
    try {
        session.dataSendToMeAndOthers(ServerResponse.deleteOb(id), claimedItem);
        // Nearby clients were cleared by the normal broadcast. Also remove
        // the object from clients that saw its spawn and have since left.
        GroundItemVisibility.deleteKnownItem(this, id);
        allocations.forEach((entry, index) => {
            const award = this.purchaseItem(entry.session, selfId, entry.amount, selfId === 57 ? {} : {
                enchant: claimedItem.fetchEnchantLevel?.() ?? 0,
                ...(claimedItem.fetchPetData?.() ? { petData: claimedItem.fetchPetData() } : {})
            });
            scheduled++;
            if (award && typeof award.then === 'function') award.then(releases[index], releases[index]);
            else releases[index]();
            ConsoleText.transmitPickup(entry.session, selfId, entry.amount);
        });
    } finally {
        releases.slice(scheduled).forEach(release => release());
    }
    return true;
}

module.exports = pickupItem;
