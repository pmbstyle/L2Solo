const assert = require('assert');
require('../src/Global');

const BotEventJournal = invoke('GameServer/Bot/AI/BotEventJournal');

async function main() {
    BotEventJournal.resetMemory();
    const first = await BotEventJournal.record({
        playerId: 10,
        botId: 20,
        eventType: 'kill_streak',
        summary: 'Defeated a goblin.',
        dedupeKey: 'spot:goblin',
        coalesceWindowMs: 60000
    });
    const second = await BotEventJournal.record({
        playerId: 10,
        botId: 20,
        eventType: 'kill_streak',
        summary: 'Defeated another goblin.',
        dedupeKey: 'spot:goblin',
        coalesceWindowMs: 60000,
        createdAt: first.event.updatedAt + 1000
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.coalesced, true);
    assert.strictEqual(second.event.count, 2);

    await BotEventJournal.record({ playerId: 11, botId: 20, eventType: 'chat', summary: 'Other player event.' });
    await BotEventJournal.record({ botId: 20, eventType: 'level_up', summary: 'Reached level 12.', createdAt: first.event.updatedAt + 2000 });
    const pairEvents = await BotEventJournal.recent({ playerId: 10, botId: 20, limit: 10 });
    assert.deepStrictEqual(pairEvents.map((event) => event.eventType), ['kill_streak', 'level_up']);
    assert.strictEqual(pairEvents[0].count, 2);
    assert.strictEqual(BotEventJournal.memorySize(), 3);
    await BotEventJournal.record({ playerId: 10, botId: 20, eventType: 'llm_decision', summary: 'Goblin defeated (model proposal).' });
    assert.strictEqual((await BotEventJournal.search({ playerId: 10, botId: 20, query: 'goblin' })).length, 1,
        'a model proposal cannot become evidence of a real encounter');
    const Knowledge = invoke('GameServer/Bot/AI/BotDialogueKnowledge');
    const context = { session: { characterId: 20 }, playerSession: { actor: { fetchId: () => 10 } }, playerMessage: 'Do you remember yesterday\'s raid?' };
    const unknown = await Knowledge.execute({ action: 'recall_event', query: 'raid' }, context);
    assert.strictEqual(unknown.terminalReply, "I don't remember that.");
    const known = await Knowledge.execute({ action: 'recall_event', query: 'goblin' }, context);
    assert.strictEqual(known.rows.length, 1);
    assert(!known.terminalReply);
    const publicHistory = await Knowledge.execute({ action: 'recall_event', query: 'goblin' }, { ...context, publicChat: true });
    assert.strictEqual(publicHistory.rows.length, 0, 'public answers cannot use a private pair event');

    const { DatabaseSync } = require('node:sqlite');
    const Database = invoke('Database');
    const saved = { ready: Database.isReady, execute: Database.execute };
    const sql = new DatabaseSync(':memory:');
    sql.exec(`CREATE TABLE bot_activity_journal(id INTEGER PRIMARY KEY, playerId INTEGER, botId INTEGER,
        eventType TEXT, summary TEXT, weight INTEGER, dedupeKey TEXT, count INTEGER, createdAt INTEGER,
        updatedAt INTEGER, metaJson TEXT);`);
    const insert = sql.prepare('INSERT INTO bot_activity_journal VALUES (?, ?, ?, ?, ?, 1, NULL, 1, 1, 1, NULL)');
    insert.run(1, 10, 20, 'drop', 'Received 100% Coal');
    insert.run(2, 11, 20, 'drop', 'Received private Coal');
    insert.run(3, null, 20, 'level_up', 'Coal hunting level-up');
    insert.run(4, 10, 20, 'llm_decision', 'Received invented Coal');
    Database.isReady = () => true;
    Database.execute = async ([statement, args]) => sql.prepare(statement).all(...args);
    BotEventJournal.resetMemory();
    try {
        assert.deepStrictEqual((await BotEventJournal.search({ botId: 20, playerId: 10, query: 'Coal' })).map(row => row.id), [1, 3]);
        assert.deepStrictEqual((await BotEventJournal.search({ botId: 20, playerId: 10, query: '100%' })).map(row => row.id), [1],
            'wildcards in a model query are literal search text');
        assert.deepStrictEqual((await BotEventJournal.search({ botId: 20, query: 'Coal' })).map(row => row.id), [3]);
    } finally {
        Database.isReady = saved.ready; Database.execute = saved.execute;
        BotEventJournal.resetMemory(); sql.close();
    }
    console.log('Bot activity journal checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
