'use strict';
// Class kits by C4 masteries (user 10-30): a Rogue fights 20-39 with the
// weapon of its own future second class, a bow for a future Hawkeye, a
// dagger for a future Treasure Hunter, and reads that class's table line.
const assert = require('node:assert/strict');
require('../src/Global');
const DataCache = invoke('GameServer/DataCache');
DataCache.init();
const Progression = invoke('GameServer/Bot/BotClassProgression');
const Roles = invoke('GameServer/Bot/AI/BotRoles');
const BotGear = invoke('GameServer/Bot/AI/BotGear');
const Compatibility = invoke('GameServer/Bot/AI/BotEquipmentCompatibility');
const Table = invoke('GameServer/Bot/AI/SpotValueTable');
const HuntCycle = invoke('GameServer/Bot/AI/HuntCycle');
const Index = require('../src/GameServer/Item/ItemTemplateIndex');

const ROGUE = 7, HAWKEYE = 9, TREASURE_HUNTER = 8, LEVEL = 30;
const DAGGER = 'Weapon.Knife'; // the datapack's dagger kind
const idWithFuture = (future) => {
    for (let id = 1; ; id++) if (Progression.futureClass(ROGUE, id) === future) return id;
};
const rogue = (characterId) => ({ characterId, level: LEVEL, stats: { classId: ROGUE } });
const hawkeye = rogue(idWithFuture(HAWKEYE)), hunter = rogue(idWithFuture(TREASURE_HUNTER));

assert.equal(Progression.futureClass(ROGUE, hawkeye.characterId),
    Progression.nextClass(ROGUE, 40, hawkeye.characterId), 'the future is the pick class progression makes at 40');
assert.equal(Progression.futureClass(HAWKEYE, 1), null, 'a second class has no future second class');

assert.equal(Roles.inferRole(hawkeye), 'archer', 'a future Hawkeye Rogue is an archer');
assert.equal(Roles.inferRole(hunter), 'dagger', 'a future Treasure Hunter Rogue is a dagger');
assert.equal(Roles.inferRole(ROGUE), 'dagger', 'a class-only Rogue keeps the dagger role');
const actor = session => ({ fetchId: () => hawkeye.characterId, fetchClassId: () => ROGUE, fetchLevel: () => LEVEL, session });
assert.equal(Roles.inferRole(actor({ botSession: true })), 'archer', 'a bot actor reads its own id');
assert.equal(Roles.inferRole(actor({})), 'dagger', 'a player picks its second class itself: its class role');
assert.equal(Roles.inferRole({ ...hawkeye, accountName: 'player1' }), 'dagger', 'a player row: its class role');
assert.equal(Roles.inferRole({ characterId: hawkeye.characterId, stats: { classId: 4 } }), 'tank', 'other classes keep their role');

// The cold fight reads the same role off the bot's profile (ColdClassPolicy).
const ColdClassPolicy = invoke('GameServer/Bot/Population/ColdClassPolicy');
const coldActor = characterId => ColdClassPolicy.actorFor({ classId: ROGUE, level: LEVEL, characterId, skills: [] },
    { hp: 1, mp: 1, cooldowns: {}, time: 0 });
assert.equal(Roles.combatRoleFor(coldActor(hawkeye.characterId)), 'archer', 'a cold future Hawkeye fights as an archer');
assert.equal(Roles.combatRoleFor(coldActor(null)), 'dagger', 'a cold player Rogue: its class role');

const weaponKind = (state) => {
    const weapon = BotGear.planFor(state).items.find((item) => [7, 14].includes(Number(item.slot)));
    return Index.find(DataCache.items, weapon.selfId)?.template?.kind;
};
assert.equal(weaponKind(hawkeye), 'Weapon.Bow', 'a future Hawkeye gears a bow');
assert.equal(weaponKind(hunter), DAGGER, 'a future Treasure Hunter gears a dagger');
assert(Compatibility.profileFor(Roles.inferRole(hawkeye), ROGUE).weaponKinds.includes('Weapon.Bow'));
assert(!Compatibility.profileFor(Roles.inferRole(hunter), ROGUE).weaponKinds.includes('Weapon.Bow'));

assert.equal(Table.roleFor(hawkeye), String(HAWKEYE), 'a future Hawkeye reads the Hawkeye line');
assert.equal(Table.roleFor(hunter), String(TREASURE_HUNTER), 'a future Treasure Hunter reads its line');

// The table's reference bots: line 9 below 40 is a bow Rogue, line 8 a dagger one.
const referenceKind = (line) => {
    const state = HuntCycle.referenceState(ROGUE, LEVEL, { line });
    const weapon = Object.values(state.inventory).find((item) => [7, 14].includes(item.slot));
    return Index.find(DataCache.items, weapon.selfId)?.template?.kind;
};
assert.equal(referenceKind(HAWKEYE), 'Weapon.Bow');
assert.equal(referenceKind(TREASURE_HUNTER), DAGGER);
assert.equal(referenceKind(null), DAGGER, 'a class-only reference Rogue keeps its dagger');

// The hunt data per class (scripts/hunt-tables) follows the line: a Rogue's
// rows are keyed by its future second class, the very key the spot table's
// line bot has (generate-spot-table botFor), bow for the Hawkeye's.
const HuntKeys = require('../scripts/hunt-tables/common');
const Generator = require('../scripts/generate-spot-table');
const keys = HuntKeys.kitKeys();
assert(['7>8', '7>9', '22>23', '22>24', '35>36', '35>37', '2', '0'].every((key) => keys.includes(key)), 'a split-kit class per future');
assert(!keys.includes('7'), 'no class-only Rogue row: every bot Rogue fights for its future');
assert.equal(Generator.botFor(String(HAWKEYE), LEVEL), '7>9', 'the line\'s bot reads the hunt data of its key');
assert.equal(Generator.botFor(String(TREASURE_HUNTER), LEVEL), '7>8');
const S = require('../scripts/hunt-tables/static-tables');
const M = require('../scripts/hunt-tables/HuntModel');
const bowRow = S.classRow('7>9'), daggerRow = S.classRow('7>8');
assert.equal(bowRow.role, 'archer', 'a future Hawkeye\'s hunt data has the archer role');
assert(bowRow.weaponKinds.includes('Weapon.Bow') && !daggerRow.weaponKinds.includes('Weapon.Bow'), 'bow ladders for line 9 only');
assert.equal(daggerRow.role, 'dagger');
assert.equal(Roles.kitClassId(M.kitState('7>9', LEVEL)), HAWKEYE, 'the hunt model\'s bot of the key fights for its line');

console.log('test_future_class_kit: ok');
