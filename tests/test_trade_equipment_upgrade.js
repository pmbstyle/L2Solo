const assert = require('assert');

require('../src/Global');

const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const BotLootEtiquette = invoke('GameServer/Bot/AI/BotLootEtiquette');
const BotEquipmentUpgrade = invoke('GameServer/Bot/AI/BotEquipmentUpgrade');
const BotManager = invoke('GameServer/Bot/BotManager');
const tradeDone = invoke('GameServer/Network/Request/TradeDone');

const original = {
    commit: BotTradeService.commit,
    confirmPlayerTrade: BotTradeService.confirmPlayerTrade,
    recordEvent: BotSocialMemory.recordEvent,
    resolveTrade: BotLootEtiquette.resolveTrade,
    applyBestUpgrades: BotEquipmentUpgrade.applyBestUpgrades,
    botTell: BotManager.botTell
};

const playerSession = {
    actor: { backpack: { fetchItems: () => [] } },
    dataSendToMe() {}
};
const botSession = {
    accountId: 'bot_trade_upgrade',
    actor: { backpack: { fetchItems: () => [] } }
};

let reevaluated = null;

(async () => {
    try {
        BotTradeService.commit = async () => ({
            ok: true,
            partnerSession: botSession,
            moved: [{ selfId: 5, name: 'Mace', count: 1 }]
        });
        BotTradeService.confirmPlayerTrade = () => ({ ok: true });
        BotSocialMemory.recordEvent = () => Promise.resolve(null);
        BotLootEtiquette.resolveTrade = () => null;
        BotManager.botTell = () => {};
        BotEquipmentUpgrade.applyBestUpgrades = (session, options) => {
            reevaluated = { session, options };
            return [{ item: 'Mace' }];
        };

        await tradeDone(playerSession, Buffer.from([0x17, 1, 0, 0, 0]));

        assert.deepStrictEqual(reevaluated, {
            session: botSession,
            options: { force: true }
        }, 'a bot must immediately re-evaluate suitable upgrades after receiving a player trade');
        console.log('Trade equipment upgrade checks passed');
    } finally {
        BotTradeService.commit = original.commit;
        BotTradeService.confirmPlayerTrade = original.confirmPlayerTrade;
        BotSocialMemory.recordEvent = original.recordEvent;
        BotLootEtiquette.resolveTrade = original.resolveTrade;
        BotEquipmentUpgrade.applyBestUpgrades = original.applyBestUpgrades;
        BotManager.botTell = original.botTell;
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
