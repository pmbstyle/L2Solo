const assert = require('assert');

require('../src/Global');

const Npc = invoke('GameServer/Npc/Npc');

function npcWithRange(atkRadius) {
    return new Npc(900000, {
        kind: 'Monster',
        name: 'Range Test Mob',
        title: '',
        level: 1,
        hostile: true,
        str: 1,
        dex: 1,
        con: 1,
        int: 1,
        wit: 1,
        men: 1,
        pAtk: 1,
        pAtkRnd: 0,
        pDef: 1,
        mAtk: 1,
        mDef: 1,
        accur: 1,
        atkSpd: 253,
        castSpd: 333,
        atkRadius,
        walk: 60,
        run: 120,
        maxHp: 100,
        maxMp: 10,
        revHp: 1,
        revMp: 1,
        corpseTime: 7,
        radius: 10,
        size: 20,
        weapon: 0,
        shield: 0,
        reuseTime: 0,
        exp: 0,
        sp: 0,
        locX: 0,
        locY: 0,
        locZ: 0,
        head: 0
    });
}

function actorAt(x) {
    return {
        fetchId: () => 100000,
        fetchRadius: () => 8,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0
    };
}

const rangedNpc = npcWithRange(500);
const target = actorAt(1000);

assert.strictEqual(
    rangedNpc.fetchCombatAttackRange(target),
    500,
    'NPC combat should use its own attack radius instead of the target collision radius'
);

assert.deepStrictEqual(
    rangedNpc.fetchCombatStopCoords(target),
    { locX: 500, locY: 0, locZ: 0 },
    'ranged NPC should stop at attack radius distance, not on the target coordinates'
);

rangedNpc.setLocXYZ(rangedNpc.fetchCombatStopCoords(target));
assert.strictEqual(rangedNpc.isTargetInAttackRange(target), true, 'ranged NPC should be able to attack from its stop point');
assert.notStrictEqual(rangedNpc.fetchLocX(), target.fetchLocX(), 'ranged NPC must not snap onto the player');

const meleeNpc = npcWithRange(40);
assert.deepStrictEqual(
    meleeNpc.fetchCombatStopCoords(target),
    { locX: 960, locY: 0, locZ: 0 },
    'melee NPC should still close to melee attack radius'
);

console.log('NPC combat range checks passed');
