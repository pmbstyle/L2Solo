const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const Actor = invoke('GameServer/Actor/Actor');
const AdminShop = invoke('GameServer/World/Generics/NpcBypasses/AdminShop');
const AdminSetLevel = invoke('GameServer/World/Generics/NpcBypasses/AdminSetLevel');

const armors = require('../data/Items/Armors/armors.json');
const weapons = require('../data/Items/Weapons/weapons.json');
const others = require('../data/Items/Others/others.json');
const adminShop = require('../data/Admin/Shop/shop.json');

DataCache.items = [...armors, ...weapons, ...others];
DataCache.adminShop = adminShop;
DataCache.experience = require('../data/Templates/Experience/experience.json');

const adminHtml = utils.parseRawFile('data/Html/Admin/main.html');
const adminShopHtml = utils.parseRawFile('data/Html/Admin/shop.html');
assert.ok(adminHtml.includes('html Admin/shop'), 'admin panel should link to the paged equipment shop');
assert.ok(!adminHtml.includes('admin-shop armor-all'), 'admin panel should not expose crash-prone full armor lists');
assert.ok(!adminHtml.includes('admin-shop weapon-all'), 'admin panel should not expose crash-prone full weapon lists');
assert.ok(adminShopHtml.includes('admin-shop armor-s'), 'equipment shop should expose armor grade links');
assert.ok(adminShopHtml.includes('admin-shop weapon-s'), 'equipment shop should expose weapon grade links');
assert.ok(adminShopHtml.includes('admin-shop supply-crystals'), 'equipment shop should expose crystal supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-soulshots'), 'equipment shop should expose soulshot supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-spiritshots'), 'equipment shop should expose spiritshot supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-blessed-spiritshots'), 'equipment shop should expose blessed spiritshot supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-arrows'), 'equipment shop should expose arrow supplies');
assert.ok(adminHtml.includes('admin-set-level $admin_level'), 'admin panel should submit own level edits');

for (const rank of ['none', 'd', 'c', 'b', 'a', 's']) {
    assert.strictEqual(adminShop[`armor-${rank}`], `armor:${rank}`, `armor-${rank} should resolve from the live armor datapack`);
    assert.strictEqual(adminShop[`weapon-${rank}`], `weapon:${rank}`, `weapon-${rank} should resolve from the live weapon datapack`);
    assert.deepStrictEqual(
        AdminShop.itemIdsForSource(adminShop[`armor-${rank}`]),
        armors.filter((item) => (item.etc?.rank || 'none') === rank).map((item) => item.selfId),
        `armor-${rank} should expose every ${rank} armor item id`
    );
    assert.deepStrictEqual(
        AdminShop.itemIdsForSource(adminShop[`weapon-${rank}`]),
        weapons.filter((item) => (item.etc?.rank || 'none') === rank).map((item) => item.selfId),
        `weapon-${rank} should expose every ${rank} weapon item id`
    );
}
assert.strictEqual(AdminShop.itemIdsForSource('all-armors'), null, 'admin shop should reject old full armor source');
assert.strictEqual(AdminShop.itemIdsForSource('all-weapons'), null, 'admin shop should reject old full weapon source');

const expectedSupplyGroups = {
    'supply-crystals': [1458, 1459, 1460, 1461, 1462],
    'supply-soulshots': [1835, 1463, 1464, 1465, 1466, 1467],
    'supply-spiritshots': [2509, 2510, 2511, 2512, 2513, 2514],
    'supply-blessed-spiritshots': [3947, 3948, 3949, 3950, 3951, 3952],
    'supply-arrows': [17, 1341, 1342, 1343, 1344, 1345]
};
for (const [category, itemIds] of Object.entries(expectedSupplyGroups)) {
    assert.deepStrictEqual(AdminShop.itemIdsForSource(adminShop[category]), itemIds, `${category} should resolve to its explicit item list`);
    itemIds.forEach((selfId) => {
        assert.ok(others.some((item) => item.selfId === selfId), `${category} item ${selfId} should exist in the item datapack`);
    });
}

let adminBuyListPacket = null;
AdminShop({
    actor: { backpack: { fetchTotalAdena: () => 1000000 } },
    dataSendToMe(packet) { adminBuyListPacket = packet; }
}, ['admin-shop', 'supply-soulshots']);

assert.ok(adminBuyListPacket, 'admin shop should send a BuyList packet for supplies');
assert.strictEqual(adminBuyListPacket[0], 0x11, 'admin shop supplies should use the C4 BuyList opcode');
const adminShopRows = new Map();
for (let i = 0; i < adminBuyListPacket.readInt16LE(9); i++) {
    const offset = 11 + (i * 32);
    adminShopRows.set(adminBuyListPacket.readInt32LE(offset + 6), {
        amount: adminBuyListPacket.readInt32LE(offset + 10),
        price: adminBuyListPacket.readInt32LE(offset + 28)
    });
}
assert.strictEqual(adminShopRows.get(1835).amount, 0, 'admin Soulshot stock should be unlimited in BuyList');
assert.strictEqual(adminShopRows.get(1467).amount, 0, 'admin S-grade Soulshot stock should be unlimited in BuyList');
assert.strictEqual(adminShopRows.get(1835).price, 0, 'admin supply prices should be free');

assert.strictEqual(AdminSetLevel.normalizeLevel('1'), 1, 'admin level should accept level 1');
assert.strictEqual(AdminSetLevel.normalizeLevel('75'), 75, 'admin level should accept the configured max level');
assert.strictEqual(AdminSetLevel.normalizeLevel('999'), 75, 'admin level should clamp to max level');
assert.strictEqual(AdminSetLevel.normalizeLevel('0'), 1, 'admin level should clamp to level 1');
assert.strictEqual(AdminSetLevel.normalizeLevel('abc'), null, 'admin level should reject non-numeric input');
assert.strictEqual(AdminSetLevel.expForLevel(1), DataCache.experience[0], 'level 1 exp should use the first threshold');
assert.strictEqual(AdminSetLevel.expForLevel(40), DataCache.experience[39], 'level 40 exp should use its lower threshold');

const statusPacket = ServerResponse.statusUpdate(1001, [
    { id: 0x01, value: 20 },
    { id: 0x02, value: 1242536 },
    { id: 0x11, value: 123 }
]);
assert.strictEqual(statusPacket[0], 0x0e, 'status update should use the StatusUpdate opcode');
assert.strictEqual(statusPacket.readInt32LE(5), 3, 'status update should write the actual stat count');

const fakeActor = {
    fetchLevel: () => 40,
    fetchExp: () => 4555766,
    fetchHp: () => 1200,
    fetchMaxHp: () => 1200,
    fetchMp: () => 333,
    fetchMaxMp: () => 333,
    fetchSp: () => 77,
    backpack: { fetchTotalLoad: () => 250 },
    fetchMaxLoad: () => 69000,
    fetchCollectivePAtk: () => 321,
    fetchCollectiveAtkSpd: () => 379,
    fetchCollectivePDef: () => 222,
    fetchCollectiveEvasion: () => 41.7,
    fetchCollectiveAccur: () => 52.2,
    fetchCollectiveCritical: () => 88.8,
    fetchCollectiveMAtk: () => 144,
    fetchCollectiveCastSpd: () => 250,
    fetchCollectiveMDef: () => 199,
    fetchPvpFlag: () => 0,
    fetchKarma: () => 0,
    fetchCp: () => 0,
    fetchMaxCp: () => 0
};
const adminLevelStatus = AdminSetLevel.levelStatusParams(fakeActor);
assert.deepStrictEqual(
    adminLevelStatus.slice(0, 3),
    [
        { id: 0x01, value: 40 },
        { id: 0x02, value: 4555766 },
        { id: 0x09, value: 1200 }
    ],
    'admin level status should send level and exp before vitals'
);
assert.ok(adminLevelStatus.some((param) => param.id === 0x11 && param.value === 321), 'admin level status should send PAtk');
assert.ok(adminLevelStatus.some((param) => param.id === 0x14 && param.value === 42), 'admin level status should round integer packet stats');
assert.ok(adminLevelStatus.some((param) => param.id === 0x19 && param.value === 199), 'admin level status should send MDef');

async function assertSetOwnLevelUpdatesRuntimeActor() {
    DataCache.init();

    let storedSkills = [{ selfId: 194, level: 1, passive: true }];
    Database.updateCharacterExperience = () => Promise.resolve();
    Database.updateCharacterVitals = () => Promise.resolve();
    Database.fetchSkill = (characterId, selfId) => Promise.resolve(storedSkills.filter((skill) => skill.selfId === selfId));
    Database.setSkill = (skill) => {
        storedSkills.push(skill);
        return Promise.resolve();
    };
    Database.updateSkillLevel = (characterId, selfId, level) => {
        const stored = storedSkills.find((skill) => skill.selfId === selfId);
        if (stored) {
            stored.level = level;
        }
        return Promise.resolve();
    };
    Database.fetchSkills = () => Promise.resolve(storedSkills);

    const classInfo = DataCache.classTemplates.find((row) => row.classId === 0);
    const session = {
        packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToOthers() {},
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
    const actor = new Actor(session, {
        id: 9001,
        name: 'AdminLevelTester',
        username: 'tester',
        level: 1,
        exp: 0,
        sp: 0,
        hp: 80,
        mp: 30,
        sex: 0,
        classId: 0,
        locX: 0,
        locY: 0,
        locZ: 0,
        head: 0,
        face: 0,
        hair: 0,
        hairColor: 0,
        title: '',
        karma: 0,
        pk: 0,
        pvp: 0,
        evalScore: 0,
        recRemain: 0,
        isGM: 1,
        isActive: 1,
        ...utils.crushOb(classInfo),
        items: [],
        paperdoll: utils.tupleAlloc(16, {})
    });
    session.actor = actor;

    await AdminSetLevel.setOwnLevel(session, 20);

    assert.strictEqual(actor.fetchLevel(), 20, 'admin level should update the live actor level');
    assert.strictEqual(actor.fetchExp(), DataCache.experience[19], 'admin level should update the live actor exp');
    assert.ok(actor.fetchMaxHp() > 80, 'admin level should recalculate max HP');
    assert.ok(actor.fetchMaxMp() > 30, 'admin level should recalculate max MP');
    assert.ok(actor.skillset.fetchSkills().length > 1, 'admin level should award available skills without relying on a relog');
    assert.ok(session.packets.some((packet) => packet[0] === 0x58), 'admin level should send a SkillsList packet');
    assert.ok(session.packets.some((packet) => packet[0] === 0x0e), 'admin level should send a StatusUpdate packet');
    assert.ok(session.packets.some((packet) => packet[0] === 0x04), 'admin level should send a UserInfo packet');
}

assertSetOwnLevelUpdatesRuntimeActor()
    .then(() => {
        console.log('Admin tool checks passed');
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
