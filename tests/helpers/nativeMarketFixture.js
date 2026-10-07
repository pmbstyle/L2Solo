'use strict';
const assert = require('node:assert/strict');
// Native schema/account/character creation; only the declared fixture identity is remapped before any items/life rows.
async function character(Database, id, name, accountName, loc = {}) {
    await Database.createAccount(accountName, 'fixture-password');
    const created = await Database.createCharacter(accountName, { name, race: 0, classId: 0,
        maxHp: 100, maxMp: 100, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: loc.locX ?? 83000, locY: loc.locY ?? 148000, locZ: loc.locZ ?? -3400 });
    await Database.execute(['UPDATE characters SET id = ? WHERE id = ?', [id, Number(created.insertId)]]);
    const rows = await Database.fetchCharacterName(name);
    assert.equal(Number(rows[0].id), id);
    return id;
}
function amount(rows, selfId) { return rows.filter(row => Number(row.selfId) === selfId).reduce((n,row) => n + Number(row.amount), 0); }
module.exports = { character, amount };
