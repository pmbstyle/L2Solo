const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const ServerResponse = invoke('GameServer/Network/Response');
const Database = invoke('Database');
const Actor = invoke('GameServer/Actor/Actor');
const AdminShop = invoke('GameServer/World/Generics/NpcBypasses/AdminShop');
const AdminSetLevel = invoke('GameServer/World/Generics/NpcBypasses/AdminSetLevel');
const AdminFullBuff = invoke('GameServer/World/Generics/NpcBypasses/AdminFullBuff');
const C4EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');

const armors = require('../data/Items/Armors/armors.json');
const weapons = require('../data/Items/Weapons/weapons.json');
const others = [
    ...require('../data/Items/Others/others.json'),
    ...require('../data/Items/Others/c4_raid_bosses.json'),
    ...require('../data/Items/Others/c4_low_level_raid_bosses.json')
];
const adminShop = require('../data/Admin/Shop/shop.json');

const originalSetTimeout = global.setTimeout;
const originalSetInterval = global.setInterval;
const testTimers = [];
global.setTimeout = (...args) => {
    const timer = originalSetTimeout(...args);
    testTimers.push(timer);
    return timer;
};
global.setInterval = (...args) => {
    const timer = originalSetInterval(...args);
    testTimers.push(timer);
    return timer;
};

DataCache.items = [...armors, ...weapons, ...others];
DataCache.adminShop = adminShop;
DataCache.experience = require('../data/Templates/Experience/experience.json');

const adminHtml = utils.parseRawFile('data/Html/Admin/main.html');
const adminShopHtml = utils.parseRawFile('data/Html/Admin/shop.html');
assert.ok(adminHtml.includes('html Admin/shop'), 'admin panel should link to the paged equipment shop');
assert.ok(adminHtml.includes('html Admin/teleport'), 'admin panel should link to the paged teleport directory');
assert.ok(adminHtml.includes('admin-full-buff'), 'admin panel should expose the automatic class full buff');
assert.ok(adminHtml.includes('action="bypass admin-full-buff"'), 'admin full buff should keep the menu visible while the bypass runs');
assert.ok(!adminHtml.includes('admin-shop armor-all'), 'admin panel should not expose crash-prone full armor lists');
assert.ok(!adminHtml.includes('admin-shop weapon-all'), 'admin panel should not expose crash-prone full weapon lists');
assert.ok(adminShopHtml.includes('admin-shop armor-s'), 'equipment shop should expose armor grade links');
assert.ok(adminShopHtml.includes('admin-shop weapon-s'), 'equipment shop should expose weapon grade links');
for (const category of [
    'enchant-weapon-normal', 'enchant-weapon-blessed', 'enchant-weapon-crystal',
    'enchant-armor-normal', 'enchant-armor-blessed', 'enchant-armor-crystal'
]) {
    assert.ok(adminShopHtml.includes(`admin-shop ${category}`), `equipment shop should expose ${category}`);
}
assert.ok(adminShopHtml.includes('admin-shop supply-crystals'), 'equipment shop should expose crystal supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-soulshots'), 'equipment shop should expose soulshot supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-spiritshots'), 'equipment shop should expose spiritshot supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-blessed-spiritshots'), 'equipment shop should expose blessed spiritshot supplies');
assert.ok(adminShopHtml.includes('admin-shop supply-arrows'), 'equipment shop should expose arrow supplies');
assert.ok(adminHtml.includes('admin-set-level $admin_level'), 'admin panel should submit own level edits');

const teleportHubHtml = utils.parseRawFile('data/Html/Admin/teleport.html');
const teleportPages = [
    'gludin', 'gludio', 'dion', 'giran', 'heine', 'oren', 'hunters', 'aden', 'goddard', 'rune', 'dungeons'
];
teleportPages.forEach((page) => {
    assert.ok(teleportHubHtml.includes(`html Admin/teleport-${page}`), `teleport hub should link to ${page}`);
    const html = utils.parseRawFile(`data/Html/Admin/teleport-${page}.html`);
    const destinations = [...html.matchAll(/admin-teleport\s+([^"]+)/g)].map((match) => match[1].trim());
    assert.ok(destinations.length >= 5, `${page} teleport page should contain a useful destination list`);
    destinations.forEach((destination) => {
        const coords = destination.split(/\s+/);
        assert.strictEqual(coords.length, 3, `${page} teleport destination should contain exactly three coordinates`);
        assert.ok(coords.every((value) => /^-?\d+$/.test(value)), `${page} teleport coordinates should be integers`);
    });
});
assert.ok(teleportHubHtml.includes('teleport-starter'), 'teleport hub should preserve access to starter areas');
assert.ok(utils.parseRawFile('data/Html/Admin/teleport-goddard.html').includes('Goddard Castle Town'), 'Goddard should have its own city page');
assert.ok(utils.parseRawFile('data/Html/Admin/teleport-rune.html').includes('Rune Castle Town'), 'Rune should have its own city page');
assert.ok(!utils.parseRawFile('data/Html/Admin/teleport-rune.html').includes('Catacomb of the Apostate'),
    'the Oren catacomb must not be duplicated on the Rune territory page');
assert.ok(utils.parseRawFile('data/Html/Admin/teleport-oren.html').includes('Catacomb of the Apostate'),
    'Catacomb of the Apostate must remain on its Oren territory page');
assert.ok(utils.parseRawFile('data/Html/Admin/teleport-dungeons.html').includes('Necropolis of the Disciples'), 'dungeon page should include late-game Seven Signs destinations');

Object.entries(AdminFullBuff.PROFILES).forEach(([profile, entries]) => {
    assert.strictEqual(entries.length, 20, `${profile} full buff should fill exactly the sourced C4 buff capacity`);
    assert.strictEqual(new Set(entries.map(([selfId]) => selfId)).size, 20, `${profile} full buff should not waste slots on duplicate skills`);
    entries.forEach(([selfId, level]) => {
        assert.ok(AdminFullBuff.skillData(selfId, level), `${profile} full buff should reference sourced skill ${selfId} level ${level}`);
    });
});
assert.strictEqual(AdminFullBuff.profileForActor({ isSpellcaster: () => 0 }), 'melee', 'fighter classes should receive the melee profile');
assert.strictEqual(AdminFullBuff.profileForActor({ isSpellcaster: () => 1 }), 'mage', 'spellcaster classes should receive the mage profile');
[
    [5, 'tank'], [8, 'dagger'], [9, 'archer'], [12, 'mage'], [14, 'summoner'], [16, 'support'],
    [21, 'melee'], [34, 'melee'], [90, 'tank'], [93, 'dagger'], [96, 'summoner'], [107, 'melee']
].forEach(([classId, profile]) => {
    assert.strictEqual(
        AdminFullBuff.profileForActor({ fetchClassId: () => classId, isSpellcaster: () => 0 }),
        profile,
        `class ${classId} should resolve to the ${profile} full-buff profile`
    );
});
assert.strictEqual(AdminFullBuff.skillData(1045, 6).level, 6, 'admin full buff should materialize sourced Bless the Body level 6');
assert.strictEqual(AdminFullBuff.skillData(1048, 6).level, 6, 'admin full buff should materialize sourced Bless the Soul level 6');

const fixedExpiry = Date.now() + AdminFullBuff.ADMIN_BUFF_DURATION_MS;
Object.keys(AdminFullBuff.PROFILES).forEach((profile) => {
    const target = { effects: {}, activeBuffs: {} };
    const applied = AdminFullBuff.applyProfile({}, target, profile, {
        expiresAt: fixedExpiry,
        refresh: false,
        scheduleExpiry: false
    });
    assert.strictEqual(applied.length, 20, `${profile} full buff should apply all 20 configured effects`);
    assert.strictEqual(EffectStore.list(target).length, 20, `${profile} full buff should not lose effects to stack-family collisions`);
});

const meleeBuffTarget = { isSpellcaster: () => 0, effects: {}, activeBuffs: {} };
const meleeEffects = AdminFullBuff.applyProfile({}, meleeBuffTarget, 'melee', {
    expiresAt: fixedExpiry,
    refresh: false,
    scheduleExpiry: false
});
assert.strictEqual(meleeEffects.length, AdminFullBuff.PROFILES.melee.length, 'melee full buff should apply every profile effect');
assert.strictEqual(EffectStore.list(meleeBuffTarget).find((effect) => effect.key === 'might').stats.pAtkMul, 1.15, 'melee profile should apply sourced Might level 3 stats');
assert.strictEqual(EffectStore.list(meleeBuffTarget).find((effect) => effect.key === 'vampiric_rage').stats.absorbDam, 9, 'melee profile should apply sourced Vampiric Rage level 4 stats');
assert.ok(EffectStore.list(meleeBuffTarget).some((effect) => effect.key === 'song_of_hunter'), 'melee profile should include class-relevant songs');
assert.ok(EffectStore.list(meleeBuffTarget).some((effect) => effect.key === 'dance_of_warrior'), 'melee profile should include class-relevant dances');
assert.ok(EffectStore.list(meleeBuffTarget).some((effect) => effect.key === 'prophecy_of_fire'), 'melee profile should include Prophecy of Fire');
assert.ok(meleeEffects.every((effect) => effect.expiresAt === fixedExpiry), 'melee profile effects should share one 20-minute expiry');

const mageBuffTarget = { isSpellcaster: () => 1, effects: {}, activeBuffs: {} };
const mageEffects = AdminFullBuff.applyProfile({}, mageBuffTarget, 'mage', {
    expiresAt: fixedExpiry,
    refresh: false,
    scheduleExpiry: false
});
assert.strictEqual(mageEffects.length, AdminFullBuff.PROFILES.mage.length, 'mage full buff should apply every profile effect');
assert.strictEqual(EffectStore.list(mageBuffTarget).find((effect) => effect.key === 'empower').stats.mAtkMul, 1.75, 'mage profile should apply sourced Empower level 3 stats');
assert.strictEqual(EffectStore.list(mageBuffTarget).find((effect) => effect.key === 'acumen').stats.castSpdMul, 1.3, 'mage profile should apply sourced Acumen level 3 stats');
assert.strictEqual(EffectStore.list(mageBuffTarget).find((effect) => effect.key === 'wild_magic').stats.mCritRateMul, 4, 'mage profile should apply sourced Wild Magic level 2 stats');
assert.ok(EffectStore.list(mageBuffTarget).some((effect) => effect.key === 'song_of_meditation'), 'mage profile should include mana-oriented songs');
assert.ok(EffectStore.list(mageBuffTarget).some((effect) => effect.key === 'dance_of_siren'), 'mage profile should include magic-oriented dances');
assert.ok(EffectStore.list(mageBuffTarget).some((effect) => effect.key === 'prophecy_of_water'), 'mage profile should include Prophecy of Water');

const summonBuffTarget = {
    fetchClassId: () => 14,
    isSpellcaster: () => 1,
    effects: {},
    activeBuffs: {},
    summon: {
        effects: {},
        activeBuffs: {},
        state: { fetchDead: () => false }
    }
};
const summonFullBuff = AdminFullBuff.applyFullBuff({}, summonBuffTarget, {
    expiresAt: fixedExpiry,
    refresh: false,
    scheduleExpiry: false
});
assert.strictEqual(summonFullBuff.profile, 'summoner', 'summoner classes should receive the caster-side summoner profile');
assert.strictEqual(summonFullBuff.applied.length, 20, 'summoner owner should receive a complete player profile');
assert.strictEqual(summonFullBuff.summonApplied.length, 20, 'an active servitor should receive its own hybrid profile');
assert.ok(EffectStore.list(summonBuffTarget.summon).some((effect) => effect.key === 'dance_of_warrior'), 'servitor profile should include physical music');
assert.ok(EffectStore.list(summonBuffTarget.summon).some((effect) => effect.key === 'empower'), 'servitor profile should support magic-oriented summons too');

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

const expectedEnchantGroups = {
    'enchant-weapon-normal': [955, 951, 947, 729, 959],
    'enchant-weapon-blessed': [6575, 6573, 6571, 6569, 6577],
    'enchant-weapon-crystal': [957, 953, 949, 731, 961],
    'enchant-armor-normal': [956, 952, 948, 730, 960],
    'enchant-armor-blessed': [6576, 6574, 6572, 6570, 6578],
    'enchant-armor-crystal': [958, 954, 950, 732, 962]
};
for (const [category, itemIds] of Object.entries(expectedEnchantGroups)) {
    assert.deepStrictEqual(AdminShop.itemIdsForSource(adminShop[category]), itemIds, `${category} should expose every D-S enchant scroll`);
    itemIds.forEach((selfId) => {
        assert.ok(others.some((item) => item.selfId === selfId), `${category} item ${selfId} should exist in the item datapack`);
        const scroll = C4EnchantScrolls.resolve(selfId);
        assert.ok(scroll, `${category} item ${selfId} should be recognized by the enchant runtime`);
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

let enchantBuyListPacket = null;
AdminShop({
    actor: { backpack: { fetchTotalAdena: () => 1000000 } },
    dataSendToMe(packet) { enchantBuyListPacket = packet; }
}, ['admin-shop', 'enchant-armor-blessed']);
assert.ok(enchantBuyListPacket, 'admin shop should send a BuyList packet for enchant scrolls');
assert.strictEqual(enchantBuyListPacket.readInt16LE(9), 5, 'admin enchant shop should expose all five D-S grades');
for (let i = 0; i < enchantBuyListPacket.readInt16LE(9); i++) {
    const offset = 11 + (i * 32);
    assert.strictEqual(enchantBuyListPacket.readInt32LE(offset + 28), 0, 'admin enchant scrolls should be free');
}

assert.strictEqual(AdminSetLevel.normalizeLevel('1'), 1, 'admin level should accept level 1');
assert.strictEqual(AdminSetLevel.normalizeLevel('80'), 80, 'admin level should accept the configured max level');
assert.strictEqual(AdminSetLevel.normalizeLevel('999'), 80, 'admin level should clamp to max level');
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
        isGM: 0,
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

    session.packets = [];
    const appliedAdminBuffs = AdminFullBuff(session);
    assert.strictEqual(actor.fetchIsGM(), 0, 'runtime regression fixture should match the non-GM dagger character that can open the dev admin menu');
    assert.strictEqual(appliedAdminBuffs.length, AdminFullBuff.PROFILES.melee.length, 'admin full buff bypass should apply the detected fighter profile from the dev admin menu');
    assert.ok(EffectStore.list(actor).some((effect) => effect.key === 'might'), 'admin full buff bypass should update authoritative actor effects');
    assert.ok(session.packets.some((packet) => packet[0] === 0x04), 'admin full buff bypass should refresh UserInfo immediately');
    assert.ok(session.packets.some((packet) => packet[0] === 0x7f), 'admin full buff bypass should refresh visible effect icons immediately');
    EffectTicker.clearAll(actor);
}

assertSetOwnLevelUpdatesRuntimeActor()
    .then(() => {
        console.log('Admin tool checks passed');
    })
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => {
        global.setTimeout = originalSetTimeout;
        global.setInterval = originalSetInterval;
        testTimers.forEach((timer) => {
            clearTimeout(timer);
            clearInterval(timer);
        });
    });
