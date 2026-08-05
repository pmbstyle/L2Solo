const assert = require('assert');
require('../src/Global');

const Database = invoke('Database');
const BotTradeService = invoke('GameServer/Bot/BotTradeService');
const LangfuseTracing = invoke('GameServer/Bot/AI/LangfuseTracing');
const Item = invoke('GameServer/Item/Item');

function item(id, selfId, amount, name) {
    return new Item(id, {
        selfId,
        name,
        kind: 'Other.Material',
        amount,
        stackable: true,
        equipped: false,
        slot: 0
    });
}

function bag(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((entry) => Number(entry.fetchId()) === Number(id)); },
        fetchItemFromSelfId(selfId) { return this.items.find((entry) => Number(entry.fetchSelfId()) === Number(selfId)); },
        insertItem(id, selfId, data) { this.items.push(item(id, selfId, data.amount, data.name)); }
    };
}

function actor(id, name, backpack) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true,
        isDead: () => false,
        backpack
    };
}

async function main() {
    const originalTransfer = Database.transferInventoryBetweenCharacters;
    const originalStartObservation = LangfuseTracing.startObservation;
    const observations = [];
    const botItem = item(501, 1864, 4, 'Varnish');
    const player = {
        accountId: 'player_supply_lifecycle',
        dataSendToMe() {},
        actor: actor(510, 'SupplyLeader', bag([]))
    };
    const bot = {
        accountId: 'bot_supply_lifecycle',
        partyCompanion: true,
        followPlayerSession: player,
        actor: actor(511, 'SupplyBot', bag([botItem]))
    };
    try {
        LangfuseTracing.startObservation = (name, input, metadata) => {
            const entry = { name, input, metadata, ended: [] };
            observations.push(entry);
            return {
                end(value) { entry.ended.push(value); },
                child(childName, childInput, childMetadata) {
                    const child = { name: childName, input: childInput, metadata: childMetadata, ended: [] };
                    observations.push(child);
                    return { end(value) { child.ended.push(value); } };
                }
            };
        };
        bot.botTradeGiftLedger = { startedAt: Date.now(), units: 5000 };
        bot.pendingResourceDelivery = {
            workflowId: 'supply-workflow-commit',
            playerSession: player,
            playerId: 510,
            objectId: 501,
            amount: 2,
            itemName: 'Varnish'
        };

        const opened = BotTradeService.startBotTradeWithOffer(bot, player, 501, 2, {
            workflowId: 'supply-workflow-commit',
            supplyDelivery: true
        });
        assert.strictEqual(opened.ok, true, 'supply delivery must not be blocked by the generic gift budget');
        bot.pendingResourceDelivery.tradeId = opened.trade.id;
        assert.strictEqual(bot.botTradeGiftLedger.units, 5000, 'supply delivery must not consume generic gift budget');

        Database.transferInventoryBetweenCharacters = async (entries) => entries.map((entry) => ({
            ...entry,
            targetItemId: 601,
            remaining: entry.fromCharacterId === 511 ? 2 : 0
        }));
        const committed = await BotTradeService.commit(player);
        assert.strictEqual(committed.ok, true);
        assert.strictEqual(bot.pendingResourceDelivery, undefined, 'commit must complete the pending supply delivery');
        assert(observations.some((entry) => entry.name === 'bot.workflow.supply.trade' && entry.metadata.outcome === 'completed'), 'commit must emit a completed trade phase');

        const existing = BotTradeService.startBotTrade(bot, player);
        assert.strictEqual(existing.ok, true);
        const blockedByExisting = BotTradeService.startBotTradeWithOffer(bot, player, 501, 1, {
            workflowId: 'supply-workflow-blocked',
            supplyDelivery: true
        });
        assert.deepStrictEqual(blockedByExisting, { ok: false, reason: 'trade_active' }, 'supply delivery must not replace an unrelated active trade');
        assert.strictEqual(bot.activeTrade, existing.trade, 'the unrelated trade must remain active');
        BotTradeService.cancel(bot, 'test_cleanup', false);

        bot.pendingResourceDelivery = {
            workflowId: 'supply-workflow-cancel',
            playerSession: player,
            playerId: 510,
            objectId: 501,
            amount: 1,
            itemName: 'Varnish'
        };
        const reopened = BotTradeService.startBotTradeWithOffer(bot, player, 501, 1, {
            workflowId: 'supply-workflow-cancel',
            supplyDelivery: true
        });
        assert.strictEqual(reopened.ok, true);
        bot.pendingResourceDelivery.tradeId = reopened.trade.id;
        BotTradeService.cancel(bot, 'player_cancel', false);
        assert.strictEqual(bot.pendingResourceDelivery.tradeId, undefined, 'cancel must release the delivery trade marker for retry');
        assert(observations.some((entry) => entry.name === 'bot.workflow.supply.trade' && entry.metadata.outcome === 'cancelled'), 'cancel must emit a terminal trade phase');
        console.log('Supply trade lifecycle checks passed');
    } finally {
        Database.transferInventoryBetweenCharacters = originalTransfer;
        LangfuseTracing.startObservation = originalStartObservation;
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
