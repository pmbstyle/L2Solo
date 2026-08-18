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

function sessionName(session) {
    return session?.actor?.fetchName?.() || session?.accountId || 'unknown';
}

async function tradeDone(session, buffer) {
    const packet = new ReceivePacket(buffer);
    const playerName = sessionName(session);

    packet.readD(); // 1 = confirmed, 0 = cancelled

    if (packet.data[0] !== 1) {
        console.info("TradeDone :: %s cancelled native bot trade", playerName);
        BotTradeService.cancel(session);
        session.dataSendToMe(ServerResponse.tradeDone(false));
        return;
    }

    let tradeSummary = null;
    try {
        const confirmation = BotTradeService.confirmPlayerTrade(session);
        if (!confirmation.ok) {
            utils.infoWarn('TradeDone', 'bot trade confirmation rejected player=%s reason=%s', playerName, confirmation.reason || 'unknown');
            BotTradeService.cancel(session);
            session.dataSendToMe(ServerResponse.actionFailed());
            session.dataSendToMe(ServerResponse.tradeDone(false));
            return;
        }

        tradeSummary = BotTradeService.activeTradeSummary(session);
        console.info(
            "TradeDone :: %s confirmed native bot trade id=%s bot=%s playerItems=%j botItems=%j",
            playerName,
            tradeSummary?.id || 'unknown',
            confirmation.trade?.botSession?.actor?.fetchName?.() || 'unknown',
            tradeSummary?.playerItems || [],
            tradeSummary?.botItems || []
        );
        const result = await BotTradeService.commit(session);
        if (!result.ok) {
            utils.infoWarn(
                'TradeDone',
                'bot trade commit rejected player=%s trade=%s reason=%s error=%s playerItems=%j botItems=%j',
                playerName,
                tradeSummary?.id || 'unknown',
                result.reason || 'unknown',
                result.error?.message || '',
                tradeSummary?.playerItems || [],
                tradeSummary?.botItems || []
            );
            if (result.reason === 'inventory_capacity' && confirmation.trade?.botSession) {
                BotManager.botTell(
                    confirmation.trade.botSession,
                    session,
                    "I can't accept this right now — my inventory is full."
                );
            }
            BotTradeService.cancel(session);
            session.dataSendToMe(ServerResponse.actionFailed());
            session.dataSendToMe(ServerResponse.tradeDone(false));
            return;
        }

        if (result.idempotent) {
            session.dataSendToMe(ServerResponse.tradeDone(true));
            return;
        }

        const detail = describeMovedItems(result.moved);
        const receivedByBot = describeMovedItems((result.moved || []).filter((item) => item.direction === 'player_to_bot'));
        const receivedByPlayer = describeMovedItems((result.moved || []).filter((item) => item.direction === 'bot_to_player'));
        const lootRequest = result.direction === 'bot_outbound'
            ? null
            : BotLootEtiquette.resolveTrade(session, result.partnerSession, result.moved);
        BotSocialMemory.recordEvent(
            session,
            result.partnerSession,
            lootRequest ? 'gave_useful_loot' : 'trade_completed',
            detail
        );
        Promise.resolve(invoke('GameServer/Bot/AI/BotEventJournal').record({
            playerId: session.actor?.fetchId?.(),
            botId: result.partnerSession?.actor?.fetchId?.(),
            eventType: 'trade_completed',
            summary: `${session.actor?.fetchName?.() || 'Player'} traded ${detail}.`,
            weight: 4,
            dedupeKey: `trade:${session.actor?.fetchId?.()}:${result.partnerSession?.actor?.fetchId?.()}:${detail}`,
            coalesceWindowMs: 30 * 1000,
            meta: { itemCount: result.moved?.length || 0 }
        })).catch(() => {});
        BotManager.botTell(
            result.partnerSession,
            session,
            result.negotiationId
                ? `The agreed price is settled. I received ${receivedByBot || 'your payment'} for ${receivedByPlayer || 'the item'}.`
                : lootRequest
                    ? `Thanks, that's exactly what I needed: ${detail}.`
                    : result.direction === 'bot_outbound'
                        ? `Trade complete. I sent ${receivedByPlayer || 'the agreed resources'}.`
                        : `Thanks for the trade. I got ${detail}.`
        );
        BotEquipmentUpgrade.applyBestUpgrades(result.partnerSession, { force: true });

        session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
        session.dataSendToMe(ServerResponse.tradeDone(true));
    } catch (err) {
        utils.infoWarn('TradeDone', 'bot trade exception player=%s trade=%s: %s', playerName, tradeSummary?.id || 'unknown', err.stack || err.message || err);
        BotTradeService.cancel(session);
        session.dataSendToMe(ServerResponse.actionFailed());
        session.dataSendToMe(ServerResponse.tradeDone(false));
    }
}

module.exports = tradeDone;
