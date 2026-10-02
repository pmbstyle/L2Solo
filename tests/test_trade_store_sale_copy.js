const assert = require('assert');
require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const Database = invoke('Database');
const TradeService = invoke('GameServer/Bot/TradeService');
const Item = invoke('GameServer/Item/Item');

const RING = 881;

function item(id, selfId, amount, equipped, name) {
    return new Item(id, {
        selfId,
        name,
        kind: selfId === 57 ? 'Other.Currency' : 'Armor.Jewel',
        amount,
        stackable: selfId === 57,
        equipped,
        slot: selfId === 57 ? 0 : 4
    });
}

function seller(items) {
    return {
        fetchId: () => 9001,
        backpack: {
            items,
            fetchItems() { return this.items; },
            fetchItemFromSelfId(selfId) { return this.items.find((entry) => Number(entry.fetchSelfId()) === Number(selfId)); },
            stackableExists(selfId) {
                const found = this.fetchItemFromSelfId(selfId);
                return found ? Promise.resolve(found) : Promise.reject(new Error('missing_stack'));
            },
            updateAmount(id, amount) {
                this.items.find((entry) => Number(entry.fetchId()) === Number(id))?.setAmount(amount);
            }
        }
    };
}

async function main() {
    const originalItems = DataCache.items;
    const originals = { updateItemAmount: Database.updateItemAmount, deleteItem: Database.deleteItem };
    const deleted = [];
    try {
        DataCache.items = [
            { selfId: RING, template: { name: 'Elven Ring' }, etc: { stackable: false } },
            { selfId: 57, template: { name: 'Adena' }, etc: { stackable: true } }
        ];
        Database.updateItemAmount = async () => {};
        Database.deleteItem = async (characterId, objectId) => { deleted.push(Number(objectId)); };

        // Two worn rings (older rows first, as the backpack loads them) and a spare.
        const hotBot = seller([
            item(101, RING, 1, true, 'Elven Ring'),
            item(102, RING, 1, true, 'Elven Ring'),
            item(103, RING, 1, false, 'Elven Ring'),
            item(104, 57, 5000, false, 'Adena')
        ]);
        const store = { storeType: 3, items: [{ selfId: RING, price: 116501, count: 1 }] };
        const preview = TradeService.previewSaleToStore(hotBot, store);
        assert.deepStrictEqual(preview.lines.map((line) => line.objectId), [103], 'the preview offers only the spare');
        const sale = await TradeService.sellInventoryToStore(hotBot, store);
        assert.strictEqual(sale.itemsSold, 1);
        assert.deepStrictEqual(deleted, [103], 'the sold row is the spare, not a worn ring');
        assert.deepStrictEqual(hotBot.backpack.items.filter((entry) => entry.fetchSelfId() === RING)
            .map((entry) => [entry.fetchId(), entry.fetchEquipped()]), [[101, true], [102, true]]);
        assert.strictEqual(hotBot.backpack.fetchItemFromSelfId(57).fetchAmount(), 5000 + 116501);

        // The player's sale names the exact copy it offers.
        deleted.length = 0;
        const player = seller([
            item(201, RING, 1, false, 'Elven Ring'),
            item(202, RING, 1, false, 'Elven Ring'),
            item(203, 57, 10, false, 'Adena')
        ]);
        await TradeService.sellToStore(player, { storeType: 3, items: [{ selfId: RING, price: 100, count: 1 }] },
            RING, 1, { objectId: 202 });
        assert.deepStrictEqual(deleted, [202], 'the chosen copy is sold, not the first one');

        // Only worn copies left: nothing to sell.
        const wornOnly = seller([item(301, RING, 1, true, 'Elven Ring'), item(302, 57, 10, false, 'Adena')]);
        await assert.rejects(TradeService.sellToStore(wornOnly,
            { storeType: 3, items: [{ selfId: RING, price: 100, count: 1 }] }, RING, 1), /No items to sell/);
        assert.strictEqual(wornOnly.backpack.items.length, 2);
    } finally {
        DataCache.items = originalItems;
        Object.assign(Database, originals);
    }
    console.log('Trade store sale copy tests passed');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
