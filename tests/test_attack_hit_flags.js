const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const ServerResponse = invoke('GameServer/Network/Response');
const DataCache = invoke('GameServer/DataCache');

function attacker(options = {}) {
    return {
        fetchCollectivePAtk: () => 100,
        fetchCollectiveCritical: () => options.critical ?? 0,
        fetchLocX: () => 1,
        fetchLocY: () => 2,
        fetchLocZ: () => 3,
        fetchId: () => 2000001,
        backpack: {
            fetchTotalWeaponPAtkRnd: () => 0,
            fetchEquippedWeapon: () => ({
                fetchRank: () => 'd'
            })
        }
    };
}

function target(options = {}) {
    return {
        fetchCollectivePDef: () => options.pDef ?? 100,
        fetchLevel: () => options.level ?? 20,
        fetchDex: () => options.dex ?? 30,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchHead: () => 8192,
        backpack: {
            fetchTotalShieldPDef: () => options.shieldPDef ?? 100,
            fetchTotalShieldRate: () => options.shieldRate ?? 20
        }
    };
}

const attack = new Attack();

const plainHit = attack.prepareMeleeHit(attacker(), target({ shieldPDef: 0 }), true, false, () => 0.99);
assert.strictEqual(plainHit.flags, 0, 'plain melee hit should not include extra visual flags');
assert.strictEqual(plainHit.damage, 70, 'plain melee hit should preserve base physical damage');

let rolls = [0.0, 0.0, 0.0];
const critShieldSoulshot = attack.prepareMeleeHit(
    attacker({ critical: 1000 }),
    target({ shieldPDef: 100, shieldRate: 100, level: 20 }),
    true,
    true,
    () => rolls.shift()
);

assert.ok(critShieldSoulshot.flags & ServerResponse.attack.HITFLAG_USESS, 'soulshot hit should include soulshot flag');
assert.ok(critShieldSoulshot.flags & ServerResponse.attack.HITFLAG_CRIT, 'critical hit should include crit flag');
assert.ok(critShieldSoulshot.flags & ServerResponse.attack.HITFLAG_SHLD, 'shield block should include shield flag');
assert.strictEqual(critShieldSoulshot.flags & 0x0f, 1, 'D-grade soulshot should include grade 1');
assert.strictEqual(critShieldSoulshot.damage, 140, 'critical soulshot shielded damage should match server damage');

DataCache.items = [{
    selfId: 945,
    template: { kind: 'Armor.Shield' },
    stats: { pDef: 69 }
}];
let npcRolls = [0.0, 0.0, 0.99];
const npcShieldHit = attack.prepareMeleeHit(attacker(), {
    fetchCollectivePDef: () => 100,
    fetchDex: () => 30,
    fetchLocX: () => 0,
    fetchLocY: () => 0,
    fetchHead: () => 8192,
    fetchShield: () => 945
}, true, false, () => npcRolls.shift());
assert.ok(npcShieldHit.flags & ServerResponse.attack.HITFLAG_SHLD, 'NPC shield equipment should roll shield block');
assert.strictEqual(npcShieldHit.damage, 41, 'NPC shield equipment should add shield P.Def to damage mitigation');

const missedHit = attack.prepareMeleeHit(attacker(), target(), false, true);
assert.deepStrictEqual(missedHit, {
    damage: 0,
    flags: ServerResponse.attack.HITFLAG_MISS
}, 'miss should carry only the miss flag');

const accurate = {
    fetchCollectiveAccur: () => 60,
    fetchLocZ: () => 100
};
const evasive = {
    fetchCollectiveEvasion: () => 40,
    fetchLocZ: () => 0
};
assert.strictEqual(
    invoke('GameServer/Formulas').calcHitChance(accurate, evasive, () => 0.97),
    true,
    'high accuracy should use L2J-style clamped hit chance'
);
assert.strictEqual(
    invoke('GameServer/Formulas').calcHitChance(accurate, evasive, () => 0.99),
    false,
    'L2J-style hit chance should still allow misses above the 98% clamp'
);

console.log('Attack hit flag checks passed');
