const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');

const originalApply = Database.applyBufferedCharacterState;
const originalApplyBatch = Database.applyBufferedCharacterStates;
const originalIsReady = Database.isReady;
const writes = [];

Database.applyBufferedCharacterState = (characterId, state) => {
    writes.push({ characterId, state });
    return Promise.resolve({ characterId });
};
Database.applyBufferedCharacterStates = (entries) => {
    writes.push({ batch: entries });
    return Promise.resolve(entries);
};
Database.isReady = () => true;

(async () => {
    CharacterWriteQueue.experience(42, 20, 1234, 567);
    CharacterWriteQueue.location(42, { locX: 10, locY: 20, locZ: 30, head: 40 });
    CharacterWriteQueue.itemAmount(42, 100, 7);
    CharacterWriteQueue.itemAmount(42, 100, 3);
    CharacterWriteQueue.itemAmount(42, 101, 0);

    await CharacterWriteQueue.flushCharacter(42);

    assert.strictEqual(writes.length, 1, 'one character tick must become one transactional flush');
    assert.deepStrictEqual(writes[0], {
        characterId: 42,
        state: {
            character: { level: 20, exp: 1234, sp: 567, locX: 10, locY: 20, locZ: 30, head: 40 },
            items: {
                100: { id: 100, amount: 3, delete: false },
                101: { id: 101, amount: 0, delete: true }
            }
        }
    });
    assert.strictEqual(CharacterWriteQueue.pendingCount(), 0, 'flushed state must not be written twice');

    CharacterWriteQueue.experience(43, 10, 100, 20);
    CharacterWriteQueue.vitals(44, 50, 50, 30, 30);
    await CharacterWriteQueue.flushAll();
    assert.strictEqual(writes[1].batch.length, 2, 'a timer flush must group all hot characters into one database transaction');
    console.log('character write queue coalescing ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    Database.applyBufferedCharacterState = originalApply;
    Database.applyBufferedCharacterStates = originalApplyBatch;
    Database.isReady = originalIsReady;
});
