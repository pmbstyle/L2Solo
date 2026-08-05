const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');

async function main() {
    const databasePath = path.join(process.cwd(), 'tmp', 'test-bot-trade.sqlite');
    fs.rmSync(databasePath, { force: true });
    options.default.Database.path = path.relative(process.cwd(), databasePath);
    Database.init();

    await Database.createAccount('trade_db_player', 'secret');
    await Database.createAccount('trade_db_bot', 'secret');
    await Database.createCharacter('trade_db_player', {
        name: 'TradeDbPlayer', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    await Database.createCharacter('trade_db_bot', {
        name: 'TradeDbBot', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });

    const playerId = Number((await Database.fetchCharacterName('TradeDbPlayer'))[0].id);
    const botId = Number((await Database.fetchCharacterName('TradeDbBot'))[0].id);
    const playerItemId = Number((await Database.setItem(playerId, {
        selfId: 7001, name: 'Player Token', amount: 2, equipped: false, slot: 0
    })).insertId);
    const botItemId = Number((await Database.setItem(botId, {
        selfId: 7002, name: 'Bot Token', amount: 3, equipped: false, slot: 0
    })).insertId);

    const moved = await Database.transferInventoryBetweenCharacters([
        { fromCharacterId: playerId, toCharacterId: botId, sourceItemId: playerItemId, selfId: 7001, amount: 1, stackable: true, name: 'Player Token' },
        { fromCharacterId: botId, toCharacterId: playerId, sourceItemId: botItemId, selfId: 7002, amount: 2, stackable: true, name: 'Bot Token' }
    ]);
    assert.strictEqual(moved.length, 2);
    assert.strictEqual((await Database.fetchItems(playerId)).find((item) => Number(item.selfId) === 7001).amount, 1);
    assert.strictEqual((await Database.fetchItems(playerId)).find((item) => Number(item.selfId) === 7002).amount, 2);
    assert.strictEqual((await Database.fetchItems(botId)).find((item) => Number(item.selfId) === 7001).amount, 1);
    assert.strictEqual((await Database.fetchItems(botId)).find((item) => Number(item.selfId) === 7002).amount, 1);

    await assert.rejects(
        Database.transferInventoryBetweenCharacters([
            { fromCharacterId: playerId, toCharacterId: botId, sourceItemId: playerItemId, selfId: 7001, amount: 1, stackable: true },
            { fromCharacterId: botId, toCharacterId: playerId, sourceItemId: 999999, selfId: 7002, amount: 1, stackable: true }
        ]),
        /inventory item changed/
    );
    assert.strictEqual((await Database.fetchItems(playerId)).find((item) => Number(item.selfId) === 7001).amount, 1, 'failed transfer must roll back the first side');
    console.log('Bot trade database checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
