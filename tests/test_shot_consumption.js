const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Database = invoke('Database');

Database.updateItemAmount = () => Promise.resolve();
Database.deleteItem = () => Promise.resolve();

function item(id, data) {
    return new Item(id, {
        selfId: data.selfId,
        kind: data.kind,
        amount: data.amount,
        equipped: data.equipped || false,
        slot: data.slot || 0,
        soulshot: data.soulshot || 0,
        spiritshot: data.spiritshot || 0,
        rank: data.rank || 'none'
    });
}

function sessionFor(backpack, classId = 0) {
    const actor = {
        backpack,
        fetchId: () => 2000001,
        fetchClassId: () => classId,
        fetchLocX: () => 100,
        fetchLocY: () => 200,
        fetchLocZ: () => -300,
        isDead: () => false
    };
    return {
        actor,
        packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
}

const soulBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
soulBackpack.items = [
    item(1, { selfId: 1, kind: 'Weapon.Sword', equipped: true, slot: 7, soulshot: 2, rank: 'none' }),
    item(2, { selfId: 1835, kind: 'Other.Shot', amount: 5 })
];
let consumed = false;
soulBackpack.consumeSoulshot(sessionFor(soulBackpack), (ok) => { consumed = ok; });
assert.strictEqual(consumed, true, 'soulshot should consume when enough shots exist');
assert.strictEqual(soulBackpack.fetchItemFromSelfId(1835).fetchAmount(), 3, 'soulshot consume should use weapon shot cost');

const lowBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
lowBackpack.items = [
    item(3, { selfId: 1, kind: 'Weapon.Sword', equipped: true, slot: 7, soulshot: 3, rank: 'none' }),
    item(4, { selfId: 1835, kind: 'Other.Shot', amount: 2 })
];
consumed = true;
lowBackpack.consumeSoulshot(sessionFor(lowBackpack), (ok) => { consumed = ok; });
assert.strictEqual(consumed, false, 'soulshot should not charge when stack is below weapon shot cost');
assert.strictEqual(lowBackpack.fetchItemFromSelfId(1835).fetchAmount(), 2, 'failed charge should not delete remaining shots');

const zeroCostBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
zeroCostBackpack.items = [
    item(7, { selfId: 1, kind: 'Weapon.Sword', equipped: true, slot: 7, soulshot: 0, rank: 'none' }),
    item(8, { selfId: 1835, kind: 'Other.Shot', amount: 5 })
];
consumed = true;
const zeroCostSession = sessionFor(zeroCostBackpack);
zeroCostBackpack.consumeSoulshot(zeroCostSession, (ok) => { consumed = ok; });
assert.strictEqual(consumed, false, 'soulshot should not charge for weapons with explicit zero shot cost');
assert.strictEqual(zeroCostBackpack.fetchItemFromSelfId(1835).fetchAmount(), 5, 'zero-cost weapon should not consume shots');
zeroCostBackpack.useItem(zeroCostSession, 8);
assert.strictEqual(zeroCostSession.actor.soulshotLoaded, undefined, 'manual use should not load soulshot for zero-cost weapons');
assert.strictEqual(zeroCostBackpack.fetchItemFromSelfId(1835).fetchAmount(), 5, 'manual zero-cost charge should not consume shots');

const spiritBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
spiritBackpack.items = [
    item(5, { selfId: 10, kind: 'Weapon.Blunt', equipped: true, slot: 7, spiritshot: 2, rank: 'none' }),
    item(6, { selfId: 2509, kind: 'Other.Shot', amount: 4 })
];
consumed = false;
spiritBackpack.consumeSpiritshot(sessionFor(spiritBackpack, 0), (ok) => { consumed = ok; });
assert.strictEqual(consumed, true, 'spiritshot should consume for magic skills even when class role is not caster');
assert.strictEqual(spiritBackpack.fetchItemFromSelfId(2509).fetchAmount(), 2, 'spiritshot consume should use weapon shot cost');

const apprenticeWandTemplate = DataCache.items.find((entry) => entry.selfId === 6);
const apprenticeRodTemplate = DataCache.items.find((entry) => entry.selfId === 7);
assert.strictEqual(apprenticeWandTemplate.etc.spiritshot, 1, 'Apprentice Wand should preserve Lisvus spiritshot cost');
assert.strictEqual(apprenticeRodTemplate.etc.spiritshot, 1, 'Apprentice Rod should preserve Lisvus spiritshot cost');

const starterMageBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
starterMageBackpack.items = [
    new Item(9, { ...utils.crushOb(apprenticeWandTemplate), equipped: true }),
    item(10, { selfId: 2509, kind: 'Other.Shot', amount: 3 })
];
const starterMageSession = sessionFor(starterMageBackpack, 10);
starterMageBackpack.useItem(starterMageSession, 10);
assert.strictEqual(starterMageSession.actor.spiritshotLoaded, true, 'starter mage weapon should manually load spiritshot');
assert.strictEqual(starterMageBackpack.fetchItemFromSelfId(2509).fetchAmount(), 2, 'starter mage spiritshot use should consume Lisvus weapon cost');
assert(starterMageSession.packets.some((packet) => packet[0] === 0x48 && packet.readInt32LE(9) === 2047), 'starter mage spiritshot use should broadcast no-grade charge animation');

const bGradeSpiritBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
bGradeSpiritBackpack.items = [
    item(11, { selfId: 238, kind: 'Weapon.Blunt', equipped: true, slot: 7, spiritshot: 1, rank: 'b' }),
    item(12, { selfId: 2512, kind: 'Other.Shot', amount: 2 })
];
const bGradeSpiritSession = sessionFor(bGradeSpiritBackpack, 0);
bGradeSpiritBackpack.useItem(bGradeSpiritSession, 12);
assert.strictEqual(bGradeSpiritSession.actor.spiritshotLoaded, true, 'B-grade spiritshot should manually load on a matching weapon');
assert.strictEqual(bGradeSpiritBackpack.fetchItemFromSelfId(2512).fetchAmount(), 1, 'B-grade spiritshot use should consume weapon shot cost');
assert(bGradeSpiritSession.packets.some((packet) => packet[0] === 0x48 && packet.readInt32LE(9) === 2157), 'B-grade spiritshot use should broadcast sourced charge animation');

console.log('Shot consumption checks passed');
