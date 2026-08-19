const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const databasePath = path.join(process.cwd(), 'tmp', 'test-cold-safe-enchant.sqlite');
fs.rmSync(databasePath, { force: true });
fs.rmSync(`${databasePath}-wal`, { force: true });
fs.rmSync(`${databasePath}-shm`, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ColdSafeEnchantService = invoke('GameServer/Bot/Economy/ColdSafeEnchantService');
const BotWarehouseService = invoke('GameServer/Bot/Economy/BotWarehouseService');

DataCache.init();
Database.init();

function fixture(predicate, description) {
    const item = DataCache.items.find(predicate);
    assert(item, `missing ${description} fixture`);
    return item;
}

(async () => {
    await Database.createAccount('cold_safe_enchant', 'secret');
    await Database.createCharacter('cold_safe_enchant', {
        name: 'SafeEnchantProbe', race: 0, classId: 0,
        maxHp: 300, maxMp: 120, sex: 0, face: 0, hair: 0, hairColor: 0,
        locX: 81500, locY: 148500, locZ: -3470
    });
    const [character] = await Database.fetchCharacters('cold_safe_enchant');
    assert(character?.id);
    assert.strictEqual(await LifeState.init(), true);

    const weapon = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Weapon.')
        && Number(item?.etc?.slot || 0) > 0, 'D-grade weapon');
    const armor = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Armor.')
        && !String(item?.template?.kind || '').includes('Jewel')
        && Number(item?.etc?.slot || 0) > 0
        && Number(item.etc.slot) !== 15, 'D-grade armor');
    const fullArmor = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Armor.')
        && Number(item?.etc?.slot || 0) === 15, 'D-grade full armor');
    const jewel = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').includes('Jewel')
        && Number(item?.etc?.slot || 0) > 0, 'D-grade jewelry');
    const spareArmor = fixture((item) => item?.etc?.rank === 'd'
        && String(item?.template?.kind || '').startsWith('Armor.')
        && Number(item.selfId) !== Number(armor.selfId)
        && Number(item.selfId) !== Number(fullArmor.selfId), 'unequipped D-grade armor');

    const rows = [];
    async function insert(item, { enchant = 0, equipped = true, slot = item.etc.slot } = {}) {
        const result = await Database.setItem(character.id, {
            selfId: item.selfId,
            name: item.template.name,
            amount: 1,
            enchant,
            equipped,
            slot: equipped ? Number(slot || item.etc.slot || 0) : 0
        });
        rows.push({ selfId: Number(item.selfId), id: Number(result.insertId) });
    }
    await insert(weapon, { enchant: 0 });
    await insert(armor, { enchant: 2 });
    await insert(fullArmor, { enchant: 3 });
    await insert(jewel, { enchant: 0 });
    await insert(spareArmor, { enchant: 0, equipped: false });
    await Database.setItem(character.id, {
        selfId: 955, name: 'Scroll: Enchant Weapon (Grade D)', amount: 5,
        enchant: 0, equipped: false, slot: 0
    });
    await Database.setItem(character.id, {
        selfId: 956, name: 'Scroll: Enchant Armor (Grade D)', amount: 8,
        enchant: 0, equipped: false, slot: 0
    });

    const base = await LifeState.upsertState({
        characterId: Number(character.id),
        accountName: 'cold_safe_enchant',
        name: 'SafeEnchantProbe',
        level: 30,
        phase: 'cold',
        activity: 'shopping',
        currentRegion: 'Giran',
        loc: { locX: 81500, locY: 148500, locZ: -3470 },
        vitals: { hp: 300, maxHp: 300, mp: 120, maxMp: 120 },
        timing: { activityStartedAt: Date.now(), nextResolveAt: Date.now() },
        stats: {},
        inventory: {}
    }, 'cold_safe_enchant_fixture');
    const hydrated = await LifeState.refreshInventory(base);
    const persistedBase = await LifeState.upsertState(hydrated, 'cold_safe_enchant_inventory');

    const result = await ColdSafeEnchantService.enchantSafe(persistedBase);
    assert.strictEqual(result.enchanted, true);
    assert.strictEqual(result.operations.length, 8,
        'safe enchanting should consume only the scrolls needed to reach guaranteed levels');

    const physical = await Database.fetchItems(character.id);
    const enchantOf = (item) => Number(physical.find((row) => Number(row.selfId) === Number(item.selfId))?.enchant || 0);
    assert.strictEqual(enchantOf(weapon), 3, 'D weapon must stop at +3');
    assert.strictEqual(enchantOf(armor), 3, 'ordinary D armor must stop at +3');
    assert.strictEqual(enchantOf(fullArmor), 4, 'full-body D armor may use the C4 +4 safe point');
    assert.strictEqual(enchantOf(jewel), 3, 'D jewelry must stop at +3');
    assert.strictEqual(enchantOf(spareArmor), 0, 'unequipped gear must not consume scrolls');
    assert.strictEqual(Number(physical.find((row) => Number(row.selfId) === 955)?.amount || 0), 2);
    assert.strictEqual(Number(physical.find((row) => Number(row.selfId) === 956)?.amount || 0), 3);

    const second = await ColdSafeEnchantService.enchantSafe(result.state);
    assert.strictEqual(second.enchanted, false, 'already safe equipment must not consume more scrolls');
    assert.strictEqual(second.operations.length, 0);
    assert.strictEqual(result.state.stats.lastSafeEnchant.operations, 8);

    const weaponRow = physical.find((row) => Number(row.selfId) === Number(weapon.selfId));
    const deposited = await BotWarehouseService.depositCold(second.state);
    assert(deposited.items.some((item) => item.selfId === 955 && item.amount === 2),
        'unused D weapon scrolls should enter the normal warehouse lifecycle');
    await Database.execute(['UPDATE items SET enchant = 0 WHERE id = ? AND characterId = ?', [weaponRow.id, character.id]]);
    const resetState = await LifeState.refreshInventory(deposited.state);
    const huntingState = await LifeState.upsertState({
        ...resetState,
        activity: 'hunting',
        timing: { ...(resetState.timing || {}), nextResolveAt: Date.now() }
    }, 'cold_safe_enchant_warehouse_fixture');
    const released = await BotWarehouseService.releaseCold(huntingState);
    assert.strictEqual(released.released, true);
    assert.deepStrictEqual(released.items.map((item) => [item.selfId, item.amount, item.reason]), [[955, 2, 'enchant']],
        'warehouse scrolls must return only for an actual safe enchant need');
    const afterRelease = await Database.fetchItems(character.id);
    assert.strictEqual(Number(afterRelease.find((row) => Number(row.selfId) === Number(weapon.selfId))?.enchant || 0), 2,
        'released warehouse scrolls must be consumed immediately without a second town loop');
    assert.strictEqual(afterRelease.some((row) => Number(row.selfId) === 955), false);

    console.log('Cold safe enchant checks passed');
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    await Database.close().catch(() => null);
    fs.rmSync(databasePath, { force: true });
    fs.rmSync(`${databasePath}-wal`, { force: true });
    fs.rmSync(`${databasePath}-shm`, { force: true });
});
