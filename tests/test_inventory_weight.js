const assert = require('node:assert/strict');
require('../src/Global');
const Backpack = invoke('GameServer/Model/Backpack');
const Item = invoke('GameServer/Item/Item');
const Actor = invoke('GameServer/Actor/Actor');
const Generics = invoke(path.actor);
const templates = require('../data/Items/Others/others.json');
const backpack = new Backpack({});
const make = (id, amount) => {
    const template = templates.find(item => item.selfId === id);
    return new Item(id, { ...template.template, ...template.etc, selfId: id, amount });
};
for (const id of [17, 1341, 1342, 1343, 1344, 1345]) {
    const arrows = make(id, 1000);
    backpack.items = [arrows];
    assert.equal(backpack.fetchTotalLoad(), arrows.fetchMass() * 1000);
    arrows.setAmount(999);
    assert.equal(backpack.fetchTotalLoad(), arrows.fetchMass() * 999);
}
const arrows = make(17, 1000);
const sword = new Item(99, { mass: 1600, equipped: true });
backpack.items = [arrows, sword, make(57, 50000)];
assert.equal(backpack.fetchTotalLoad(), 7600, 'stack counts, equipped gear and weightless Adena');
arrows.setAmount(999);
assert.equal(backpack.fetchTotalLoad(), 7594);
backpack.items = [sword];
assert.equal(backpack.fetchTotalLoad(), 1600, 'removing a stack removes its full weight');

const packets = [];
const actor = {
    backpack, session: { dataSendToMe: packet => packets.push(packet) },
    fetchId: () => 1, fetchHp: () => 100, fetchMaxHp: () => 100,
    fetchMp: () => 10, fetchMaxMp: () => 20, fetchMaxLoad: () => 10000
};
const originalRefresh = Generics.calculateStats.refresh;
try {
    Generics.calculateStats.refresh = () => {};
    Actor.prototype.statusUpdateVitals.call(actor, actor);
    const packet = packets[0], fields = new Map();
    assert.equal(packet[0], 0x0e);
    for (let i = 0; i < packet.readInt32LE(5); i++)
        fields.set(packet.readInt32LE(9 + i * 8), packet.readInt32LE(13 + i * 8));
    assert.equal(fields.get(0x0e), 1600, 'self status update includes current load');
    assert.equal(fields.get(0x0f), 10000);
} finally { Generics.calculateStats.refresh = originalRefresh; }
console.log('Inventory weight: arrow stacks, equipped gear, removal and client load update passed');
