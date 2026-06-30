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

const World = invoke('GameServer/World/World');
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
