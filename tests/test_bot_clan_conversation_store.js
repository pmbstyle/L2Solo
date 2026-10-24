const assert = require('assert');
const fs = require('node:fs');
const nodePath = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const Store = invoke('GameServer/Bot/AI/BotClanConversationStore');

async function main() {
    const file = nodePath.resolve('tmp/test-bot-clan-conversation-store.sqlite');
    fs.rmSync(file, { force: true });
    let connection = new DatabaseSync(file);
    connection.exec(`PRAGMA foreign_keys=ON; CREATE TABLE clans(id INTEGER PRIMARY KEY);
        CREATE TABLE characters(id INTEGER PRIMARY KEY); INSERT INTO clans VALUES(1),(2); INSERT INTO characters VALUES(10),(20);`);
    Store.install(connection); Store.install(connection);
    const saved = { execute: Database.execute, ready: Database.isReady };
    Database.isReady = () => true;
    Database.execute = async ([sql, values]) => /^\s*SELECT/.test(sql)
        ? connection.prepare(sql).all(...values) : connection.prepare(sql).run(...values);
    try {
        await Store.append(1, { turnId: 'same', role: 'player', playerId: 10, name: 'Player', text: 'Public question', at: 100 });
        await Store.append(1, { turnId: 'same', role: 'bot', botId: 20, name: 'Bot', text: 'Public answer', at: 101 });
        await Store.append(1, { turnId: 'same', role: 'bot', botId: 20, name: 'Bot', text: 'Must not duplicate', at: 101 });
        await Store.append(2, { turnId: 'other', role: 'player', playerId: 10, name: 'Player', text: 'Other clan secret', at: 102 });
        connection.close(); connection = new DatabaseSync(file); connection.exec('PRAGMA foreign_keys=ON');
        const recovered = await Store.recent(1);
        assert.deepStrictEqual(recovered.map(turn => turn.text), ['Public question', 'Public answer'], 'delivered public history survives a connection restart');
        assert.strictEqual((await Store.recent(1, { since: 101 })).length, 1);
        assert(!JSON.stringify(recovered).includes('Other clan secret'));
        assert(connection.prepare('EXPLAIN QUERY PLAN SELECT * FROM bot_clan_dialogue_messages WHERE clanId=1 ORDER BY id DESC LIMIT 12').all()
            .some(row => row.detail.includes('bot_clan_dialogue_recent')), 'history reads use the clan index');
        for (let i = 0; i < Store.MAX_ROWS + 5; i++) await Store.append(1, {
            turnId: 'retention-' + i, role: 'bot', botId: 20, name: 'Bot', text: 'Answer ' + i, at: 200 + i
        });
        assert.strictEqual(connection.prepare('SELECT count(*) n FROM bot_clan_dialogue_messages WHERE clanId=1').get().n, Store.MAX_ROWS);
        assert.strictEqual((await Store.recent(2)).length, 1, 'retention cannot remove another clan history');
        connection.prepare('DELETE FROM characters WHERE id=20').run();
        assert.strictEqual((await Store.recent(1))[0].botId, null, 'a removed character leaves attributed public text without a dangling foreign key');
        connection.prepare('DELETE FROM clans WHERE id=1').run();
        assert.deepStrictEqual(await Store.recent(1), [], 'clan deletion/world reset removes its public history');
        assert.deepStrictEqual(connection.prepare('PRAGMA foreign_key_check').all(), []);
    } finally {
        Database.execute = saved.execute; Database.isReady = saved.ready;
        connection.close(); fs.rmSync(file, { force: true });
    }
    console.log('Persistent clan history isolation, retention, index and deletion checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
