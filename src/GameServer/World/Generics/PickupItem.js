const ServerResponse = invoke('GameServer/Network/Response');
const ConsoleText    = invoke('GameServer/ConsoleText');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

function transmitPickup(session, selfId, amount) {
    const textName   = { kind: ConsoleText.kind.  item, value: selfId };
    const textAmount = { kind: ConsoleText.kind.number, value: amount };
    amount > 1
        ? (selfId === 57
            ? ConsoleText.transmit(session, ConsoleText.caption.pickupAdenaAmount, [textAmount])
            : ConsoleText.transmit(session, ConsoleText.caption.pickupAmountOf, [textName, textAmount]))
        : ConsoleText.transmit(session, ConsoleText.caption.pickup, [textName]);
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
    const allocations = selfId === 57
        ? PartyCompanionService.adenaAllocations(session, amount, canonicalItem)
        : [{ session: PartyCompanionService.resolveLootSession(session, selfId, canonicalItem), amount }];
    // Validate every recipient before claiming the drop, so a stale session
    // cannot crash the award or consume loot without receiving it.
    if (!allocations.length || allocations.some((entry) => !entry.session?.actor?.backpack ||
        entry.session.actor.isDead?.() || entry.session.actor.fetchIsOnline?.() === false)) return false;

    // PickupExec resolves the ground object before the actor finishes moving.
    // A player and a bot can therefore both hold the same stale reference and
    // reach this method on adjacent timers. Removing the canonical spawn first
    // makes the claim atomic in the world event loop: only one caller may award
    // the item, distribute Adena, delete the object, or emit pickup text.
    const [claimedItem] = this.items.spawns.splice(spawnIndex, 1);

    session.dataSendToMeAndOthers(ServerResponse.deleteOb(id), claimedItem);

    if (selfId === 57) {
        allocations.forEach((entry) => {
            this.purchaseItem(entry.session, selfId, entry.amount);
            transmitPickup(entry.session, selfId, entry.amount);
        });
        return true;
    }

    const recipientSession = allocations[0].session;
    this.purchaseItem(recipientSession, selfId, amount, claimedItem.fetchPetData?.() ? { petData: claimedItem.fetchPetData() } : {});
    transmitPickup(recipientSession, selfId, amount);
    return true;
}

module.exports = pickupItem;
