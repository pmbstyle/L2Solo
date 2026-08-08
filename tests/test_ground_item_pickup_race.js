const assert = require('assert');

require('../src/Global');

const pickupItem = invoke('GameServer/World/Generics/PickupItem');
const PartyCompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const ConsoleText = invoke('GameServer/ConsoleText');

const originalAdenaAllocations = PartyCompanionService.adenaAllocations;
const originalTransmit = ConsoleText.transmit;

try {
    const pickupMessages = [];
    const deletedObjects = [];
    const purchases = [];
    const playerSession = {
        accountId: 'player',
        dataSendToMe(packet) { pickupMessages.push({ session: this, packet }); },
        dataSendToMeAndOthers(packet, item) { deletedObjects.push({ session: this, packet, item }); }
    };
    const botSession = {
        accountId: 'bot',
        dataSendToMe(packet) { pickupMessages.push({ session: this, packet }); },
        dataSendToMeAndOthers(packet, item) { deletedObjects.push({ session: this, packet, item }); }
    };
    const groundAdena = {
        fetchId: () => 700001,
        fetchSelfId: () => 57,
        fetchAmount: () => 40
    };
    const world = {
        items: { spawns: [groundAdena] },
        purchaseItem(session, selfId, amount) { purchases.push({ session, selfId, amount }); }
    };

    ConsoleText.transmit = (session, textId, params) => pickupMessages.push({ session, textId, params });
    PartyCompanionService.adenaAllocations = () => [
        { session: playerSession, amount: 20 },
        { session: botSession, amount: 20 }
    ];

    assert.strictEqual(pickupItem.call(world, playerSession, {}, groundAdena), true, 'the first pickup must claim the ground Adena');
    assert.strictEqual(pickupItem.call(world, botSession, {}, groundAdena), false, 'a stale competing pickup must not claim the same ground object twice');
    assert.strictEqual(world.items.spawns.length, 0, 'the claimed ground object must be removed exactly once');
    assert.deepStrictEqual(
        purchases.map(({ session, selfId, amount }) => ({ accountId: session.accountId, selfId, amount })),
        [
            { accountId: 'player', selfId: 57, amount: 20 },
            { accountId: 'bot', selfId: 57, amount: 20 }
        ],
        'a 40 Adena party drop must produce one 20/20 allocation, not two duplicate allocations'
    );
    assert.strictEqual(pickupMessages.length, 2, 'each recipient must see one pickup message only');
    assert.strictEqual(deletedObjects.length, 1, 'the ground object deletion must be broadcast only by the winning pickup');

    const groundSaber = {
        fetchId: () => 700002,
        fetchSelfId: () => 123,
        fetchAmount: () => 1
    };
    world.items.spawns.push(groundSaber);
    assert.strictEqual(pickupItem.call(world, playerSession, {}, groundSaber), true, 'the normalized weapon drop must be picked up');
    const saberMessage = pickupMessages.at(-1);
    assert.strictEqual(saberMessage.textId, ConsoleText.caption.pickup, 'a single weapon must use the pickup message without an xN amount');
    assert.strictEqual(saberMessage.params.length, 1, 'a single weapon pickup message must contain only the item name');
} finally {
    PartyCompanionService.adenaAllocations = originalAdenaAllocations;
    ConsoleText.transmit = originalTransmit;
}

console.log('Ground item pickup race checks passed');
