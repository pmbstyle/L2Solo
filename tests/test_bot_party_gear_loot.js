const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const PartyLootAllocator = invoke('GameServer/Bot/Population/PartyLootAllocator');

DataCache.init();

const sword = DataCache.items.find((item) => (
    String(item.etc?.rank).toLowerCase() === 'd'
    && item.template?.kind === 'Weapon.Sword'
    && Number(item.etc?.slot) === 7
));
const bow = DataCache.items.find((item) => (
    String(item.etc?.rank).toLowerCase() === 'd'
    && item.template?.kind === 'Weapon.Bow'
));
assert(sword && bow, 'the C4 datapack must expose representative D-grade party drops');

const tank = {
    characterId: 101,
    name: 'TankNeed',
    level: 20,
    stats: { role: 'tank', equipmentPlan: { target: { selfId: sword.selfId } } },
    inventory: {}
};
const mage = {
    characterId: 102,
    name: 'MageHolder',
    level: 20,
    stats: { role: 'mage' },
    inventory: {}
};
const result = PartyLootAllocator.transferGearDrops([
    {
        state: mage,
        result: { patch: {}, materialize: { items: [{ selfId: sword.selfId, name: sword.template.name, amount: 1, kind: sword.template.kind, rank: sword.etc.rank }] } }
    },
    {
        state: tank,
        result: { patch: {}, materialize: { items: [] } }
    }
]);

assert.strictEqual(result.transfers.length, 1, 'a useful gear drop must be reassigned inside the party');
assert.strictEqual(result.transfers[0].to.characterId, tank.characterId, 'the D sword must go to the tank who planned that upgrade');
assert.strictEqual(result.memberResults[0].result.materialize.items.length, 0, 'the holder must not retain gear that is more useful to another member');
assert.strictEqual(result.memberResults[1].result.materialize.items[0].selfId, sword.selfId, 'the intended recipient must materialize the item directly');
assert.strictEqual(result.memberResults[1].result.patch.stats.partyGearReceived, 1, 'the recipient ledger must record the useful party drop');

const unsuitable = PartyLootAllocator.transferGearDrops([
    {
        state: mage,
        result: { patch: {}, materialize: { items: [{ selfId: bow.selfId, name: bow.template.name, amount: 1, kind: bow.template.kind, rank: bow.etc.rank }] } }
    },
    { state: tank, result: { patch: {}, materialize: { items: [] } } }
]);
assert.strictEqual(unsuitable.transfers.length, 0, 'incompatible equipment must remain with the original loot recipient');
assert.strictEqual(unsuitable.memberResults[0].result.materialize.items[0].selfId, bow.selfId);

console.log('Bot party gear loot checks passed');
