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
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info("TradeDone :: %s cancelled native bot trade", playerName);
        BotTradeService.cancel(session);
        session.dataSendToMe(ServerResponse.tradeDone(false));
        return;
    }

    let tradeSummary = null;
    let reservedBuffTrade = null;
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
        const botSession = confirmation.trade?.botSession;
        const adenaOnlyToBuffer = tradeSummary?.direction === 'player_inbound'
            && !tradeSummary.buffService && !tradeSummary.negotiationId && tradeSummary.botItems?.length === 0
            && tradeSummary.playerItems?.length === 1 && Number(tradeSummary.playerItems[0].selfId) === 57
            && invoke('GameServer/Bot/Economy/BuffServicePolicy').serviceClass(botSession?.actor);
        if (adenaOnlyToBuffer) {
            BotTradeService.cancel(session, 'buff_payment_requires_command', false);
            BotManager.botTell(botSession, session,
                'To buy buffs, target me and type .buff. I will open the payment trade for you.');
            session.dataSendToMe(ServerResponse.tradeDone(false));
            return;
        }
        if (confirmation.trade?.buffService) {
            if (confirmation.trade.buffServiceCommitting) return;
            const BuffService = invoke('GameServer/Bot/Economy/BuffService');
            const admission = BuffService.reserveNativeTrade(confirmation.trade);
            if (!admission.ok) {
                BotTradeService.cancel(session, 'buff_offer_invalid', false);
                BotManager.botTell(botSession, session, admission.reason);
                session.dataSendToMe(ServerResponse.tradeDone(false));
                return;
            }
            reservedBuffTrade = confirmation.trade;
        }
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info(
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
                    result.capacityBlocked?.player && result.capacityBlocked?.bot
                        ? "We both need more inventory space to complete this trade."
                        : result.capacityBlocked?.player
                            ? "You need more inventory space to receive these items."
                            : "I need more inventory space to receive these items."
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

        if (reservedBuffTrade) {
            const buffTrade = reservedBuffTrade;
            reservedBuffTrade = null;
            buffTrade.buffServiceCompletion = Promise.resolve()
                .then(() => invoke('GameServer/Bot/Economy/BuffService').completeNativeTrade(buffTrade))
                .catch(error => utils.infoWarn('BuffService', 'native buff fulfillment failed: %s', error.stack || error.message))
                .finally(() => invoke('GameServer/Bot/Economy/BuffService').releaseNativeTrade(buffTrade));
            session.dataSendToMe(ServerResponse.itemsList(session.actor.backpack.fetchItems()));
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
    } finally {
        if (reservedBuffTrade) invoke('GameServer/Bot/Economy/BuffService').releaseNativeTrade(reservedBuffTrade);
    }
}

module.exports = tradeDone;
