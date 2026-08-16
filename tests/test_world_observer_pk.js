const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Observer = invoke('WorldObserver/WorldObserverServer');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

const observerClasses = Observer.classCatalog();
assert(observerClasses.some((entry) => entry.classId === 21 && entry.className === 'Swordsinger'),
    'observer class catalog must include Swordsinger');
assert(observerClasses.some((entry) => entry.classId === 34 && entry.className === 'Bladedancer'),
    'observer class catalog must include Bladedancer');

function actor(karma = 0) {
    return {
        fetchId: () => 42,
        fetchName: () => 'Kharz',
        fetchLevel: () => 46,
        fetchClassId: () => 45,
        fetchLocX: () => 76576,
        fetchLocY: () => 50151,
        fetchLocZ: () => -3200,
        fetchHp: () => 100,
        fetchMaxHp: () => 100,
        fetchMp: () => 50,
        fetchMaxMp: () => 50,
        fetchIsOnline: () => true,
        fetchKarma: () => karma
    };
}

const player = Observer.compactPlayer({ actor: actor(720) });
assert.strictEqual(player.isPk, true, 'red-name players must be marked for the observer map');
assert.strictEqual(player.className, 'Orc Raider', 'player snapshots must expose the profession name instead of only its numeric id');
assert.strictEqual(player.raceName, 'Orc', 'player race metadata must be derived from the authoritative class template when needed');
assert.strictEqual(player.equipmentValue, 0, 'actors without an inventory snapshot must have a stable zero gear estimate');

const hotBot = Observer.compactHotBot({
    id: 42,
    name: 'Kharz',
    level: 46,
    classId: 44,
    mode: 'pk_hunting',
    intent: 'hunting',
    role: 'dps',
    home: null,
    loc: { locX: 76576, locY: 50151, locZ: -3200 },
    vitals: {},
    available: true
}, new Set([42]));
assert.strictEqual(hotBot.isPk, true, 'hot PK bots must be marked for red rendering');
assert.strictEqual(hotBot.className, 'Orc Fighter', 'hot bot snapshots must expose a player-facing profession name');
assert.strictEqual(hotBot.raceName, 'Orc', 'hot bot snapshots must expose a filterable race');

const fixedMerchant = Observer.compactHotBot({
    id: 50,
    name: 'Fixed Merchant',
    level: 40,
    classId: 53,
    mode: 'merchant',
    intent: 'trade',
    role: 'crafter',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {},
    available: true
}, new Set(), { plan: 'merchant' });
assert.strictEqual(fixedMerchant.staticService, true, 'permanent merchant services must be identifiable for roster filtering');

const dynamicMerchant = Observer.compactHotBot({
    id: 51,
    name: 'Dynamic Merchant',
    level: 40,
    classId: 53,
    mode: 'merchant',
    intent: 'trade',
    role: 'crafter',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {},
    available: true
}, new Set(), { plan: 'merchant', coldMarketState: {} });
assert.strictEqual(dynamicMerchant.staticService, false, 'temporary player merchants must remain in the roster');

const baseClassBot = Observer.compactHotBot({
    id: 41,
    name: 'Starter',
    level: 1,
    classId: 0,
    mode: 'hunting',
    intent: 'hunting',
    role: 'dps',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {},
    available: true
});
assert.strictEqual(baseClassBot.classId, 0, 'base profession id zero must remain valid observer metadata');
assert.strictEqual(baseClassBot.className, 'Human Fighter', 'base profession id zero must resolve to its class name');

const hotDetail = Observer.compactHotDetail({
    id: 42,
    name: 'Kharz',
    level: 46,
    classId: 44,
    mode: 'pk_hunting',
    intent: 'hunting',
    role: 'dps',
    loc: { locX: 76576, locY: 50151, locZ: -3200 },
    vitals: { hp: 100, maxHp: 100, hpPct: 1, mp: 50, maxMp: 50, mpPct: 1 },
    buffs: {},
    available: true
}, { actor: { fetchKarma: () => 720, activeBuffs: {} } });
assert.strictEqual(hotDetail.isPk, true, 'hot PK detail must preserve the red-name marker after selection');

const coldPk = Observer.compactStateBot({
    characterId: 43,
    name: 'Cold PK',
    level: 20,
    phase: 'cold',
    activity: 'pk_hunting',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {}
}, new Set());
assert.strictEqual(coldPk.isPk, true, 'stored PK encounters must remain marked between activations');

const elvenRuinsBot = Observer.compactStateBot({
    characterId: 273,
    name: 'Underground Hunter',
    level: 13,
    phase: 'cold',
    activity: 'hunting',
    homeRegion: 'Elven Village',
    currentRegion: 'Skeleton fields',
    spotId: '7_41',
    loc: { locX: 45596, locY: 247589, locZ: -6518 },
    vitals: {},
    party: {},
    stats: {}
}, new Set());
assert.strictEqual(elvenRuinsBot.area.name, 'Elven Ruins', 'observer snapshots must expose the canonical dungeon name');
assert.strictEqual(elvenRuinsBot.area.mapLayer, 'dungeon', 'observer snapshots must preserve the physical dungeon layer');
assert.deepStrictEqual(elvenRuinsBot.area.mapAnchor, { locX: -113329, locY: 235327, locZ: -3653 },
    'Elven Ruins actors must carry the authoritative surface entrance for map projection');
assert.strictEqual(elvenRuinsBot.region, 'Elven Ruins', 'synthetic Skeleton fields labels must not leak into the observer');
assert.strictEqual(elvenRuinsBot.home.region, 'Elven Village', 'current hunting area must not overwrite a bot home region');
assert.strictEqual(elvenRuinsBot.spot.name, 'Elven Ruins', 'the observer spot label must use the canonical game area');

const mithrilMinesBot = Observer.compactStateBot({
    characterId: 271,
    name: 'Mine Hunter',
    level: 13,
    phase: 'cold',
    activity: 'hunting',
    homeRegion: 'Dwarven Village',
    currentRegion: 'Akaste Bone Soldier fields',
    spotId: '29_-30',
    loc: { locX: 176673, locY: -177656, locZ: 801 },
    vitals: {},
    party: {},
    stats: {}
}, new Set());
assert.strictEqual(mithrilMinesBot.area.name, 'Mithril Mines', 'observer snapshots must expose the canonical Mithril Mines name');
assert.strictEqual(mithrilMinesBot.area.mapLayer, 'dungeon', 'Mithril Mines snapshots must preserve the physical dungeon layer');
assert.deepStrictEqual(mithrilMinesBot.area.mapAnchor, { locX: 179039, locY: -184080, locZ: -319 },
    'Mithril Mines actors must carry the authoritative surface entrance for map projection');
assert.strictEqual(mithrilMinesBot.region, 'Mithril Mines', 'Akaste field labels must not leak into the observer');
assert.strictEqual(mithrilMinesBot.spot.name, 'Mithril Mines', 'the observer spot label must use the canonical mine area');

const craftService = Observer.compactStateBot({
    characterId: 48,
    name: 'Craft Station',
    level: 70,
    phase: 'cold',
    activity: 'crafting',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {},
    stats: {
        role: 'crafter',
        craftStationId: 'a_light',
        craftShop: { stationId: 'a_light', town: 'Giran' }
    }
}, new Set());
assert.strictEqual(craftService.staticService, true, 'dedicated cold craft stations must be identifiable for roster filtering');

const configuredMerchantState = Observer.compactStateBot({
    characterId: 50,
    name: 'Nika',
    level: 1,
    phase: 'hot',
    activity: 'merchant',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {},
    stats: { classId: 53 }
}, new Set());
assert.strictEqual(configuredMerchantState.staticService, true, 'configured merchants must stay hidden even when a stale life-state row exists');

const adventuringCrafter = Observer.compactStateBot({
    characterId: 49,
    name: 'Adventuring Crafter',
    level: 40,
    phase: 'cold',
    activity: 'hunting',
    loc: { locX: 0, locY: 0, locZ: 0 },
    vitals: {},
    stats: { role: 'crafter' }
}, new Set());
assert.strictEqual(adventuringCrafter.staticService, false, 'an adventuring crafter remains dynamic even though the Observer role filter hides crafters');

const coldState = {
    characterId: 44,
    name: 'Cold Detail',
    level: 20,
    phase: 'cold',
    activity: 'hunting',
    homeRegion: 'Dion',
    currentRegion: 'Dion',
    loc: { locX: 1, locY: 2, locZ: 3 },
    vitals: { hp: 10, maxHp: 20, mp: 5, maxMp: 10 },
    party: {},
    stats: {
        classId: 15,
        role: 'healer',
        equipment: [{ selfId: 1, name: 'Test Staff', slot: 7, rank: 'd', kind: 'Weapon.Blunt' }],
        coldCombat: {
            base: { str: 40, dex: 30, con: 43, int: 21, wit: 11, men: 25, pAtk: 3, mAtk: 6, pDef: 10, mDef: 5 },
            equipment: { pAtk: 20, mAtk: 30, pDef: 40, mDef: 10, atkSpd: 379 }
        },
        build: { classId: 15, classFamily: 'bishop', grade: 'd', armor: 'robe', weapon: 'staff' }
    },
    updatedAt: 1
};
const coldDetail = Observer.compactColdDetail(coldState);
const authoritativeCombat = ColdCombatProfile.profileFor(coldState);
assert.strictEqual(coldDetail.classId, 15, 'cold bot detail must preserve class metadata');
assert.strictEqual(coldDetail.className, 'Cleric', 'cold bot detail must expose the profession name');
assert.strictEqual(coldDetail.raceName, 'Human', 'cold bot detail must derive race from its current profession');
assert.strictEqual(coldDetail.build.className, 'Cleric', 'build metadata must use the same authoritative profession name');
assert.strictEqual(coldDetail.equipment.equipped[0].slot, 'weapon', 'cold outfit slots must be human-readable');
assert.strictEqual(coldDetail.combat.pDef, authoritativeCombat.pDef, 'cold bot detail must use authoritative combat formulas');
assert.strictEqual(coldDetail.combat.atkSpd, authoritativeCombat.atkSpd, 'cold bot detail must not add base and equipment attack speed');

const legacyColdDetail = Observer.compactColdDetail({
    ...coldState,
    characterId: 45,
    name: 'Legacy Gear',
    stats: {
        ...coldState.stats,
        coldCombat: { version: 3, skillSource: 'database', skills: [] },
        equipment: [
            { selfId: 5, name: 'Mace', slot: 7, rank: 'none', kind: 'Weapon.Blunt' },
            { selfId: 178, name: 'Bone Staff', slot: 14, rank: 'd', kind: 'Weapon.Blunt' },
            { selfId: 1146, name: "Squire's Shirt", slot: 10, rank: 'none', kind: 'Armor.Leather' },
            { selfId: 1147, name: "Squire's Pants", slot: 11, rank: 'none', kind: 'Armor.Leather' }
        ]
    },
    inventory: {
        5: { selfId: 5, name: 'Mace', slot: 7, kind: 'Weapon.Blunt', equipped: true },
        178: { selfId: 178, name: 'Bone Staff', slot: 14, kind: 'Weapon.Blunt', equipped: true },
        1146: { selfId: 1146, name: "Squire's Shirt", slot: 10, kind: 'Armor.Leather', equipped: true },
        1147: { selfId: 1147, name: "Squire's Pants", slot: 11, kind: 'Armor.Leather', equipped: true }
    }
});
assert(legacyColdDetail.equipment.totals.pAtk > 0, 'legacy cold gear must expose reconstructed physical attack');
assert(legacyColdDetail.equipment.totals.pDef > 0, 'legacy cold gear must expose reconstructed physical defense');
assert(legacyColdDetail.equipment.equipped[0].stats.pAtk > 0, 'cold gear rows must include datapack item stats');
assert.strictEqual(legacyColdDetail.equipment.equipped[0].rank, 'no-grade', 'observer must expose a player-facing no-grade label instead of internal none');
assert.strictEqual(legacyColdDetail.equipment.equipped.find((item) => item.selfId === 178).slot, 'two-handed weapon', 'two-handed paperdoll items must not be mislabeled as dual weapons');
assert(legacyColdDetail.equipmentValue >= 409000, 'cold ranking metadata must estimate equipped gear from datapack prices');

const liveWeapon = {
    fetchSelfId: () => 178,
    fetchName: () => 'Bone Staff',
    fetchSlot: () => 14,
    fetchRank: () => 'd',
    fetchKind: () => 'Weapon.Blunt',
    fetchPrice: () => 409000,
    fetchEquipped: () => true,
    isWeapon: () => true,
    isArmor: () => false,
    fetchPAtk: () => 39,
    fetchMAtk: () => 35,
    fetchCritical: () => 40,
    fetchAccur: () => 4.75
};
const liveAdena = { fetchAmount: () => 123456 };
const playerDetail = Observer.compactPlayerDetail({ actor: {
    ...actor(),
    fetchRace: () => 3,
    fetchExp: () => 98765,
    fetchSp: () => 4321,
    fetchCp: () => 25,
    fetchMaxCp: () => 50,
    fetchPvp: () => 7,
    fetchPk: () => 2,
    backpack: {
        fetchItems: () => [liveWeapon],
        fetchItemFromSelfId: (selfId) => Number(selfId) === 57 ? liveAdena : null,
        fetchEquippedWeapon: () => liveWeapon,
        fetchTotalWeaponPAtk: () => 39,
        fetchTotalWeaponMAtk: () => 35,
        fetchTotalArmorPDef: () => 80,
        fetchTotalArmorMDef: () => 41,
        fetchTotalLoad: () => 1060
    }
} });
assert.strictEqual(playerDetail.kind, 'player', 'online players must have the same detailed inspection contract as bots');
assert.strictEqual(playerDetail.adena, 123456, 'player detail must expose live Adena for wealth ranking and inspection');
assert.strictEqual(playerDetail.equipmentValue, 409000, 'player detail must estimate live equipped gear from datapack prices');
assert.strictEqual(playerDetail.equipment.equipped[0].name, 'Bone Staff', 'player detail must expose full equipped item rows');
assert.strictEqual(Observer.equipmentValue([{ objectId: 178, price: 321 }]), 321,
    'instance object IDs must not be mistaken for unrelated item template IDs during valuation');

const leaderDetail = Observer.compactColdDetail({
    ...coldState,
    characterId: 46,
    name: 'Party Member',
    party: { partyId: 'party-1', leaderId: 47 },
    stats: { ...coldState.stats, leaderId: 47 }
}, {
    characterId: 47,
    name: 'Party Leader',
    level: 21,
    phase: 'cold',
    party: { role: 'tank' },
    stats: { classId: 44, role: 'tank' }
});
assert.strictEqual(leaderDetail.party.leader.id, 47, 'observer party detail must retain the leader id');
assert.strictEqual(leaderDetail.party.leader.name, 'Party Leader', 'observer party detail must expose the leader nickname');

const deadDetail = Observer.compactColdDetail({
    ...coldState,
    activity: 'dead',
    vitals: { hp: 0, maxHp: 20, mp: 0, maxMp: 10 }
});
assert.strictEqual(deadDetail.intent, 'dead', 'dead cold bots must not claim to be hunting');
assert.deepStrictEqual(deadDetail.blockers, ['dead'], 'dead cold bots must retain the map marker blocker');

console.log('World Observer PK marker checks passed');
