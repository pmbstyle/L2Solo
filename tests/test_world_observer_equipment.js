const assert = require('assert');

require('../src/Global');

const Observer = invoke('WorldObserver/WorldObserverServer');

const sword = Observer.compactItem({
    selfId: 1,
    name: 'Short Sword',
    slotId: 7,
    slot: 'weapon',
    rank: 'd',
    kind: 'Weapon.Sword',
    enchant: 3,
    stats: { pAtk: 17, pAtkRnd: 3, mAtk: 8, atkSpd: 379 }
});

assert.strictEqual(sword.slotId, 7, 'observer equipment should preserve the numeric paperdoll slot');
assert.strictEqual(sword.enchant, 3, 'observer equipment should preserve enchant level');
assert.deepStrictEqual(sword.stats, {
    pAtk: 17,
    pAtkRnd: 3,
    mAtk: 8,
    atkSpd: 379,
    pDef: 0,
    mDef: 0,
    evasion: 0,
    critical: 0,
    accuracy: 0,
    shieldRate: 0,
    bonusMp: 0,
    consumedMp: 0
}, 'observer equipment should expose item-level combat stats for the tooltip');

const catalog = Observer.itemIconCatalogStatus();
if (catalog.available) {
    assert.ok(sword.iconUrl?.includes('/observer/item-icons/'), 'catalog-backed equipment should expose a local icon route');
    assert.strictEqual(sword.iconSource, 'l2hub', 'the regular C4 icon should come from l2hub');
    assert.ok(require('fs').existsSync(Observer.itemIconFilePath('weapon_small_sword_i00.png')), 'the local icon route should resolve a catalog file');
    assert.strictEqual(Observer.itemIconFilePath('../index.json'), null, 'the local icon route should reject traversal');

    const fallback = Observer.compactItem({
        selfId: 1299,
        name: 'Great Sword',
        slot: 14,
        kind: 'Weapon.Dual',
        stats: { pAtk: 100 }
    });
    assert.ok(fallback.iconUrl?.endsWith('Weapon_2hs03.jpg'), 'legacy broken icons should use the documented fallback mirror');
    assert.strictEqual(fallback.iconSource, 'elmorelab-c4-mirror');
}

console.log(`World observer equipment checks passed (${catalog.available ? `${catalog.itemCount} catalog items` : 'catalog unavailable'})`);
