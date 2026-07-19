const assert = require('assert');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const ManufactureShop = invoke('GameServer/Crafting/ManufactureShop');
const BasicAction = invoke('GameServer/Actor/Generics/BasicAction');
const Select = invoke('GameServer/Actor/Generics/Select');
const BotManager = invoke('GameServer/Bot/BotManager');
const recipeShopMakeItem = invoke('GameServer/Network/Request/RecipeShopMakeItem');
const recipeShopManagePrev = invoke('GameServer/Network/Request/RecipeShopManagePrev');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');

function item(id, selfId, amount) {
    return {
        id,
        selfId,
        amount,
        fetchId: () => id,
        fetchSelfId: () => selfId,
        fetchAmount: () => amount,
        setAmount: (value) => { amount = value; },
        fetchEquipped: () => false,
        fetchClass1: () => 4,
        fetchClass2: () => 0,
        fetchSlot: () => 0
    };
}

function actor(id, items, options = {}) {
    let mp = options.mp ?? 50;
    let storeType = options.storeType ?? 0;
    let replenishes = 0;
    let destinationId = 0;
    return {
        model: {},
        backpack: {
            items,
            fetchItems() { return this.items; },
            fetchTotalAdena: () => items.find((entry) => entry.fetchSelfId() === 57)?.fetchAmount() || 0,
            fetchDwarvenCraftLevel: () => 1,
            fetchRecipeBook: () => [{ recipeId: 1 }]
        },
        fetchId: () => id,
        fetchName: () => `CraftTest${id}`,
        fetchTitle: () => '',
        fetchKarma: () => 0,
        fetchPvpFlag: () => 0,
        fetchMp: () => mp,
        fetchMaxMp: () => 100,
        setMp: (value) => { mp = value; },
        fetchPrivateStoreType: () => storeType,
        setPrivateStoreType: (value) => { storeType = value; },
        fetchDestId: () => destinationId,
        setDestId: (value) => { destinationId = value; },
        fetchLocX: () => options.x ?? 0,
        fetchLocY: () => options.y ?? 0,
        isDead: () => false,
        statusUpdateVitals: () => {},
        automation: { replenishVitals: () => { replenishes += 1; } },
        fetchReplenishes: () => replenishes
    };
}

function session(actor) {
    const packets = [];
    return {
        actor,
        packets,
        dataSendToMe: (packet) => packets.push(packet),
        dataSendToMeAndOthers: (packet) => packets.push(packet)
    };
}

const originalCraftForCustomer = Database.craftForCustomer;
const originalItems = DataCache.items;
const originalUser = World.user;
const originalOpen = ManufactureShop.open;
const originalBotSessions = BotManager.sessions;

async function run() {
    DataCache.items = [
        { selfId: 17, template: { name: 'Wooden Arrow' }, etc: { stackable: true } },
        { selfId: 57, template: { name: 'Adena' }, etc: { stackable: true } }
    ];

    const crafter = actor(100, [item(30, 57, 50)], { storeType: 5, mp: 50 });
    const customer = actor(200, [item(10, 1864, 4), item(11, 1869, 2), item(12, 57, 1000)]);
    const crafterSession = session(crafter);
    const customerSession = session(customer);
    World.user = { sessions: [crafterSession, customerSession] };
    ManufactureShop.shop(crafter).entries = [{ recipeId: 1, price: 100 }];

    const persisted = [];
    Database.craftForCustomer = (_crafterId, _customerId, exchange) => {
        persisted.push(exchange);
        return Promise.resolve({
            sources: exchange.materials.map((material) => ({ id: material.id, amount: 0 })),
            product: exchange.product ? { id: 1017, amount: exchange.product.amount } : null,
            customerAdena: { id: 12, amount: 900 },
            crafterAdena: { id: 30, amount: 150 }
        });
    };

    assert.strictEqual(ManufactureShop.makeInfo(customerSession, 100, 1), true, 'Customer should receive native manufacture make-info for an advertised recipe');
    assert.strictEqual(customerSession.packets.at(-1)[0], 0xda, 'Manufacture make-info must use C4 RecipeShopItemInfo');
    assert.strictEqual(customerSession.packets.at(-1).readInt32LE(17), -1, 'Make-info must report pending C4 status');

    assert.strictEqual(await ManufactureShop.craft(customerSession, 100, 1, () => 0), true, 'A nearby customer with materials and Adena must craft through the dwarf');
    assert.strictEqual(crafter.fetchMp(), 20, 'Dwarf MP must be charged for a manufacture order');
    assert.strictEqual(crafter.fetchReplenishes(), 1, 'A manufacture order must restart normal MP regeneration for a standing crafter');
    assert.strictEqual(customer.backpack.fetchItems().find((entry) => entry.fetchSelfId() === 57).fetchAmount(), 900, 'Customer must pay the advertised fee');
    assert.strictEqual(crafter.backpack.fetchItems().find((entry) => entry.fetchSelfId() === 57).fetchAmount(), 150, 'Dwarf must receive the advertised fee');
    assert.strictEqual(customer.backpack.fetchItems().find((entry) => entry.fetchId() === 1017)?.fetchAmount(), 500, 'Customer must receive the crafted product');
    assert.strictEqual(persisted[0].price, 100, 'The durable exchange must include the advertised fee');
    assert.strictEqual(customerSession.packets.at(-1)[0], 0xda, 'Manufacture result must use C4 RecipeShopItemInfo');
    assert.strictEqual(customerSession.packets.at(-1).readInt32LE(17), 1, 'Successful manufacture must report status 1');

    const stationCrafter = actor(101, [item(31, 57, 50)], { storeType: 5, mp: 1 });
    const stationCustomer = actor(201, [item(13, 1864, 4), item(14, 1869, 2), item(15, 57, 1000)]);
    const stationSession = session(stationCrafter);
    stationSession.accountId = 'bot_craft_27';
    const stationCustomerSession = session(stationCustomer);
    World.user = { sessions: [stationSession, stationCustomerSession] };
    ManufactureShop.shop(stationCrafter).entries = [{ recipeId: 1, price: 100 }];
    assert.strictEqual(await ManufactureShop.craft(stationCustomerSession, 101, 1, () => 0), true, 'A public craft station must accept orders even when its displayed MP is low');
    assert.strictEqual(stationCrafter.fetchMp(), 1, 'A public craft station must retain its MP after a customer order');
    assert.strictEqual(persisted.at(-1).crafterMp, 1, 'A public craft station must persist unchanged MP for the order');

    const packet = Buffer.alloc(13);
    packet[0] = 0xb6;
    packet.writeInt32LE(100, 1);
    packet.writeInt32LE(1, 5);
    await recipeShopMakeItem(customerSession, packet);
    assert.strictEqual(customerSession.packets.at(-2)[0], 0xda, 'Opcode 0xB6 must dispatch native manufacture crafting');

    customerSession.viewedPrivateStoreSeller = crafter;
    recipeShopManagePrev(customerSession);
    assert.strictEqual(customerSession.packets.at(-1)[0], 0xd9, 'Opcode 0xB7 must return the customer to the native manufacture list');

    customer.setPrivateStoreType(1);
    assert.strictEqual(await ManufactureShop.craft(customerSession, 100, 1, () => 0), false, 'A customer with an active private store must not manufacture items');
    assert.strictEqual(persisted.length, 2, 'Rejected store-mode customer must not enter the durable exchange');
    customer.setPrivateStoreType(0);

    const list = ServerResponse.recipeShopSellList(crafter, customer);
    assert.strictEqual(list[0], 0xd9, 'Manufacture window must use C4 RecipeShopSellList');
    assert.strictEqual(list.readInt32LE(1), 100, 'Manufacture list must identify its crafter');
    assert.strictEqual(list.readInt32LE(17), 1, 'Manufacture list must advertise configured recipes');

    BotManager.sessions = [{ actor: crafter, plan: 'merchant' }];
    customerSession.packets.length = 0;
    Select(customerSession, customer, { id: crafter.fetchId() });
    Select(customerSession, customer, { id: crafter.fetchId() });
    assert.strictEqual(customerSession.packets.at(-1)[0], 0xd9, 'A merchant-plan bot with manufacture type must open the C4 recipe list, not a generic sale window');
    assert.strictEqual(customerSession.packets.at(-2)[0], 0x25, 'Opening a manufacture list must end the interaction before the C4 window opens');
    assert(!customerSession.packets.some((entry) => entry[0] === 0xdb), 'Opening a manufacture list must not resend its world-state title packet to the customer');

    const commonCrafter = actor(300, []);
    commonCrafter.backpack.fetchRecipeBook = (_actor, type) => type === 'common' ? [{ recipeId: 303 }] : [];
    ManufactureShop.shop(commonCrafter).type = 'common';
    const commonManageList = ServerResponse.recipeShopManageList(commonCrafter);
    assert.strictEqual(commonManageList.readInt32LE(1), 1, 'General Manufacture must identify the common-recipe book to the C4 client');

    const opened = [];
    ManufactureShop.open = (_session, type) => { opened.push(type); return true; };
    const actionActor = { effects: {}, isDead: () => false };
    const actionSession = { dataSendToMe: () => assert.fail('Known manufacture action must not fail') };
    BasicAction(actionSession, actionActor, { actionId: 37 });
    BasicAction(actionSession, actionActor, { actionId: 51 });
    assert.deepStrictEqual(opened, ['dwarven', 'common'], 'C4 Actions must dispatch Dwarven and General Manufacture to their matching shops');

    console.log('Manufacture shop checks passed');
}

run().finally(() => {
    Database.craftForCustomer = originalCraftForCustomer;
    DataCache.items = originalItems;
    World.user = originalUser;
    ManufactureShop.open = originalOpen;
    BotManager.sessions = originalBotSessions;
}).catch((error) => {
    process.exitCode = 1;
    throw error;
});

process.on('exit', () => {
    Database.craftForCustomer = originalCraftForCustomer;
    DataCache.items = originalItems;
    ManufactureShop.open = originalOpen;
    BotManager.sessions = originalBotSessions;
});
