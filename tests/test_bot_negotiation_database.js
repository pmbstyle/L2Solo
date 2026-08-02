const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const BotNegotiationService = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const Item = invoke('GameServer/Item/Item');

options.default.OpenRouter.negotiationEnabled = true;

function actor(id, name, backpack) {
    return { fetchId: () => id, fetchName: () => name, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchIsOnline: () => true, isDead: () => false, backpack };
}
function backpack(items) {
    return { items, fetchItemRaw(id) { return this.items.find((item) => Number(item.fetchId()) === Number(id)); }, fetchItems() { return this.items; }, fetchItemFromSelfId(id) { return this.items.find((item) => Number(item.fetchSelfId()) === Number(id)); } };
}

async function main() {
    const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-negotiation.sqlite');
    fs.rmSync(databasePath, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();
    await Database.createAccount('neg_db_player', 'secret');
    await Database.createAccount('neg_db_bot', 'secret');
    await Database.createCharacter('neg_db_player', { name: 'NegDbPlayer', race: 0, classId: 0, maxHp: 50, maxMp: 25, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 });
    await Database.createCharacter('neg_db_bot', { name: 'NegDbBot', race: 0, classId: 0, maxHp: 50, maxMp: 25, sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 });
    const playerId = Number((await Database.fetchCharacterName('NegDbPlayer'))[0].id);
    const botId = Number((await Database.fetchCharacterName('NegDbBot'))[0].id);
    const player = { accountId: 'neg_db_player', actor: actor(playerId, 'NegDbPlayer', backpack([new Item(960, { selfId: 57, name: 'Adena', kind: 'Other.Currency', amount: 5000, stackable: true, equipped: false, slot: 0 })])) };
    const bot = { accountId: 'bot_neg_db', plan: 'merchant', actor: actor(botId, 'NegDbBot', backpack([new Item(961, { selfId: 9061, name: 'Database Cloth', kind: 'Other.Material', price: 1000, amount: 2, stackable: true, equipped: false, slot: 0 })])) };
    const originalSnapshot = BotSocialMemory.getSnapshot;
    BotSocialMemory.getSnapshot = () => ({ trust: 0, familiarity: 0 });
    try {
        const quote = BotNegotiationService.quoteItem(bot, player, 961, 1);
        assert.strictEqual(quote.ok, true);
        await new Promise((resolve) => setImmediate(resolve));
        let row = (await Database.execute(['SELECT state, currentUnitPrice FROM bot_negotiations WHERE id = ?', [quote.negotiation.id]]))[0];
        assert.strictEqual(row.state, 'open');
        const accepted = BotNegotiationService.acceptPrice(bot, player, quote.negotiation.currentTotalPrice);
        assert.strictEqual(accepted.ok, true);
        await new Promise((resolve) => setImmediate(resolve));
        row = (await Database.execute(['SELECT state, agreedTotalPrice FROM bot_negotiations WHERE id = ?', [quote.negotiation.id]]))[0];
        assert.strictEqual(row.state, 'accepted');
        assert.strictEqual(Number(row.agreedTotalPrice), quote.negotiation.currentTotalPrice);
        console.log('Bot negotiation database checks passed');
    } finally {
        BotSocialMemory.getSnapshot = originalSnapshot;
        BotNegotiationService.reset();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
