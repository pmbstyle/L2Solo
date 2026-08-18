require('../src/Global');

const assert = require('assert');
const Automation = invoke('GameServer/Automation');
const Formulas = invoke('GameServer/Formulas');
const EffectStore = invoke('GameServer/Effects/EffectStore');

function actor({ seated = false, moving = false, con = 30, men = 30 } = {}) {
    return {
        hp: 100,
        mp: 100,
        cp: 0,
        maxHp: 1000,
        maxMp: 1000,
        maxCp: 1000,
        effects: {},
        fetchClassId: () => 0,
        fetchLevel: () => 40,
        fetchCon: () => con,
        fetchMen: () => men,
        fetchHp() { return this.hp; },
        fetchMp() { return this.mp; },
        fetchCp() { return this.cp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMaxMp() { return this.maxMp; },
        fetchMaxCp() { return this.maxCp; },
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        setCp(value) { this.cp = value; },
        statusUpdateVitals() {},
        state: {
            fetchSeated: () => seated,
            inMotion: () => moving
        }
    };
}

const automation = new Automation();
automation.setRevHp(5.4);
automation.setRevMp(2.1);

const standing = actor();
const seated = actor({ seated: true });
const moving = actor({ moving: true });

const standingHp = automation.fetchRevHpAmount(standing);
const standingMp = automation.fetchRevMpAmount(standing);
const standingCp = automation.fetchRevCpAmount(standing);
assert.strictEqual(
    standingHp,
    5.4 * Formulas.calcLevelMod(40) * Formulas.calcBaseMod.CON(30) * 1.1,
    'Standing player HP regeneration must use the C4 level, CON, and idle multipliers'
);
assert.strictEqual(
    standingMp,
    2.1 * Formulas.calcLevelMod(40) * Formulas.calcBaseMod.MEN(30) * 1.1,
    'Standing player MP regeneration must use the C4 level, MEN, and idle multipliers'
);
assert.strictEqual(
    standingCp,
    5.4 * Formulas.calcLevelMod(40) * Formulas.calcBaseMod.CON(30) * 1.1,
    'Standing player CP regeneration must use the C4 HP base, CON, and idle multipliers'
);
assert.strictEqual(
    automation.fetchRevHpAmount(seated),
    standingHp / 1.1 * 1.5,
    'Sitting must grant the C4 1.5x HP regeneration bonus'
);
assert.strictEqual(
    automation.fetchRevMpAmount(seated),
    standingMp / 1.1 * 1.5,
    'Sitting must grant the C4 1.5x MP regeneration bonus'
);
assert.strictEqual(
    automation.fetchRevCpAmount(seated),
    standingCp / 1.1 * 1.5,
    'Sitting must grant the C4 1.5x CP regeneration bonus'
);
assert.strictEqual(
    automation.fetchRevMpAmount(moving),
    standingMp / 1.1 * 0.7,
    'Running must apply the C4 0.7x MP regeneration penalty'
);

EffectStore.apply(seated, {
    id: 1047,
    key: 'mana_regeneration',
    type: 'buff',
    stats: { regMpAdd: 3.09 },
    durationMs: 60000
});
assert.strictEqual(
    automation.fetchRevMpAmount(seated),
    ((2.1 * Formulas.calcLevelMod(40) * Formulas.calcBaseMod.MEN(30)) + 3.09) * 1.5,
    'Additive MP regeneration must receive the C4 sitting multiplier'
);

const passiveRecovery = actor({ seated: true });
passiveRecovery.skillset = {
    fetchSkills: () => [{
        fetchPassive: () => true,
        fetchSelfId: () => 212,
        fetchName: () => 'Fast HP Recovery',
        fetchLevel: () => 2
    }, {
        fetchPassive: () => true,
        fetchSelfId: () => 229,
        fetchName: () => 'Fast Mana Recovery',
        fetchLevel: () => 2
    }]
};
assert.strictEqual(
    automation.fetchRevHpAmount(passiveRecovery),
    ((5.4 * Formulas.calcLevelMod(40) * Formulas.calcBaseMod.CON(30)) + 1.6) * 1.5,
    'Fast HP Recovery must add its C4 passive value before the sitting multiplier'
);
assert.strictEqual(
    automation.fetchRevMpAmount(passiveRecovery),
    ((2.1 * Formulas.calcLevelMod(40) * Formulas.calcBaseMod.MEN(30)) + 1.5) * 1.5,
    'Fast Mana Recovery must add its C4 passive value before the sitting multiplier'
);

const result = automation.replenishVitalsTick(seated);
assert(result.hp > 100 && result.mp > 100, 'A regeneration tick must restore both HP and MP while seated');
assert(result.cp > 0, 'A regeneration tick must restore CP while seated');
assert.strictEqual(seated.cp, result.cp, 'A regeneration tick must apply the CP result to the actor');

const cpOnlyRecovery = actor();
cpOnlyRecovery.hp = cpOnlyRecovery.maxHp;
cpOnlyRecovery.mp = cpOnlyRecovery.maxMp;
automation.replenishVitals(cpOnlyRecovery);
const cpOnlyResult = automation.replenishVitalsTick(cpOnlyRecovery);
assert(cpOnlyResult.cp > 0, 'CP-only damage must start recovery even when HP and MP are full');
assert(automation.timer.replenish, 'CP-only damage must keep the regeneration timer alive until CP is full');
automation.stopReplenish();

console.log('Automation regeneration checks passed');
