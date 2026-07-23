const assert = require('assert');

require('../src/Global');

const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const ActorGenerics = invoke(path.actor);

const originalCalculateStats = ActorGenerics.calculateStats;
ActorGenerics.calculateStats = () => {};

function item(id, selfId, kind, slot) {
    return new Item(id, {
        selfId,
        kind,
        slot,
        equipped: false,
        pDef: 0,
        mDef: 0,
        evasion: 0,
        maxMp: 0
    });
}

function sessionFor(backpack) {
    const actor = {
        backpack,
        fetchId: () => 2000001,
        isDead: () => false
    };

    return {
        actor,
        dataSendToMe() {},
        dataSendToMeAndOthers() {}
    };
}

function backpack(items) {
    const result = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    result.items = items;
    result.updateDatabaseTimer = () => {};
    return result;
}

try {
    const earrings = backpack([
        item(1, 849, 'Armor.Jewel', 1),
        item(2, 852, 'Armor.Jewel', 1)
    ]);
    const earringSession = sessionFor(earrings);
    earrings.equipGear(earringSession, earrings.fetchItemRaw(1));
    earrings.equipGear(earringSession, earrings.fetchItemRaw(2));
    assert.strictEqual(earrings.fetchItemRaw(1).fetchSlot(), 1, 'first earring should stay in the requested side');
    assert.strictEqual(earrings.fetchItemRaw(2).fetchSlot(), 2, 'second earring should use the free paired side');
    assert.strictEqual(earrings.fetchPaperdollSelfId(2), 852, 'left earring paperdoll slot should be populated');

    const rings = backpack([
        item(3, 881, 'Armor.Jewel', 5),
        item(4, 883, 'Armor.Jewel', 5)
    ]);
    const ringSession = sessionFor(rings);
    rings.equipGear(ringSession, rings.fetchItemRaw(3));
    rings.equipGear(ringSession, rings.fetchItemRaw(4));
    assert.strictEqual(rings.fetchItemRaw(4).fetchSlot(), 4, 'a ring with an occupied left slot should move to the free right slot');
    assert.strictEqual(rings.fetchPaperdollSelfId(4), 883, 'right ring paperdoll slot should be populated');

    const fullBody = backpack([
        item(5, 356, 'Armor.Chain', 15),
        item(6, 2414, 'Armor.Chain', 6)
    ]);
    const fullBodySession = sessionFor(fullBody);
    fullBody.equipGear(fullBodySession, fullBody.fetchItemRaw(5));
    fullBody.equipGear(fullBodySession, fullBody.fetchItemRaw(6));
    assert.strictEqual(fullBody.fetchPaperdollSelfId(6), 2414, 'full-body armor must not clear the head slot');
    assert.strictEqual(fullBody.fetchPaperdollSelfId(10), 356, 'full-body armor should render through the chest slot');
    assert.strictEqual(fullBody.fetchPaperdollSelfId(11), undefined, 'full-body armor must not be duplicated into the pants slot');

    const duplicateWeapons = backpack([
        item(7, 2369, 'Weapon.Sword', 7),
        item(8, 2370, 'Weapon.Blunt', 7)
    ]);
    duplicateWeapons.fetchItemRaw(7).setEquipped(true);
    duplicateWeapons.fetchItemRaw(8).setEquipped(true);
    duplicateWeapons.equipPaperdoll(7, 8, 2370);
    duplicateWeapons.unequipGear(sessionFor(duplicateWeapons), 7);
    assert.strictEqual(duplicateWeapons.fetchItemRaw(7).fetchEquipped(), false, 'unequipping a conflicted weapon slot must clear the hidden weapon too');
    assert.strictEqual(duplicateWeapons.fetchItemRaw(8).fetchEquipped(), false, 'unequipping a conflicted weapon slot must clear the visible weapon');
    assert.strictEqual(duplicateWeapons.fetchPaperdollId(7), undefined, 'unequipping a conflicted weapon slot must clear paperdoll state');

    console.log('Equipment slot checks passed');
} finally {
    ActorGenerics.calculateStats = originalCalculateStats;
}
