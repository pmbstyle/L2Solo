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
    console.log('Bot activity journal checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
