const assert = require('assert');

require('../src/Global');

const Observer = invoke('WorldObserver/WorldObserverServer');
const ColdCombatProfile = invoke('GameServer/Bot/Population/ColdCombatProfile');

function actor(karma = 0) {
    return {
        fetchId: () => 42,
        fetchName: () => 'Kharz',
        fetchLevel: () => 46,
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
assert.strictEqual(coldDetail.equipment.equipped[0].slot, 'weapon', 'cold outfit slots must be human-readable');
assert.strictEqual(coldDetail.combat.pDef, authoritativeCombat.pDef, 'cold bot detail must use authoritative combat formulas');
assert.strictEqual(coldDetail.combat.atkSpd, authoritativeCombat.atkSpd, 'cold bot detail must not add base and equipment attack speed');

const deadDetail = Observer.compactColdDetail({
    ...coldState,
    activity: 'dead',
    vitals: { hp: 0, maxHp: 20, mp: 0, maxMp: 10 }
});
assert.strictEqual(deadDetail.intent, 'dead', 'dead cold bots must not claim to be hunting');
assert.deepStrictEqual(deadDetail.blockers, ['dead'], 'dead cold bots must retain the map marker blocker');

console.log('World Observer PK marker checks passed');
