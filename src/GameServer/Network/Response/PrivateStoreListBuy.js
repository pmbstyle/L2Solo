const SendPacket = invoke('Packet/Send');
const DataCache = invoke('GameServer/DataCache');

// Send.writeD encodes the full unsigned 32-bit wire range as an int32.
const MAX_UNSIGNED_D = 0xffffffff;

function wireD(value) {
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) && numericValue >= 0 && numericValue <= MAX_UNSIGNED_D
        ? numericValue
        : null;
}

function boundedD(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return 0;
    return Math.max(0, Math.min(MAX_UNSIGNED_D, Math.floor(numericValue)));
}

function referencePrice(item) {
    const template = (DataCache.items || []).find((entry) => (
        Number(entry.selfId) === Number(item.fetchSelfId())
    ));
    const templatePrice = wireD(template?.template?.price);
    if (templatePrice !== null) return templatePrice;
    return wireD(item.fetchPrice?.());
}

function bodyPart(item) {
    return item.isWearable() ? 2 ** item.fetchSlot() : 0;
}

// C4 PrivateStoreListBuy (0xb8). Unlike the generic NPC SellList, this
// packet identifies the seated buyer and makes the client send 0x96.
function privateStoreListBuy(merchant, rows, adena) {
    const safeRows = (Array.isArray(rows) ? rows : []).filter((row) => {
        const item = row?.item;
        return item
            && wireD(item.fetchId?.()) !== null
            && wireD(item.fetchSelfId?.()) !== null
            && wireD(row.amount) !== null
            && referencePrice(item) !== null
            && wireD(bodyPart(item)) !== null
            && wireD(item.fetchClass2?.()) !== null
            && wireD(row.price) !== null;
    });

    const packet = new SendPacket(0xb8);
    packet
        .writeD(boundedD(merchant.fetchId()))
        // C4 has no wider adena field. Saturate the display value at the
        // 32-bit wire limit; trade authorization still uses the server-side
        // wallet.
        .writeD(boundedD(adena))
        .writeD(safeRows.length);

    safeRows.forEach((row) => {
        const item = row.item;
        packet
            .writeD(item.fetchId())
            .writeD(item.fetchSelfId())
            .writeH(item.fetchEnchantLevel?.() || 0) // Enchant
            .writeD(row.amount)
            // The client expects the immutable datapack reference price here.
            // Do not trust a mutable/runtime item price: a corrupt value can
            // exceed the signed C4 D range and otherwise terminate the server.
            .writeD(referencePrice(item))
            .writeH(0)
            .writeD(bodyPart(item))
            .writeH(item.fetchClass2())
            .writeD(row.price)
            .writeD(row.amount);
    });

    return packet.fetchBuffer();
}

module.exports = privateStoreListBuy;
