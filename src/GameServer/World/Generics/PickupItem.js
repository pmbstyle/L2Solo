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
    const id     = item.fetchId();
    const spawnIndex = this.items.spawns.findIndex((spawn) => spawn.fetchId() === id);
    if (spawnIndex < 0) return false;

    // PickupExec resolves the ground object before the actor finishes moving.
    // A player and a bot can therefore both hold the same stale reference and
    // reach this method on adjacent timers. Removing the canonical spawn first
    // makes the claim atomic in the world event loop: only one caller may award
    // the item, distribute Adena, delete the object, or emit pickup text.
    const [claimedItem] = this.items.spawns.splice(spawnIndex, 1);
    const selfId = claimedItem.fetchSelfId();
    const amount = claimedItem.fetchAmount();

    session.dataSendToMeAndOthers(ServerResponse.deleteOb(id), claimedItem);

    if (selfId === 57) {
        const allocations = PartyCompanionService.adenaAllocations(session, amount, claimedItem);
        allocations.forEach((entry) => {
            this.purchaseItem(entry.session, selfId, entry.amount);
            transmitPickup(entry.session, selfId, entry.amount);
        });
        return true;
    }

    const recipientSession = PartyCompanionService.resolveLootSession(session, selfId, claimedItem);
    this.purchaseItem(recipientSession, selfId, amount);
    transmitPickup(recipientSession, selfId, amount);
    return true;
}

module.exports = pickupItem;
