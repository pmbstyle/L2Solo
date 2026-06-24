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
    const selfId = item.fetchSelfId();
    const amount = item.fetchAmount();

    this.items.spawns = this.items.spawns.filter((ob) => ob.fetchId() !== id);
    session.dataSendToMeAndOthers(ServerResponse.deleteOb(id), item);

    if (selfId === 57) {
        const allocations = PartyCompanionService.adenaAllocations(session, amount, item);
        allocations.forEach((entry) => {
            this.purchaseItem(entry.session, selfId, entry.amount);
            transmitPickup(entry.session, selfId, entry.amount);
        });
        return;
    }

    const recipientSession = PartyCompanionService.resolveLootSession(session, selfId, item);
    this.purchaseItem(recipientSession, selfId, amount);
    transmitPickup(recipientSession, selfId, amount);
}

module.exports = pickupItem;
