const assert = require('assert');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const Exchange = invoke('GameServer/Clan/ClanWarehouseEquipmentService');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const Backpack = invoke('GameServer/Actor/Backpack');

// Shots are bought, never granted: a clan warehouse exchange restocks like any
// other weapon change, and only for a weapon.
async function main() {
    DataCache.init();
    const sword = DataCache.items.find((item) => item.etc?.rank === 'd' && item.template?.kind === 'Weapon.Sword' && item.etc?.slot === 7);
    assert(sword);
    const originals = [];
    function stub(object, name, replacement) {
        const original = object[name];
        originals.push(() => { object[name] = original; });
        object[name] = replacement;
    }
    const writes = [];
    stub(Database, 'setItem', (characterId, item) => { writes.push({ characterId, ...item }); return Promise.resolve({ insertId: 9001 }); });
    stub(Database, 'updateItemAmount', (characterId, itemId, amount) => { writes.push({ characterId, itemId, amount }); return Promise.resolve(); });
    const backpack = (items = []) => new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items });
    const actor = (id, bag) => ({ backpack: bag, fetchId: () => id, fetchLevel: () => 25, fetchClassId: () => 0, fetchName: () => `Gear${id}` });
    try {
        // A member without adena gets no free shots.
        const poor = actor(31, backpack());
        poor.backpack.insertItem(501, Number(sword.selfId), { amount: 1 });
        poor.backpack.equipPaperdoll(7, 501, Number(sword.selfId));
        await ShotStock.restockAfterWeaponChange(poor, [7]);
        assert.strictEqual(ShotStock.shotAmount(poor), 0, 'a member without adena must not receive free shots');
        assert.strictEqual(writes.length, 0, `no shot or adena row may be written, got ${JSON.stringify(writes)}`);

        // Armour does not change the shot grade: nothing is bought.
        const rich = actor(32, backpack([{ id: 601, selfId: 57, amount: 1000000 }]));
        rich.backpack.insertItem(502, Number(sword.selfId), { amount: 1 });
        rich.backpack.equipPaperdoll(7, 502, Number(sword.selfId));
        await ShotStock.restockAfterWeaponChange(rich, [10]);
        assert.strictEqual(writes.length, 0, 'an armour change must not touch shots');

        // A weapon change buys the restock with the member's adena.
        await ShotStock.restockAfterWeaponChange(rich, [7]);
        assert(Number(rich.backpack.fetchItemFromSelfId(57).fetchAmount()) < 1000000, 'the restock is paid from the member adena');
        assert(ShotStock.shotAmount(rich) > 0, 'the bought shots are in the bag');

        // The warehouse exchange goes through the same restock.
        const restocks = [];
        stub(ShotStock, 'restockAfterWeaponChange', (target, slots) => { restocks.push(slots); return Promise.resolve(); });
        stub(invoke(global.path.actor), 'calculateStats', () => {});
        stub(invoke('GameServer/Skills/ToggleSkills'), 'syncEquipment', () => {});
        stub(invoke('GameServer/Network/Response'), 'itemsList', () => Buffer.alloc(0));
        stub(invoke('GameServer/Network/Response'), 'charInfo', () => Buffer.alloc(0));
        const receiver = actor(33, backpack());
        Exchange.publish({ actor: receiver, dataSendToMe() {}, dataSendToOthers() {} }, {
            returned: [], slot: 7,
            received: { id: 503, selfId: Number(sword.selfId), amount: 1, enchant: 0, equipped: true, slot: 7 }
        });
        assert.deepStrictEqual(restocks, [[7]], 'the clan exchange must use the bought restock');
        console.log('Clan warehouse gear shot checks passed');
    } finally {
        originals.reverse().forEach((restore) => restore());
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
