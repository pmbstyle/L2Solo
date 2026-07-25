const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const CharacterWriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
const databasePath = path.join(process.cwd(), 'tmp', 'test-sqlite-account-casefold.sqlite');

fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);

Database.init();

(async () => {
    await Database.createAccount('PlayerOne', 'secret');
    const account = (await Database.fetchUserPassword('PLAYERONE'))[0];
    assert.deepStrictEqual(account, { username: 'PlayerOne', password: 'secret' }, 'account lookup must preserve MariaDB-style case-insensitive logins');
    await assert.rejects(Database.createAccount('playerone', 'other'), /UNIQUE constraint failed/, 'case variants must not create separate accounts');

    await Database.createCharacter('playerone', {
        name: 'CasefoldProbe', race: 0, classId: 0, maxHp: 50, maxMp: 25,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0
    });
    const character = (await Database.fetchCharacters('PLAYERONE'))[0];
    assert.strictEqual(character.username, 'PlayerOne', 'new character must reference the canonical account name');

    const inserted = await Database.setItem(character.id, { selfId: 57, name: 'Adena', amount: 10 });
    CharacterWriteQueue.itemAmount(character.id, inserted.insertId, 9);
    await Database.updateItemAmount(character.id, inserted.insertId, 4);
    const item = (await Database.fetchItems(character.id))[0];
    assert.strictEqual(item.amount, 4, 'a direct inventory update must run after pending buffered writes');

    console.log('sqlite casefold and buffered-write barrier ok');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
