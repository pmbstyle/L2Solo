const assert = require('assert');

require('../src/Global');

const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Database = invoke('Database');
const Enchant = invoke('GameServer/Enchant');
const EnchantRules = invoke('GameServer/Items/C4EnchantRules');
const Opcodes = invoke('GameServer/Network/Opcodes');
const ServerResponse = invoke('GameServer/Network/Response');

function item(id, data) {
    return new Item(id, {
        selfId: data.selfId,
        name: data.name || `Item ${data.selfId}`,
        kind: data.kind || 'Other.Material',
        amount: data.amount ?? 1,
        stackable: data.stackable ?? false,
        rank: data.rank || 'none',
        slot: data.slot ?? 0,
        equipped: data.equipped ?? false,
        enchant: data.enchant ?? 0,
        cristals: data.cristals ?? 0,
        pAtk: data.pAtk ?? 0,
        mAtk: data.mAtk ?? 0,
        pDef: data.pDef ?? 0,
        mDef: data.mDef ?? 0
    });
}

function sessionFor(backpack) {
    const packets = [];
    const actor = {
        backpack,
        fetchId: () => 900001,
        fetchName: () => 'EnchantTester',
        fetchPrivateStoreType: () => 0,
        isDead: () => false,
        isSpellcaster: () => 0,
        fetchRace: () => 0,
        fetchSex: () => 0,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchLevel: () => 10,
        fetchExp: () => 0,
        fetchSp: () => 0,
        fetchClassId: () => 0,
        fetchStr: () => 40,
        fetchDex: () => 30,
        fetchCon: () => 43,
        fetchInt: () => 21,
        fetchWit: () => 11,
        fetchMen: () => 25,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        setMaxHp() {},
        setHp() {},
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        setMaxMp() {},
        setMp() {},
        fetchCp: () => 0,
        fetchMaxCp: () => 0,
        setMaxCp() {},
        setCp() {},
        fetchMaxLoad: () => 1000,
        setMaxLoad() {},
        setLoad() {},
        fetchPAtk: () => 1,
        fetchMAtk: () => 1,
        fetchPDef: () => 1,
        fetchMDef: () => 1,
        fetchAccur: () => 1,
        fetchEvasion: () => 1,
        fetchCritical: () => 1,
        fetchAtkSpd: () => 1,
        fetchCastSpd: () => 1,
        fetchWalkSpd: () => 1,
        fetchRunSpd: () => 1,
        fetchCollectivePAtk: () => 1,
        fetchCollectiveAtkSpd: () => 1,
        fetchCollectivePDef: () => 1,
        fetchCollectiveEvasion: () => 1,
        fetchCollectiveAccur: () => 1,
        fetchCollectiveCritical: () => 1,
        fetchCollectiveMAtk: () => 1,
        fetchCollectiveCastSpd: () => 1,
        fetchCollectiveMDef: () => 1,
        fetchCollectiveRunSpd: () => 1,
        fetchCollectiveWalkSpd: () => 1,
        setCollectivePAtk() {},
        setCollectiveAtkSpd() {},
        setCollectivePDef() {},
        setCollectiveEvasion() {},
        setCollectiveAccur() {},
        setCollectiveCritical() {},
        setCollectiveMAtk() {},
        setCollectiveCastSpd() {},
        setCollectiveMDef() {},
        setCollectiveRunSpd() {},
        setCollectiveWalkSpd() {},
        fetchPvpFlag: () => 0,
        fetchKarma: () => 0,
        fetchSwim: () => 0,
        fetchAtkSpdMultiplier: () => 1,
        fetchRadius: () => 1,
        fetchSize: () => 1,
        fetchHair: () => 0,
        fetchHairColor: () => 0,
        fetchFace: () => 0,
        fetchIsGM: () => 0,
        fetchTitle: () => '',
        fetchIsCrafter: () => 0,
        fetchPk: () => 0,
        fetchPvp: () => 0,
        fetchRecRemain: () => 0,
        fetchEvalScore: () => 0,
        fetchMountNpcId: () => 0,
        fetchMounted: () => false,
        mounted: false,
        cubics: new Map(),
        state: {
            fetchCasts: () => false,
            fetchHits: () => false,
            fetchSeated: () => false,
            fetchWalkin: () => false,
            fetchCombats: () => false,
            fetchDead: () => false
        },
        statusUpdateVitals() {}
    };
    return {
        actor,
        packets,
        dataSendToMe(packet) { packets.push(packet); },
        dataSendToOthers(packet) { packets.push(packet); },
        dataSendToMeAndOthers(packet) { packets.push(packet); }
    };
}

function backpackWith(...items) {
    const backpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    backpack.items = items;
    return backpack;
}

assert.strictEqual(EnchantRules.statBonus(item(1, { selfId: 1, kind: 'Weapon.Sword', rank: 'a', enchant: 4 }), 'pAtk'), 20, 'A-grade weapon +4 should add 20 P.Atk');
assert.strictEqual(EnchantRules.statBonus(item(2, { selfId: 2, kind: 'Armor.Chain', rank: 'c', enchant: 4 }), 'pDef'), 6, 'C-grade armor +4 should add the C4 over-enchant P.Def bonus');
assert.strictEqual(EnchantRules.crystalCount(item(3, { selfId: 3, kind: 'Armor.Chain', rank: 'c', cristals: 10, enchant: 1 }), 1), 16, 'C-grade armor +1 should use enchanted crystal count');
assert.strictEqual(typeof Opcodes.table[0x58], 'function', 'C4 RequestEnchantItem opcode 0x58 should be routed');
assert.strictEqual(ServerResponse.enchantResult(1)[0], 0x81, 'C4 EnchantResult should use opcode 0x81');

const originalEnchant = Database.enchantInventoryItem;

async function run() {
    try {
        {
            const scroll = item(101, { selfId: 729, amount: 2, stackable: true });
            const weapon = item(102, { selfId: 1001, kind: 'Weapon.Sword', rank: 'a', pAtk: 100 });
            const backpack = backpackWith(scroll, weapon);
            const session = sessionFor(backpack);
            session.activeEnchantItem = { itemId: 101, selfId: 729, enchantScroll: { grade: 'A', target: 'weapon', scrollType: 'normal' } };
            Database.enchantInventoryItem = async () => ({ result: 'success', scrollAmount: 1, targetId: 102, enchant: 1 });

            const result = await Enchant.enchant(session, 102, { rng: () => 0 });
            assert.strictEqual(result.result, 'success', 'successful enchant should report success');
            assert.strictEqual(weapon.fetchEnchantLevel(), 1, 'successful enchant should increment item enchant');
            assert.strictEqual(scroll.fetchAmount(), 1, 'successful enchant should consume exactly one scroll');
            assert.strictEqual(session.activeEnchantItem, null, 'successful enchant should clear active scroll');
            assert.strictEqual(session.packets.some((packet) => packet[0] === 0x81 && packet.readInt32LE(1) === 0), true, 'success should send EnchantResult(0)');
            assert.strictEqual(session.packets.some((packet) => packet[0] === 0x03), true, 'success should refresh CharInfo for visible observers');
        }

        {
            const scroll = item(201, { selfId: 6570, amount: 1, stackable: true });
            const armor = item(202, { selfId: 1002, kind: 'Armor.Chain', rank: 'a', pDef: 100, enchant: 3 });
            const backpack = backpackWith(scroll, armor);
            const session = sessionFor(backpack);
            session.activeEnchantItem = { itemId: 201, selfId: 6570, enchantScroll: { grade: 'A', target: 'armor', scrollType: 'blessed' } };
            Database.enchantInventoryItem = async () => ({ result: 'blessed-fail', scrollAmount: 0, targetId: 202, enchant: 0 });

            const result = await Enchant.enchant(session, 202, { rng: () => 0.99 });
            assert.strictEqual(result.result, 'blessed-fail', 'blessed failure should preserve the item');
            assert.strictEqual(armor.fetchEnchantLevel(), 0, 'blessed failure should reset enchant to zero');
            assert.strictEqual(backpack.fetchItemRaw(201), undefined, 'blessed failure should consume the scroll');
            assert.strictEqual(backpack.fetchItemRaw(202), armor, 'blessed failure should not destroy the item');
        }

        {
            const scroll = item(301, { selfId: 954, amount: 1, stackable: true });
            const armor = item(302, { selfId: 1003, kind: 'Armor.Chain', rank: 'c', pDef: 100, cristals: 10, enchant: 3, equipped: true, slot: 10 });
            const crystals = item(303, { selfId: 1459, amount: 100, stackable: true });
            const backpack = backpackWith(scroll, armor, crystals);
            backpack.paperdoll[10] = { id: 302, selfId: 1003 };
            const session = sessionFor(backpack);
            session.activeEnchantItem = { itemId: 301, selfId: 954, enchantScroll: { grade: 'C', target: 'armor', scrollType: 'crystal' } };
            Database.enchantInventoryItem = async () => ({
                result: 'break', scrollAmount: 0, targetId: 302, crystalId: 1459,
                crystalItemId: 303, crystalAmount: 23, crystalTotal: 123
            });

            const result = await Enchant.enchant(session, 302, { rng: () => 0.99, safeMax: 0, safeMaxFull: 0 });
            assert.strictEqual(result.result, 'break', 'failed normal enchant should break the item');
            assert.strictEqual(backpack.fetchItemRaw(302), undefined, 'broken item should leave inventory');
            assert.strictEqual(backpack.fetchItemRaw(301), undefined, 'break should consume the scroll');
            assert.strictEqual(crystals.fetchAmount(), 123, 'break should award the C4 crystal return');
            assert.strictEqual(backpack.paperdoll[10].id, undefined, 'broken equipped item should be unequipped');
            assert.strictEqual(session.packets.some((packet) => packet[0] === 0x81 && packet.readInt32LE(1) === 1), true, 'break should send EnchantResult(1)');
        }
    } finally {
        Database.enchantInventoryItem = originalEnchant;
    }
}

run().then(() => console.log('Enchant runtime checks passed'));
