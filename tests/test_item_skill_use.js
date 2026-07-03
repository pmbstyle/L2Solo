const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Database = invoke('Database');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const C4ItemSkills = invoke('GameServer/Items/C4ItemSkills');
const C4ExtractableItems = invoke('GameServer/Items/C4ExtractableItems');
const C4EnchantScrolls = invoke('GameServer/Items/C4EnchantScrolls');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
const ManorData = invoke('GameServer/Manor/ManorData');
const World = invoke('GameServer/World/World');

Database.updateItemAmount = () => Promise.resolve();
Database.deleteItem = () => Promise.resolve();

function item(id, data) {
    return new Item(id, {
        selfId: data.selfId,
        kind: data.kind || 'Other.Potion',
        amount: data.amount ?? 1,
        stackable: data.stackable ?? true,
        consumable: data.consumable ?? true
    });
}

function sessionFor(backpack, options = {}) {
    let casts = false;
    let mp = options.mp ?? 100;
    let hp = options.hp ?? 100;
    let cp = options.cp ?? 0;
    let sp = options.sp ?? 0;
    let charges = options.charges ?? 0;
    const actor = {
        backpack,
        effects: {},
        activeBuffs: {},
        fetchId: () => 2000001,
        fetchName: () => 'Tester',
        fetchTitle: () => '',
        fetchRace: () => 0,
        fetchSex: () => 0,
        fetchClassId: () => 0,
        fetchLevel: () => options.level ?? 10,
        fetchExp: () => 0,
        fetchSp: () => sp,
        setSp(value) { sp = value; },
        fetchStr: () => 40,
        fetchDex: () => 30,
        fetchCon: () => 43,
        fetchInt: () => 21,
        fetchWit: () => 11,
        fetchMen: () => 25,
        fetchHp: () => hp,
        fetchMaxHp: () => options.maxHp ?? 100,
        setHp(value) { hp = value; },
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => options.destId,
        fetchHead: () => 0,
        fetchMp: () => mp,
        fetchMaxMp: () => options.maxMp ?? 100,
        setMp(value) { mp = value; },
        fetchCp: () => cp,
        fetchMaxCp: () => options.maxCp ?? 0,
        setCp(value) { cp = value; },
        fetchCharges: () => charges,
        setCharges(value) { charges = value; },
        fetchMaxLoad: () => 1000,
        fetchCollectivePAtk: () => 1,
        fetchCollectiveAtkSpd: () => 1,
        fetchCollectivePDef: () => 1,
        fetchCollectiveEvasion: () => 1,
        fetchCollectiveAccur: () => 1,
        fetchCollectiveCritical: () => 1,
        fetchCollectiveMAtk: () => 1,
        fetchCollectiveCastSpd: () => 1,
        fetchCollectiveMDef: () => 1,
        fetchPvpFlag: () => 0,
        fetchKarma: () => 0,
        fetchCollectiveRunSpd: () => 1,
        fetchCollectiveWalkSpd: () => 1,
        fetchSwim: () => 0,
        fetchAtkSpdMultiplier: () => 1,
        fetchRadius: () => 1,
        fetchSize: () => 1,
        fetchHair: () => 0,
        fetchHairColor: () => 0,
        fetchFace: () => 0,
        fetchIsGM: () => 0,
        fetchPrivateStoreType: () => 0,
        fetchIsCrafter: () => 0,
        fetchPk: () => 0,
        fetchPvp: () => 0,
        fetchRecRemain: () => 0,
        fetchEvalScore: () => 0,
        isDead: () => false,
        statusUpdateVitals() {},
        state: {
            fetchCasts: () => casts,
            setCasts(value) { casts = value; }
        }
    };
    return {
        actor,
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        },
        dataSendToMeAndOthers(packet) {
            this.packets.push(packet);
        }
    };
}

function resurrectionTarget(options = {}) {
    let dead = options.dead ?? true;
    let revived = false;
    return {
        fetchId: () => options.id ?? 2000002,
        fetchName: () => options.name || 'Fallen',
        fetchLocX: () => options.locX ?? 100,
        fetchLocY: () => options.locY ?? 0,
        fetchLocZ: () => options.locZ ?? 0,
        revive() {
            revived = true;
            dead = false;
        },
        state: {
            fetchDead: () => dead
        },
        wasRevived: () => revived
    };
}

function playableTarget(options = {}) {
    let dead = options.dead ?? false;
    const target = {
        effects: {},
        fetchId: () => options.id ?? 2000004,
        fetchName: () => options.name || 'Target',
        fetchLocX: () => options.locX ?? 100,
        fetchLocY: () => options.locY ?? 0,
        fetchLocZ: () => options.locZ ?? 0,
        isDead: () => dead,
        setDead(value) { dead = value; },
        statusUpdateVitals() {},
        state: {
            fetchDead: () => dead
        }
    };
    target.session = {
        actor: target,
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        }
    };
    return target;
}

function attackableNpc(options = {}) {
    const absorbed = [];
    return {
        fetchId: () => options.id ?? 3000001,
        fetchName: () => options.name || 'Soul Target',
        fetchLocX: () => options.locX ?? 100,
        fetchLocY: () => options.locY ?? 0,
        fetchLocZ: () => options.locZ ?? 0,
        fetchHp: () => options.hp ?? 40,
        fetchMaxHp: () => options.maxHp ?? 100,
        fetchAttackable: () => options.attackable ?? true,
        isDead: () => options.dead ?? false,
        state: {
            fetchDead: () => options.dead ?? false
        },
        addAbsorber(actor) {
            absorbed.push({ id: actor.fetchId(), absorbedHp: this.fetchHp() });
        },
        absorbed
    };
}

function manorNpc(options = {}) {
    let dead = options.dead ?? false;
    return {
        model: {},
        fetchId: () => options.id ?? 3000201,
        fetchName: () => options.name || 'Manor Target',
        fetchLevel: () => options.level ?? 10,
        fetchKind: () => options.kind || 'Monster',
        fetchLocX: () => options.locX ?? 100,
        fetchLocY: () => options.locY ?? 0,
        fetchLocZ: () => options.locZ ?? 0,
        fetchAttackable: () => options.attackable ?? true,
        isDead: () => dead,
        setDead(value) { dead = value; },
        state: {
            fetchDead: () => dead
        }
    };
}

const hasteBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
hasteBackpack.items = [
    item(1, { selfId: 1062, amount: 2 })
];
const hasteSession = sessionFor(hasteBackpack);
hasteBackpack.useItem(hasteSession, 1);
assert.strictEqual(hasteBackpack.fetchItemFromSelfId(1062).fetchAmount(), 1, 'Haste Potion should consume one item on successful item-skill use');
assert.strictEqual(EffectStats.add(hasteSession.actor, 'runSpdAdd'), 33, 'Haste Potion should apply sourced skill 2033 runSpd +33');
assert(hasteSession.packets.length > 0, 'Haste Potion should emit skill/effect packets when used');

const guidanceBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
const guidance = guidanceBackpack.buildItemSkill(C4ItemSkills.resolve(3926));
assert(guidance, 'L2Day Guidance scroll should resolve to an item skill');
assert.strictEqual(guidance.fetchSelfId(), 2050, 'L2Day Guidance scroll should use sourced skill 2050');
assert.strictEqual(guidance.fetchHitTime(), 4000, 'L2Day Guidance scroll should preserve sourced 4000ms cast time');

const blessedEscapeBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
const blessedEscape = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(3958));
assert(blessedEscape, 'L2Day Blessed Escape should resolve to an item skill');
assert.strictEqual(blessedEscape.fetchSelfId(), 2036, 'L2Day Blessed Escape should use sourced skill 2036');
assert.strictEqual(blessedEscape.fetchLevel(), 2, 'L2Day Blessed Escape should preserve sourced item_skill level 2');
assert.strictEqual(blessedEscape.fetchHitTime(), 200, 'L2Day Blessed Escape should preserve sourced skill hitTime');

const l2DayResurrection = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(3959));
assert(l2DayResurrection, 'L2Day Blessed Scroll of Resurrection should resolve to an item skill');
assert.strictEqual(l2DayResurrection.fetchSelfId(), 2062, 'L2Day Blessed Scroll of Resurrection should use sourced skill 2062');
assert.strictEqual(l2DayResurrection.fetchPower(), 100, 'L2Day Blessed Scroll of Resurrection should preserve sourced power 100');
assert.strictEqual(l2DayResurrection.fetchHitTime(), 15000, 'L2Day Blessed Scroll of Resurrection should preserve sourced 15000ms hitTime');

const clanHallEscape = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(1829));
assert(clanHallEscape, 'Scroll of Escape: Clan Hall should resolve to an item skill');
assert.strictEqual(clanHallEscape.fetchSelfId(), 2040, 'Scroll of Escape: Clan Hall should use sourced skill 2040');
assert.strictEqual(clanHallEscape.fetchHitTime(), 20000, 'Scroll of Escape: Clan Hall should preserve sourced 20000ms hitTime');
assert.strictEqual(clanHallEscape.fetchSkillType(), C4SkillRules.RECALL, 'Scroll of Escape: Clan Hall should preserve sourced TELEPORT semantics');
assert.strictEqual(clanHallEscape.fetchTargetKind(), 'self', 'Scroll of Escape: Clan Hall should preserve sourced self target');
assert.strictEqual(clanHallEscape.fetchSemantic().teleportWhereType, 'ClanHall', 'Scroll of Escape: Clan Hall should preserve sourced teleportWhereType');

const castleEscape = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(1830));
assert(castleEscape, 'Scroll of Escape: Castle should resolve to an item skill');
assert.strictEqual(castleEscape.fetchSelfId(), 2041, 'Scroll of Escape: Castle should use sourced skill 2041');
assert.strictEqual(castleEscape.fetchHitTime(), 20000, 'Scroll of Escape: Castle should preserve sourced 20000ms hitTime');
assert.strictEqual(castleEscape.fetchSkillType(), C4SkillRules.RECALL, 'Scroll of Escape: Castle should preserve sourced TELEPORT semantics');
assert.strictEqual(castleEscape.fetchSemantic().teleportWhereType, 'Castle', 'Scroll of Escape: Castle should preserve sourced teleportWhereType');

const soulshotA = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(1466));
assert(soulshotA, 'Soulshot: A-grade should resolve to an item skill');
assert.strictEqual(soulshotA.fetchSelfId(), 2153, 'Soulshot: A-grade should use sourced skill 2153');
assert.strictEqual(soulshotA.fetchSkillType(), C4SkillRules.SOULSHOT, 'Soulshot: A-grade should preserve sourced SOULSHOT semantics');
assert.strictEqual(soulshotA.fetchSemantic().element, 4, 'Soulshot: A-grade should preserve sourced element grade 4');

const spiritshotB = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(2512));
assert(spiritshotB, 'Spiritshot: B-grade should resolve to an item skill');
assert.strictEqual(spiritshotB.fetchSelfId(), 2157, 'Spiritshot: B-grade should use sourced skill 2157');
assert.strictEqual(spiritshotB.fetchSkillType(), C4SkillRules.SPIRITSHOT, 'Spiritshot: B-grade should preserve magic-shot runtime semantics');
assert.strictEqual(spiritshotB.fetchSemantic().multiplier, 1.5, 'Spiritshot: B-grade should preserve sourced multiplier 1.5');

const blessedSpiritshotS = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(3952));
assert(blessedSpiritshotS, 'Blessed Spiritshot: S Grade should resolve to an item skill');
assert.strictEqual(blessedSpiritshotS.fetchSelfId(), 2164, 'Blessed Spiritshot: S Grade should use sourced skill 2164');
assert.strictEqual(blessedSpiritshotS.fetchSkillType(), C4SkillRules.SPIRITSHOT, 'Blessed Spiritshot: S Grade should preserve magic-shot runtime semantics');
assert.strictEqual(blessedSpiritshotS.fetchSemantic().blessedSpiritshot, true, 'Blessed Spiritshot: S Grade should preserve blessed spiritshot metadata');

const noGradeSoulshot = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(1835));
assert(noGradeSoulshot, 'Soulshot: No Grade should resolve to an item skill');
assert.strictEqual(noGradeSoulshot.fetchSelfId(), 2039, 'Soulshot: No Grade should use sourced skill 2039');
assert.strictEqual(noGradeSoulshot.fetchSkillType(), C4SkillRules.SOULSHOT, 'Soulshot: No Grade should preserve sourced SOULSHOT semantics');

const beginnerSoulshot = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5789));
assert(beginnerSoulshot, 'Soulshot: No Grade for Beginners should resolve to an item skill');
assert.strictEqual(beginnerSoulshot.fetchSelfId(), 2039, 'Soulshot: No Grade for Beginners should use sourced skill 2039');

const beginnerSpiritshot = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5790));
assert(beginnerSpiritshot, 'Spiritshot: No Grade for Beginners should resolve to an item skill');
assert.strictEqual(beginnerSpiritshot.fetchSelfId(), 2047, 'Spiritshot: No Grade for Beginners should use sourced skill 2047');
assert.strictEqual(beginnerSpiritshot.fetchSkillType(), C4SkillRules.SPIRITSHOT, 'Spiritshot: No Grade for Beginners should preserve sourced SPIRITSHOT semantics');

const blessedNoGradeSpiritshot = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(3947));
assert(blessedNoGradeSpiritshot, 'Blessed Spiritshot: No Grade should resolve to an item skill');
assert.strictEqual(blessedNoGradeSpiritshot.fetchSelfId(), 2061, 'Blessed Spiritshot: No Grade should use sourced skill 2061');
assert.strictEqual(blessedNoGradeSpiritshot.fetchSemantic().blessedSpiritshot, true, 'Blessed Spiritshot: No Grade should preserve blessed spiritshot metadata');

[
    4629, 4630, 4631, 4632, 4633, 4634, 4635, 4636, 4637, 4638, 4639,
    4640, 4641, 4642, 4643, 4644, 4645, 4646, 4647, 4648, 4649, 4650,
    4651, 4652, 4653, 4654, 4655, 4656, 4657, 4658, 4659, 4660, 4661,
    5577, 5578, 5579, 5580, 5581, 5582, 5908, 5911, 5914
].forEach((itemId) => {
    const itemSkill = C4ItemSkills.resolve(itemId);
    assert(itemSkill, `Soul Crystal item ${itemId} should resolve to an item skill`);
    assert.strictEqual(itemSkill.skillId, 2096, `Soul Crystal item ${itemId} should use sourced skill 2096`);
    assert.strictEqual(itemSkill.level, 1, `Soul Crystal item ${itemId} should preserve sourced item_skill level 1`);
    assert.strictEqual(itemSkill.consume, false, `Soul Crystal item ${itemId} should not be consumed as a simple item skill`);
    const soulCrystal = blessedEscapeBackpack.buildItemSkill(itemSkill);
    assert(soulCrystal, `Soul Crystal item ${itemId} should build skill 2096`);
    assert.strictEqual(soulCrystal.fetchSelfId(), 2096, `Soul Crystal item ${itemId} should build sourced Soul Crystal skill`);
    assert.strictEqual(soulCrystal.fetchSkillType(), C4SkillRules.DRAIN_SOUL, `Soul Crystal item ${itemId} should preserve DRAIN_SOUL semantics`);
    assert.strictEqual(soulCrystal.fetchTargetKind(), 'enemy', `Soul Crystal item ${itemId} should preserve sourced TARGET_ONE semantics`);
    assert.strictEqual(soulCrystal.fetchHitTime(), 1200, `Soul Crystal item ${itemId} should preserve sourced 1200ms hitTime`);
    assert.strictEqual(soulCrystal.fetchReuseTime(), 1300, `Soul Crystal item ${itemId} should preserve sourced 1300ms reuse`);
    assert.strictEqual(soulCrystal.fetchConsumedMp(), 26, `Soul Crystal item ${itemId} should preserve sourced mpConsume 26`);
    assert.strictEqual(soulCrystal.fetchSemantic().castRange, 300, `Soul Crystal item ${itemId} should preserve sourced castRange`);
    assert.strictEqual(soulCrystal.fetchSemantic().effectRange, 500, `Soul Crystal item ${itemId} should preserve sourced effectRange`);
});

const originalSoulCrystalSetTimeout = global.setTimeout;
global.setTimeout = (callback) => {
    callback();
    return 0;
};

try {
    const drainTarget = attackableNpc({ id: 3000101, hp: 50, maxHp: 100 });
    World.npc = { spawns: [drainTarget] };
    const soulCrystalBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    soulCrystalBackpack.items = [
        item(20, { selfId: 4630, kind: 'Other.Scroll', amount: 1 })
    ];
    const drainSession = sessionFor(soulCrystalBackpack, { destId: drainTarget.fetchId(), mp: 50 });
    soulCrystalBackpack.useItem(drainSession, 20);
    assert.strictEqual(soulCrystalBackpack.fetchItemFromSelfId(4630).fetchAmount(), 1, 'Soul Crystal should not be consumed when Drain Soul is cast');
    assert.strictEqual(drainSession.actor.fetchMp(), 24, 'Soul Crystal should consume sourced mpConsume 26 on successful Drain Soul cast');
    assert.deepStrictEqual(drainTarget.absorbed, [{ id: drainSession.actor.fetchId(), absorbedHp: 50 }], 'Drain Soul should mark the selected low-HP monster as absorbed');
    assert(drainSession.packets.length > 0, 'Drain Soul item use should emit cast packets');

    const healthyTarget = attackableNpc({ id: 3000102, hp: 51, maxHp: 100 });
    World.npc = { spawns: [healthyTarget] };
    const rejectedBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    rejectedBackpack.items = [
        item(21, { selfId: 4631, kind: 'Other.Scroll', amount: 1 })
    ];
    const rejectedSession = sessionFor(rejectedBackpack, { destId: healthyTarget.fetchId(), mp: 50 });
    rejectedBackpack.useItem(rejectedSession, 21);
    assert.strictEqual(rejectedBackpack.fetchItemFromSelfId(4631).fetchAmount(), 1, 'Soul Crystal should not be consumed when target HP is above 50%');
    assert.strictEqual(rejectedSession.actor.fetchMp(), 50, 'Soul Crystal should not consume MP when target HP is above 50%');
    assert.deepStrictEqual(healthyTarget.absorbed, [], 'Soul Crystal should not mark a monster above the sourced 50% HP threshold');
    assert.strictEqual(rejectedSession.packets.length, 0, 'Soul Crystal should not start a cast when target HP is above 50%');
} finally {
    global.setTimeout = originalSoulCrystalSetTimeout;
}

const manorSeedItemsByLevel = {
    1: [
        5016, 5017, 5018, 5019, 5020, 5021, 5022, 5024, 5025, 5026, 5027, 5042, 5043, 5044, 5650,
        5651, 5652, 5653, 5654, 5655, 5656, 5658, 5659, 5660, 5661, 5676, 5677, 5678, 7020, 7026,
        7034, 7040
    ],
    2: [
        5023, 5028, 5029, 5030, 5031, 5032, 5033, 5034, 5035, 5036, 5037, 5038, 5045, 5046, 5047,
        5048, 5053, 5054, 5055, 5221, 5222, 5223, 5224, 5225, 5657, 5662, 5663, 5664, 5665, 5666,
        5667, 5668, 5669, 5670, 5671, 5672, 5679, 5680, 5681, 5682, 5687, 5688, 5689, 5696, 5697,
        5698, 5699, 5700, 7016, 7019, 7025, 7027, 7030, 7033, 7039, 7041, 7044, 7051
    ],
    3: [
        5039, 5040, 5041, 5049, 5050, 5051, 5052, 5056, 5057, 5058, 5059, 5060, 5061, 5226, 5227,
        5673, 5674, 5675, 5683, 5684, 5685, 5686, 5690, 5691, 5692, 5693, 5694, 5695, 5701, 5702,
        6727, 6728, 6729, 6730, 6731, 6732, 6733, 6734, 6735, 6736, 6737, 6738, 6739, 6740, 6741,
        6742, 6743, 6744, 6745, 6746, 6747, 6748, 6749, 6750, 6751, 6752, 6753, 6754, 6755, 6756,
        6757, 6758, 6759, 6760, 6761, 6762, 6763, 6764, 6765, 6766, 6767, 6768, 6769, 6770, 6771,
        6772, 6773, 6774, 6775, 6776, 6777, 6778, 7017, 7018, 7021, 7022, 7023, 7024, 7028, 7029,
        7031, 7032, 7035, 7036, 7037, 7038, 7042, 7043, 7045, 7046, 7047, 7048, 7049, 7050, 7052,
        7053, 7054, 7055, 7056, 7057
    ]
};

Object.entries(manorSeedItemsByLevel).forEach(([level, itemIds]) => {
    itemIds.forEach((itemId) => {
        const itemSkill = C4ItemSkills.resolve(itemId);
        assert(itemSkill, `Manor seed item ${itemId} should resolve to an item skill`);
        assert.strictEqual(itemSkill.skillId, 2097, `Manor seed item ${itemId} should use sourced Sowing skill`);
        assert.strictEqual(itemSkill.level, Number(level), `Manor seed item ${itemId} should preserve sourced item_skill level`);
        assert.strictEqual(itemSkill.consume, false, `Manor seed item ${itemId} should be consumed by Sowing logic, not generic item use`);
        const sowing = blessedEscapeBackpack.buildItemSkill(itemSkill);
        assert(sowing, `Manor seed item ${itemId} should build Sowing skill`);
        assert.strictEqual(sowing.fetchSkillType(), C4SkillRules.SOW, `Manor seed item ${itemId} should preserve SOW semantics`);
        assert.strictEqual(sowing.fetchTargetKind(), 'enemy', `Manor seed item ${itemId} should preserve TARGET_ONE semantics`);
        assert.strictEqual(sowing.fetchHitTime(), 1800, `Manor seed item ${itemId} should preserve sourced 1800ms hitTime`);
        assert.strictEqual(sowing.fetchReuseTime(), 8000, `Manor seed item ${itemId} should preserve sourced 8000ms reuse`);
        assert.strictEqual(sowing.fetchConsumedMp(), { 1: 4, 2: 6, 3: 8 }[level], `Manor seed item ${itemId} should preserve sourced mpConsume`);
        assert.strictEqual(sowing.fetchSemantic().castRange, 150, `Manor seed item ${itemId} should preserve sourced castRange`);
        assert.strictEqual(sowing.fetchSemantic().effectRange, 350, `Manor seed item ${itemId} should preserve sourced effectRange`);
        assert.strictEqual(sowing.fetchSemantic().nextActionAttack, true, `Manor seed item ${itemId} should preserve sourced nextActionAttack`);
    });
});

const harvesterItemSkill = C4ItemSkills.resolve(5125);
assert(harvesterItemSkill, 'Harvester should resolve to an item skill');
assert.strictEqual(harvesterItemSkill.skillId, 2098, 'Harvester should use sourced Harvesting skill');
assert.strictEqual(harvesterItemSkill.level, 1, 'Harvester should preserve sourced item_skill level 1');
assert.strictEqual(harvesterItemSkill.consume, false, 'Harvester should not be consumed as a simple item skill');
const harvesting = blessedEscapeBackpack.buildItemSkill(harvesterItemSkill);
assert(harvesting, 'Harvester should build Harvesting skill');
assert.strictEqual(harvesting.fetchSkillType(), C4SkillRules.HARVEST, 'Harvester should preserve HARVEST semantics');
assert.strictEqual(harvesting.fetchTargetKind(), 'corpse_mob', 'Harvester should preserve TARGET_CORPSE_MOB semantics');
assert.strictEqual(harvesting.fetchHitTime(), 500, 'Harvester should preserve sourced 500ms hitTime');
assert.strictEqual(harvesting.fetchReuseTime(), 8000, 'Harvester should preserve sourced 8000ms reuse');
assert.strictEqual(harvesting.fetchConsumedMp(), 3, 'Harvester should preserve sourced mpConsume 3');
assert.strictEqual(harvesting.fetchSemantic().castRange, 20, 'Harvester should preserve sourced castRange');
assert.strictEqual(harvesting.fetchSemantic().effectRange, 100, 'Harvester should preserve sourced effectRange');

assert.strictEqual(ManorData.sowSuccessChance(5016, 10, 10), 90, 'Dark Coda should use sourced normal 90% sow base chance');
assert.strictEqual(ManorData.sowSuccessChance(5650, 10, 10), 20, 'Alternative Dark Coda should use sourced 20% sow base chance');
assert.strictEqual(ManorData.harvestSuccessChance(10, 10), 100, 'Harvest should use sourced 100% base chance near target level');

const originalManorSetTimeout = global.setTimeout;
const originalManorRandom = Math.random;
const originalWorldPurchaseItem = World.purchaseItem;
global.setTimeout = (callback) => {
    callback();
    return 0;
};
Math.random = () => 0;

try {
    const manorTarget = manorNpc({ id: 3000201, level: 10, locX: 10 });
    const manorBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    manorBackpack.items = [
        item(30, { selfId: 5016, kind: 'Other.Seed', amount: 2 }),
        item(31, { selfId: 5125, kind: 'Other.Tool', amount: 1 })
    ];
    const awarded = [];
    World.npc = { spawns: [manorTarget] };
    World.purchaseItem = (session, selfId, amount) => {
        awarded.push({ selfId, amount });
    };

    const manorSession = sessionFor(manorBackpack, { destId: manorTarget.fetchId(), level: 10, mp: 20 });
    manorBackpack.useItem(manorSession, 30);
    assert.strictEqual(manorBackpack.fetchItemFromSelfId(5016).fetchAmount(), 1, 'Sowing should consume one seed after a valid sourced cast');
    assert.strictEqual(manorSession.actor.fetchMp(), 16, 'Sowing should consume sourced mpConsume 4');
    assert.strictEqual(manorTarget.model.manor.seeded, true, 'Sowing should mark the monster as seeded on sourced success');
    assert.strictEqual(manorTarget.model.manor.seedId, 5016, 'Sowing should remember the sourced seed item id');
    assert.deepStrictEqual(manorTarget.model.manor.harvestItems, [{ selfId: 5073, amount: 6 }], 'Sowing should prepare sourced crop harvest count');

    manorTarget.setDead(true);
    manorBackpack.useItem(manorSession, 31);
    assert.strictEqual(manorSession.actor.fetchMp(), 13, 'Harvesting should consume sourced mpConsume 3');
    assert.strictEqual(manorBackpack.fetchItemFromSelfId(5125).fetchAmount(), 1, 'Harvester should not be consumed');
    assert.deepStrictEqual(awarded, [{ selfId: 5073, amount: 6 }], 'Harvesting should award the crop prepared from sourced seed data');
    assert.deepStrictEqual(manorTarget.model.manor.harvestItems, [], 'Harvesting should clear harvested crop rewards');

    const missingSeedDataTarget = manorNpc({ id: 3000202, level: 70, locX: 100 });
    World.npc = { spawns: [missingSeedDataTarget] };
    const missingSeedBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    missingSeedBackpack.items = [
        item(32, { selfId: 6734, kind: 'Other.Seed', amount: 1 })
    ];
    const missingSeedSession = sessionFor(missingSeedBackpack, { destId: missingSeedDataTarget.fetchId(), level: 70, mp: 20 });
    missingSeedBackpack.useItem(missingSeedSession, 32);
    assert.strictEqual(missingSeedBackpack.fetchItemFromSelfId(6734).fetchAmount(), 1, 'Sowing should not consume seed items without sourced seed metadata');
    assert.strictEqual(missingSeedSession.actor.fetchMp(), 20, 'Sowing should not consume MP when sourced seed metadata is missing');
    assert.strictEqual(missingSeedDataTarget.model.manor, undefined, 'Sowing should not create manor state without sourced seed metadata');
} finally {
    global.setTimeout = originalManorSetTimeout;
    Math.random = originalManorRandom;
    World.purchaseItem = originalWorldPurchaseItem;
}

const facePotionC = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5237));
assert(facePotionC, 'Facelifting Potion - C should resolve to an item skill');
assert.strictEqual(facePotionC.fetchSelfId(), 2124, 'Facelifting Potion - C should use sourced skill 2124');
assert.strictEqual(facePotionC.fetchPower(), 2, 'Facelifting Potion - C should preserve sourced cosmetic power 2');
assert.strictEqual(facePotionC.fetchHitTime(), 500, 'Facelifting Potion - C should preserve sourced 500ms hitTime');
assert.strictEqual(facePotionC.fetchSkillType(), C4SkillRules.COSMETIC_FACE_LIFT, 'Facelifting Potion - C should preserve sourced FACE_LIFT semantics');
assert.strictEqual(facePotionC.fetchTargetKind(), 'self', 'Facelifting Potion - C should preserve sourced self target');
assert.strictEqual(facePotionC.fetchSemantic().cosmeticValue, 2, 'Facelifting Potion - C should preserve sourced cosmetic index');
assert.strictEqual(facePotionC.fetchSemantic().isPotion, true, 'Facelifting Potion - C should preserve sourced potion metadata');

const dyePotionD = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5241));
assert(dyePotionD, 'Dye Potion - D should resolve to an item skill');
assert.strictEqual(dyePotionD.fetchSelfId(), 2128, 'Dye Potion - D should use sourced skill 2128');
assert.strictEqual(dyePotionD.fetchPower(), 3, 'Dye Potion - D should preserve sourced cosmetic power 3');
assert.strictEqual(dyePotionD.fetchSkillType(), C4SkillRules.COSMETIC_HAIR_COLOR, 'Dye Potion - D should preserve sourced HAIR_COLOR semantics');
assert.strictEqual(dyePotionD.fetchSemantic().cosmeticValue, 3, 'Dye Potion - D should preserve sourced cosmetic index');

const hairPotionG = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5248));
assert(hairPotionG, 'Hair Style Change Potion - G should resolve to an item skill');
assert.strictEqual(hairPotionG.fetchSelfId(), 2135, 'Hair Style Change Potion - G should use sourced skill 2135');
assert.strictEqual(hairPotionG.fetchPower(), 6, 'Hair Style Change Potion - G should preserve sourced cosmetic power 6');
assert.strictEqual(hairPotionG.fetchSkillType(), C4SkillRules.COSMETIC_HAIR_STYLE, 'Hair Style Change Potion - G should preserve sourced HAIR_STYLE semantics');
assert.strictEqual(hairPotionG.fetchSemantic().cosmeticValue, 6, 'Hair Style Change Potion - G should preserve sourced cosmetic index');

const riceCake = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5283));
assert(riceCake, 'Rice Cake should resolve to an item skill');
assert.strictEqual(riceCake.fetchSelfId(), 2136, 'Rice Cake should use sourced skill 2136');
assert.strictEqual(riceCake.fetchPower(), 3, 'Rice Cake should preserve sourced HEAL_PERCENT power 3');
assert.strictEqual(riceCake.fetchSkillType(), C4SkillRules.HEAL_PERCENT, 'Rice Cake should preserve sourced HEAL_PERCENT semantics');
assert.strictEqual(riceCake.fetchSemantic().manaHealPercent, 1, 'Rice Cake should preserve sourced MP 1% core-support behavior');

const riceBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
riceBackpack.items = [
    item(47, { selfId: 5283, kind: 'Other.Potion', amount: 1 })
];
const riceSession = sessionFor(riceBackpack, { hp: 50, maxHp: 100, mp: 10, maxMp: 200 });
riceBackpack.useItem(riceSession, 47);
assert.strictEqual(riceBackpack.fetchItemFromSelfId(5283), undefined, 'Rice Cake should consume one item on successful use');
assert.strictEqual(riceSession.actor.fetchHp(), 53, 'Rice Cake should restore sourced 3% HP');
assert.strictEqual(riceSession.actor.fetchMp(), 12, 'Rice Cake should restore sourced 1% MP');

const firstCarolCrystal = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5562));
assert(firstCarolCrystal, 'Echo Crystal - 1st Carol should resolve to an item skill');
assert.strictEqual(firstCarolCrystal.fetchSelfId(), 2140, 'Echo Crystal - 1st Carol should use sourced skill 2140');
assert.strictEqual(firstCarolCrystal.fetchSkillType(), C4SkillRules.DUMMY, 'Echo Crystal - 1st Carol should preserve sourced DUMMY semantics');
assert.strictEqual(firstCarolCrystal.fetchTargetKind(), 'self', 'Echo Crystal - 1st Carol should preserve sourced self target');
assert.strictEqual(firstCarolCrystal.fetchSemantic().isPotion, true, 'Echo Crystal - 1st Carol should preserve sourced potion metadata');

const tenthCarolCrystal = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5587));
assert(tenthCarolCrystal, 'Echo Crystal - 10th Carol should resolve to an item skill');
assert.strictEqual(tenthCarolCrystal.fetchSelfId(), 2149, 'Echo Crystal - 10th Carol should use sourced skill 2149');

const musicBox = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6903));
assert(musicBox, 'Music Box M should resolve to an item skill');
assert.strictEqual(musicBox.fetchSelfId(), 2187, 'Music Box M should use sourced skill 2187');
assert.strictEqual(musicBox.fetchSkillType(), C4SkillRules.DUMMY, 'Music Box M should preserve sourced DUMMY semantics');

const weddingThemeCrystal = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(7062));
assert(weddingThemeCrystal, 'Echo Crystal - Theme of Wedding should resolve to an item skill');
assert.strictEqual(weddingThemeCrystal.fetchSelfId(), 2230, 'Echo Crystal - Theme of Wedding should use sourced skill 2230');
assert.strictEqual(weddingThemeCrystal.fetchTargetKind(), 'self', 'Echo Crystal - Theme of Wedding should preserve sourced self target');

const giranEscape = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(7126));
assert(giranEscape, 'Scroll of Escape: Giran Castle Town should resolve to an item skill');
assert.strictEqual(giranEscape.fetchSelfId(), 2213, 'Scroll of Escape: Giran Castle Town should use sourced skill 2213');
assert.strictEqual(giranEscape.fetchLevel(), 10, 'Scroll of Escape: Giran Castle Town should preserve sourced item_skill level 10');
assert.deepStrictEqual(giranEscape.fetchTeleportCoords(), { locX: 83400, locY: 147943, locZ: -3404 }, 'Scroll of Escape: Giran Castle Town should preserve sourced coordinates');

const ketraEscape = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(7618));
assert(ketraEscape, 'Scroll of Escape: Ketra Orc Village should resolve to an item skill');
assert.strictEqual(ketraEscape.fetchLevel(), 20, 'Scroll of Escape: Ketra Orc Village should preserve sourced item_skill level 20');
assert.deepStrictEqual(ketraEscape.fetchTeleportCoords(), { locX: 149864, locY: -81062, locZ: -5618 }, 'Scroll of Escape: Ketra Orc Village should preserve sourced coordinates');

const dwarvenVillageEscape = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(7558));
assert(dwarvenVillageEscape, 'Scroll of Escape: Dwarven Village should resolve to an item skill');
assert.strictEqual(dwarvenVillageEscape.fetchSelfId(), 2214, 'Scroll of Escape: Dwarven Village should use sourced skill 2214');
assert.strictEqual(dwarvenVillageEscape.fetchLevel(), 5, 'Scroll of Escape: Dwarven Village should preserve sourced item_skill level 5');
assert.deepStrictEqual(dwarvenVillageEscape.fetchTeleportCoords(), { locX: 115113, locY: -178212, locZ: -901 }, 'Scroll of Escape: Dwarven Village should preserve sourced coordinates');

const wolfCollar = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(2375));
assert(wolfCollar, 'Wolf Collar should resolve to an item skill');
assert.strictEqual(wolfCollar.fetchSelfId(), 2046, 'Wolf Collar should use sourced skill 2046');
assert.strictEqual(wolfCollar.fetchHitTime(), 5000, 'Wolf Collar should preserve sourced 5000ms summon hitTime');

const striderFood = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5168));
assert(striderFood, 'Food for Strider should resolve to an item skill');
assert.strictEqual(striderFood.fetchSelfId(), 2101, 'Food for Strider should use sourced skill 2101');
assert.strictEqual(striderFood.fetchSemantic().feed, 200, 'Food for Strider should preserve sourced feed 200 metadata');

const deluxeStriderFood = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5169));
assert(deluxeStriderFood, 'Deluxe Food for Strider should resolve to an item skill');
assert.strictEqual(deluxeStriderFood.fetchSelfId(), 2102, 'Deluxe Food for Strider should use sourced skill 2102');
assert.strictEqual(deluxeStriderFood.fetchSemantic().feed, 450, 'Deluxe Food for Strider should preserve sourced feed 450 metadata');

const wyvernFood = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6316));
assert(wyvernFood, 'Food for Wyvern should resolve to an item skill');
assert.strictEqual(wyvernFood.fetchSelfId(), 2180, 'Food for Wyvern should use sourced skill 2180');
assert.strictEqual(wyvernFood.fetchSemantic().feed, 450, 'Food for Wyvern should preserve sourced feed 450 metadata');

const mysteryPotion = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5234));
assert(mysteryPotion, 'Mystery Potion should resolve to an item skill');
assert.strictEqual(mysteryPotion.fetchSelfId(), 2103, 'Mystery Potion should use sourced skill 2103');
assert.strictEqual(mysteryPotion.fetchBuffTime(), 1200000, 'Mystery Potion should preserve sourced BigHead 1200s duration');
assert.strictEqual(mysteryPotion.fetchSkillType(), C4SkillRules.EFFECT, 'Mystery Potion should preserve sourced BUFF semantics');
assert.strictEqual(mysteryPotion.fetchSemantic().effect, 'big_head', 'Mystery Potion should preserve sourced BigHead effect metadata');

const luckyCharmS = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5807));
assert(luckyCharmS, 'Lucky Charm: S Grade should resolve to an item skill');
assert.strictEqual(luckyCharmS.fetchSelfId(), 2168, 'Lucky Charm should use sourced Raid Blessing skill 2168');
assert.strictEqual(luckyCharmS.fetchLevel(), 6, 'Lucky Charm: S Grade should preserve sourced item_skill level 6');
assert.strictEqual(luckyCharmS.fetchHitTime(), 2000, 'Lucky Charm should preserve sourced 2000ms static hitTime');
assert.strictEqual(luckyCharmS.fetchBuffTime(), 3600000, 'Lucky Charm should preserve sourced CharmOfLuck 3600s duration');
assert.strictEqual(luckyCharmS.fetchSkillType(), C4SkillRules.EFFECT, 'Lucky Charm should preserve sourced BUFF semantics');
assert.strictEqual(luckyCharmS.fetchSemantic().effect, 'charm_of_luck', 'Lucky Charm should preserve sourced CharmOfLuck effect metadata');

const mysteryBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
mysteryBackpack.items = [
    item(45, { selfId: 5234, kind: 'Other.Potion', amount: 1 })
];
const mysterySession = sessionFor(mysteryBackpack);
mysteryBackpack.useItem(mysterySession, 45);
assert.strictEqual(mysteryBackpack.fetchItemFromSelfId(5234), undefined, 'Mystery Potion should consume one item on successful use');
assert.strictEqual(mysterySession.actor.effects.big_head.id, 2103, 'Mystery Potion should apply sourced BigHead effect');
assert.strictEqual(mysterySession.actor.effects.big_head.level, 1, 'Mystery Potion should apply sourced effect level 1');

const savedLuckyCharmSetTimeout = global.setTimeout;
global.setTimeout = (callback) => {
    callback();
    return 0;
};

try {
    const luckyBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    luckyBackpack.items = [
        item(46, { selfId: 5807, kind: 'Other.Scroll', amount: 1 })
    ];
    const luckySession = sessionFor(luckyBackpack);
    luckyBackpack.useItem(luckySession, 46);
    assert.strictEqual(luckyBackpack.fetchItemFromSelfId(5807), undefined, 'Lucky Charm should consume one item on successful use');
    assert.strictEqual(luckySession.actor.effects.charm_of_luck.id, 2168, 'Lucky Charm should apply sourced CharmOfLuck effect');
    assert.strictEqual(luckySession.actor.effects.charm_of_luck.level, 6, 'Lucky Charm should apply sourced item_skill level');
} finally {
    global.setTimeout = savedLuckyCharmSetTimeout;
}

const petResurrection = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6387));
assert(petResurrection, 'Blessed Scroll of Resurrection for Pets should resolve to an item skill');
assert.strictEqual(petResurrection.fetchSelfId(), 2179, 'Blessed Scroll of Resurrection for Pets should use sourced skill 2179');
assert.strictEqual(petResurrection.fetchPower(), 100, 'Blessed Scroll of Resurrection for Pets should preserve sourced power 100');
assert.strictEqual(petResurrection.fetchSemantic().itemConsumeId, 6387, 'Blessed Scroll of Resurrection for Pets should preserve sourced item consume id');

const magicHastePotion = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6035));
assert(magicHastePotion, 'Magic Haste Potion should resolve to an item skill');
assert.strictEqual(magicHastePotion.fetchSelfId(), 2169, 'Magic Haste Potion should use sourced skill 2169');
assert.strictEqual(magicHastePotion.fetchLevel(), 1, 'Magic Haste Potion should preserve sourced item_skill level 1');
assert.strictEqual(magicHastePotion.fetchSkillType(), C4SkillRules.EFFECT, 'Magic Haste Potion should preserve sourced BUFF semantics');
assert.strictEqual(magicHastePotion.fetchSemantic().stats.castSpdMul, 1.23, 'Magic Haste Potion should preserve sourced mAtkSpd 1.23 as cast speed multiplier');

const greaterMagicHastePotion = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6036));
assert(greaterMagicHastePotion, 'Greater Magic Haste Potion should resolve to an item skill');
assert.strictEqual(greaterMagicHastePotion.fetchLevel(), 2, 'Greater Magic Haste Potion should preserve sourced item_skill level 2');
assert.strictEqual(greaterMagicHastePotion.fetchSemantic().stats.castSpdMul, 1.3, 'Greater Magic Haste Potion should preserve sourced mAtkSpd 1.3 as cast speed multiplier');

const energyStone = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5589));
assert(energyStone, 'Energy Stone should resolve to an item skill');
assert.strictEqual(energyStone.fetchSelfId(), 2165, 'Energy Stone should use sourced skill 2165');
assert.strictEqual(energyStone.fetchPower(), 2, 'Energy Stone should preserve sourced maxCharges 2');
assert.strictEqual(energyStone.fetchSkillType(), C4SkillRules.CHARGE, 'Energy Stone should preserve sourced CHARGE semantics');
assert.strictEqual(energyStone.fetchSemantic().maxCharges, 2, 'Energy Stone should preserve sourced maxCharges metadata');

const wakingScroll = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6037));
assert(wakingScroll, 'Waking Scroll should resolve to an item skill');
assert.strictEqual(wakingScroll.fetchSelfId(), 2170, 'Waking Scroll should use sourced skill 2170');
assert.strictEqual(wakingScroll.fetchPower(), 9, 'Waking Scroll should preserve sourced negatePower 9');
assert.strictEqual(wakingScroll.fetchSkillType(), C4SkillRules.CLEANSE, 'Waking Scroll should preserve sourced NEGATE/CLEANSE semantics');
assert.strictEqual(wakingScroll.fetchTargetKind(), 'friendly', 'Waking Scroll should preserve sourced TARGET_ONE as targeted playable cleanse');
assert.strictEqual(wakingScroll.fetchSemantic().castRange, 400, 'Waking Scroll should preserve sourced castRange 400');
assert.strictEqual(wakingScroll.fetchSemantic().effectRange, 600, 'Waking Scroll should preserve sourced effectRange 600');
assert.deepStrictEqual(wakingScroll.fetchSemantic().negateStats, ['SLEEP'], 'Waking Scroll should preserve sourced negateStats SLEEP metadata');
assert.strictEqual(wakingScroll.fetchSemantic().negatePower, 9, 'Waking Scroll should preserve sourced negatePower metadata');

const cpPotion = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5591));
assert(cpPotion, 'CP Potion should resolve to an item skill');
assert.strictEqual(cpPotion.fetchSelfId(), 2166, 'CP Potion should use sourced skill 2166');
assert.strictEqual(cpPotion.fetchPower(), 50, 'CP Potion should preserve sourced CP power 50');
assert.strictEqual(cpPotion.fetchSkillType(), C4SkillRules.COMBAT_POINT_HEAL, 'CP Potion should preserve sourced COMBATPOINTHEAL semantics');
assert.strictEqual(cpPotion.fetchSemantic().isPotion, true, 'CP Potion should preserve sourced potion metadata');

const greaterCpPotion = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5592));
assert(greaterCpPotion, 'Greater CP Potion should resolve to an item skill');
assert.strictEqual(greaterCpPotion.fetchLevel(), 2, 'Greater CP Potion should preserve sourced item_skill level 2');
assert.strictEqual(greaterCpPotion.fetchPower(), 200, 'Greater CP Potion should preserve sourced CP power 200');

const highSpScroll = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5595));
assert(highSpScroll, 'SP Scroll: High Grade should resolve to an item skill');
assert.strictEqual(highSpScroll.fetchSelfId(), 2167, 'SP Scroll should use sourced skill 2167');
assert.strictEqual(highSpScroll.fetchLevel(), 3, 'SP Scroll: High Grade should preserve sourced item_skill level 3');
assert.strictEqual(highSpScroll.fetchPower(), 100000, 'SP Scroll: High Grade should preserve sourced SP reward 100000');
assert.strictEqual(highSpScroll.fetchHitTime(), 200, 'SP Scroll should preserve sourced 200ms static hitTime');
assert.strictEqual(highSpScroll.fetchReuseTime(), 3000, 'SP Scroll should preserve sourced 3000ms reuse');
assert.strictEqual(highSpScroll.fetchSkillType(), C4SkillRules.GIVE_SP, 'SP Scroll should preserve sourced GIVE_SP semantics');

const magicHasteBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
magicHasteBackpack.items = [
    item(42, { selfId: 6036, kind: 'Other.Potion', amount: 2 })
];
const magicHasteSession = sessionFor(magicHasteBackpack);
magicHasteBackpack.useItem(magicHasteSession, 42);
assert.strictEqual(magicHasteBackpack.fetchItemFromSelfId(6036).fetchAmount(), 1, 'Greater Magic Haste Potion should consume one item on successful use');
assert.strictEqual(EffectStats.multiplier(magicHasteSession.actor, 'castSpdMul'), 1.3, 'Greater Magic Haste Potion should apply sourced cast speed multiplier');

const energyBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
energyBackpack.items = [
    item(49, { selfId: 5589, kind: 'Other.Potion', amount: 2 })
];
const energySession = sessionFor(energyBackpack, { charges: 1 });
energyBackpack.useItem(energySession, 49);
assert.strictEqual(energyBackpack.fetchItemFromSelfId(5589).fetchAmount(), 1, 'Energy Stone should consume one item on successful use');
assert.strictEqual(energySession.actor.fetchCharges(), 2, 'Energy Stone should increase charges up to sourced maxCharges 2');
assert(energySession.packets.some((packet) => packet[0] === 0xf3 && packet.readInt32LE(1) === 2), 'Energy Stone should emit C4 EtcStatusUpdate with current charges');

const savedWorldUsersForWaking = World.user;
try {
    const wakingTarget = playableTarget({ id: 2000010, locX: 100 });
    EffectStore.apply(wakingTarget, {
        key: 'sleep',
        id: 1069,
        level: 9,
        type: 'debuff',
        category: 'sleep',
        durationMs: 30000
    });
    EffectStore.apply(wakingTarget, {
        key: 'deep_sleep',
        id: 1072,
        level: 10,
        type: 'debuff',
        category: 'sleep',
        durationMs: 30000
    });
    World.user = { sessions: [wakingTarget.session] };

    const wakingBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    wakingBackpack.items = [
        item(48, { selfId: 6037, kind: 'Other.Scroll', amount: 1 })
    ];
    const wakingSession = sessionFor(wakingBackpack, { destId: wakingTarget.fetchId() });
    wakingBackpack.useItem(wakingSession, 48);
    assert.strictEqual(wakingBackpack.fetchItemFromSelfId(6037), undefined, 'Waking Scroll should consume one scroll on valid targeted cleanse');
    assert.strictEqual(EffectStore.hasDebuff(wakingTarget, 'sleep'), true, 'Waking Scroll should leave sleep above sourced negatePower 9');
    assert.strictEqual(wakingTarget.effects.sleep, undefined, 'Waking Scroll should remove sleep up to sourced negatePower 9');
    assert.strictEqual(wakingTarget.effects.deep_sleep.level, 10, 'Waking Scroll should not remove level 10 sleep above sourced negatePower');
    assert(wakingTarget.session.packets.some((packet) => packet[0] === 0x7f), 'Waking Scroll should refresh target abnormal status');
} finally {
    World.user = savedWorldUsersForWaking;
}

const cpBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
cpBackpack.items = [
    item(43, { selfId: 5592, kind: 'Other.Potion', amount: 2 })
];
const cpSession = sessionFor(cpBackpack, { cp: 850, maxCp: 1000 });
cpBackpack.useItem(cpSession, 43);
assert.strictEqual(cpBackpack.fetchItemFromSelfId(5592).fetchAmount(), 1, 'Greater CP Potion should consume one item on successful use');
assert.strictEqual(cpSession.actor.fetchCp(), 1000, 'Greater CP Potion should add sourced CP power and clamp to max CP');
assert(cpSession.packets.some((packet) => packet[0] === 0x0e && packet.readInt32LE(1) === cpSession.actor.fetchId()), 'Greater CP Potion should emit a CP status update');

const savedSpScrollSetTimeout = global.setTimeout;
global.setTimeout = (callback) => {
    callback();
    return 0;
};

try {
    const spBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    spBackpack.items = [
        item(44, { selfId: 5595, kind: 'Other.Scroll', amount: 1 })
    ];
    const spSession = sessionFor(spBackpack, { sp: 10, maxCp: 100 });
    spBackpack.useItem(spSession, 44);
    assert.strictEqual(spBackpack.fetchItemFromSelfId(5595), undefined, 'SP Scroll should consume one scroll on successful use');
    assert.strictEqual(spSession.actor.fetchSp(), 100010, 'SP Scroll should add sourced SP reward without exp');
    assert(spSession.packets.some((packet) => packet[0] === 0x04), 'SP Scroll should refresh UserInfo after SP changes');
} finally {
    global.setTimeout = savedSpScrollSetTimeout;
}

const deluxeChestKey = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6672));
assert(deluxeChestKey, 'Deluxe Chest Key - Grade 8 should resolve to an item skill');
assert.strictEqual(deluxeChestKey.fetchSelfId(), 2229, 'Deluxe Chest Key - Grade 8 should use sourced skill 2229');
assert.strictEqual(deluxeChestKey.fetchLevel(), 8, 'Deluxe Chest Key - Grade 8 should preserve sourced item_skill level 8');
assert.strictEqual(deluxeChestKey.fetchHitTime(), 500, 'Deluxe Chest Key - Grade 8 should preserve sourced 500ms hitTime');
assert.strictEqual(deluxeChestKey.fetchSemantic().itemConsumeId, 6672, 'Deluxe Chest Key - Grade 8 should preserve sourced level-specific consume id');

const chestKeyGrade8 = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5197));
assert(chestKeyGrade8, 'Chest Key - Grade 8 should resolve to an item skill');
assert.strictEqual(chestKeyGrade8.fetchSelfId(), 2065, 'Chest Key - Grade 8 should use sourced skill 2065');
assert.strictEqual(chestKeyGrade8.fetchLevel(), 1, 'Chest Key - Grade 8 should preserve sourced item_skill level 1');
assert.strictEqual(chestKeyGrade8.fetchHitTime(), 500, 'Chest Key - Grade 8 should preserve sourced 500ms hitTime');

const chestKeyGrade1 = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(5204));
assert(chestKeyGrade1, 'Chest Key - Grade 1 should resolve to an item skill');
assert.strictEqual(chestKeyGrade1.fetchSelfId(), 2065, 'Chest Key - Grade 1 should use sourced skill 2065');
assert.strictEqual(chestKeyGrade1.fetchLevel(), 8, 'Chest Key - Grade 1 should preserve sourced item_skill level 8');

const noGradeCompressedSoulshots = C4ExtractableItems.resolve(5134);
assert(noGradeCompressedSoulshots, 'Compressed Package of Soulshots: No Grade should resolve to extractable data');
assert.deepStrictEqual(noGradeCompressedSoulshots.products, [{ selfId: 1835, amount: 300, chance: 100 }], 'Compressed Package of Soulshots: No Grade should preserve sourced extractable product');
assert.deepStrictEqual(C4ExtractableItems.rollProducts(noGradeCompressedSoulshots, () => 0), [{ selfId: 1835, amount: 300 }], 'Compressed Package of Soulshots: No Grade should roll sourced product');

const sGradeCompressedBlessedSpiritshots = C4ExtractableItems.resolve(5151);
assert(sGradeCompressedBlessedSpiritshots, 'Compressed Package of Blessed Spiritshots: S-grade should resolve to extractable data');
assert.deepStrictEqual(sGradeCompressedBlessedSpiritshots.products, [{ selfId: 3952, amount: 300, chance: 100 }], 'Compressed Package of Blessed Spiritshots: S-grade should preserve sourced extractable product');

const savedExtractWorldPurchaseItem = World.purchaseItem;
try {
    const extractedItems = [];
    World.purchaseItem = (session, selfId, amount) => {
        extractedItems.push({ selfId, amount });
    };

    const extractBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    extractBackpack.items = [
        item(40, { selfId: 5134, kind: 'Other.ShotPack', amount: 1 })
    ];
    const extractSession = sessionFor(extractBackpack);
    extractBackpack.useItem(extractSession, 40);
    assert.strictEqual(extractBackpack.fetchItemFromSelfId(5134), undefined, 'Extractable compressed shot package should consume one source item');
    assert.deepStrictEqual(extractedItems, [{ selfId: 1835, amount: 300 }], 'Extractable compressed shot package should award sourced shot stack');
} finally {
    World.purchaseItem = savedExtractWorldPurchaseItem;
}

const crystalEnchantWeaponA = C4EnchantScrolls.resolve(731);
assert.deepStrictEqual(crystalEnchantWeaponA, { grade: 'A', target: 'weapon', scrollType: 'crystal' }, 'Crystal Scroll: Enchant Weapon (A) should preserve sourced enchant handler metadata');
const blessedEnchantArmorS = C4EnchantScrolls.resolve(6578);
assert.deepStrictEqual(blessedEnchantArmorS, { grade: 'S', target: 'armor', scrollType: 'blessed' }, 'Blessed Scroll: Enchant Armor (S) should preserve sourced enchant handler metadata');

const enchantBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
enchantBackpack.items = [
    item(41, { selfId: 731, kind: 'Other.Scroll', amount: 1 })
];
const enchantSession = sessionFor(enchantBackpack);
enchantBackpack.useItem(enchantSession, 41);
assert.strictEqual(enchantBackpack.fetchItemFromSelfId(731).fetchAmount(), 1, 'Enchant scroll use should not consume the scroll before RequestEnchantItem');
assert.deepStrictEqual(enchantSession.activeEnchantItem, { itemId: 41, selfId: 731, enchantScroll: crystalEnchantWeaponA }, 'Enchant scroll use should set active enchant item state');
assert.strictEqual(enchantSession.packets[0][0], 0x6f, 'Enchant scroll use should send C4 ChooseInventoryItem packet');
assert.strictEqual(enchantSession.packets[0].readInt32LE(1), 731, 'ChooseInventoryItem should include sourced scroll item id');

World.user = { sessions: [] };

const originalSetTimeout = global.setTimeout;
global.setTimeout = (callback) => {
    callback();
    return 0;
};

try {
    const resTarget = resurrectionTarget();
    World.user.sessions.push({ actor: resTarget });
    const resBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    resBackpack.items = [
        item(2, { selfId: 737, kind: 'Other.Scroll', amount: 1 })
    ];
    const resSession = sessionFor(resBackpack, { destId: resTarget.fetchId() });
    resBackpack.useItem(resSession, 2);
    assert.strictEqual(resBackpack.fetchItemFromSelfId(737), undefined, 'Scroll of Resurrection should consume sourced item 737 on valid cast start');
    assert.strictEqual(resTarget.wasRevived(), true, 'Scroll of Resurrection should revive the selected dead player target after cast');
    assert(resSession.packets.length > 0, 'Scroll of Resurrection should emit skill/item packets when used');

    const livingTarget = resurrectionTarget({ id: 2000003, dead: false });
    World.user.sessions = [{ actor: livingTarget }];
    const invalidBackpack = new Backpack({ paperdoll: Array.from({ length: 16 }, () => ({})), items: [] });
    invalidBackpack.items = [
        item(3, { selfId: 3936, kind: 'Other.Scroll', amount: 1 })
    ];
    const invalidSession = sessionFor(invalidBackpack, { destId: livingTarget.fetchId() });
    invalidBackpack.useItem(invalidSession, 3);
    assert.strictEqual(invalidBackpack.fetchItemFromSelfId(3936).fetchAmount(), 1, 'Blessed Scroll of Resurrection should not consume on living target');
    assert.strictEqual(livingTarget.wasRevived(), false, 'Blessed Scroll of Resurrection should not revive a living target');
} finally {
    global.setTimeout = originalSetTimeout;
}

console.log('Item skill use checks passed');
