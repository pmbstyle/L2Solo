const ReceivePacket = invoke('Packet/Receive');
const PrivateStore = invoke('GameServer/PrivateStore');
module.exports = (session, buffer) => {
    if (!buffer || buffer.length < 9) {
        utils.infoWarn('PrivateStore', 'reject sell publish: short packet len=%d', buffer?.length || 0);
        return;
    }
    const packet = new ReceivePacket(buffer); packet.readD().readD();
    const packageSale = packet.data[0] === 1; const count = Number(packet.data[1]);
    // The C4 client can append optional fields after the rows. Lisvus validates
    // only that every declared row is present, not that this is the exact end.
    if (!Number.isSafeInteger(count) || count < 1 || count > 4 || buffer.length < 9 + count * 12) {
        utils.infoWarn('PrivateStore', 'reject sell publish for %s: len=%d packaged=%s count=%d', session?.actor?.fetchName?.() || 'unknown', buffer.length, packageSale, count);
        return;
    }
    const rows = []; for (let i = 0; i < count; i += 1) { packet.readD().readD().readD(); rows.push({ objectId: packet.data[2 + i * 3], count: packet.data[3 + i * 3], price: packet.data[4 + i * 3] }); }
    if (!PrivateStore.publishSell(session, packageSale, rows)) {
        utils.infoWarn('PrivateStore', 'reject sell publish for %s: state=%d rows=%j', session?.actor?.fetchName?.() || 'unknown', session?.actor?.fetchPrivateStoreType?.() || 0, rows);
        session?.dataSendToMe?.(invoke('GameServer/Network/Response').actionFailed());
        return;
    }
};
