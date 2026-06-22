const ReceivePacket = invoke('Packet/Receive');
const ServerResponse = invoke('GameServer/Network/Response');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const BotManager = invoke('GameServer/Bot/BotManager');

function describeMovedItems(items) {
    return items.map((item) => `${item.count} ${item.name}`).join(', ');
}

async function tradeDone(session, buffer) {
    const packet = new ReceivePacket(buffer);

    packet.readD(); // 1 = confirmed, 0 = cancelled

    if (packet.data[0] !== 1) {
        BotTradeService.cancel(session);
        session.dataSendToMe(ServerResponse.tradeDone(false));
        return;
    }

    try {
        const result = await BotTradeService.commit(session);
        if (!result.ok) {
            BotTradeService.cancel(session);
            session.dataSendToMe(ServerResponse.actionFailed());
            session.dataSendToMe(ServerResponse.tradeDone(false));
            return;
        }

        const detail = describeMovedItems(result.moved);
        const lootRequest = BotLootEtiquette.resolveTrade(session, result.partnerSession, result.moved);
        BotSocialMemory.recordEvent(
            session,
            result.partnerSession,
            lootRequest ? 'gave_useful_loot' : 'trade_completed',
            detail
        );
        BotManager.botTell(
            result.partnerSession,
            session,
            lootRequest ? `Thanks, that's exactly what I needed: ${detail}.` : `Thanks for the trade. I got ${detail}.`
        );
        BotEquipmentUpgrade.applyBestUpgrades(result.partnerSession, { force: true });

        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.tradeDone(true));
    } catch (err) {
        utils.infoWarn('TradeDone', 'bot trade failed: %s', err.message || err);
        BotTradeService.cancel(session);
        session.dataSendToMe(ServerResponse.actionFailed());
        session.dataSendToMe(ServerResponse.tradeDone(false));
    }
}

module.exports = tradeDone;
