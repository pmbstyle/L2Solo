const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
DataCache.init();

const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const Database = invoke('Database');
const EffectStats = invoke('GameServer/Effects/EffectStats');
const C4ItemSkills = invoke('GameServer/Items/C4ItemSkills');
const C4SkillRules = invoke('GameServer/Skills/C4SkillRules');
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
    const actor = {
        backpack,
        effects: {},
        activeBuffs: {},
        fetchId: () => 2000001,
        fetchName: () => 'Tester',
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => options.destId,
        fetchHead: () => 0,
        fetchMp: () => mp,
        setMp(value) { mp = value; },
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

const petResurrection = blessedEscapeBackpack.buildItemSkill(C4ItemSkills.resolve(6387));
assert(petResurrection, 'Blessed Scroll of Resurrection for Pets should resolve to an item skill');
assert.strictEqual(petResurrection.fetchSelfId(), 2179, 'Blessed Scroll of Resurrection for Pets should use sourced skill 2179');
assert.strictEqual(petResurrection.fetchPower(), 100, 'Blessed Scroll of Resurrection for Pets should preserve sourced power 100');
assert.strictEqual(petResurrection.fetchSemantic().itemConsumeId, 6387, 'Blessed Scroll of Resurrection for Pets should preserve sourced item consume id');

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
