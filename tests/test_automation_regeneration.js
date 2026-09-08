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

// Exercise the production setters used by players and hot bots, including
// recovery after the full-vitals tick has removed the previous interval.
const ActorModel = invoke('GameServer/Model/Actor');
for (const accountId of ['player_regen', 'bot_regen']) {
    const session = { accountId };
    const live = new ActorModel({
        id: 2000001, isOnline: true, level: 40, classId: 0, con: 30, men: 30,
        hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000, cp: 1000, maxCp: 1000
    });
    session.actor = live;
    live.session = session;
    live.statusUpdateVitals = () => {};
    live.automation = new Automation();
    const regen = live.automation;
    regen.setRevHp(5.4);
    regen.setRevMp(2.1);
    try {
        regen.replenishVitals(live);
        regen.replenishVitalsTick(live);
        assert(!regen.timer.replenish, 'Full vitals should stop regeneration');
        for (const vital of ['Hp', 'Mp', 'Cp']) {
            live[`set${vital}`](900);
            const timer = regen.timer.replenish;
            assert(timer, `${accountId}: spending ${vital} must restart regeneration`);
            live[`set${vital}`](899);
            assert.strictEqual(regen.timer.replenish, timer, 'Repeated changes must not delay the existing tick');
            regen.replenishVitalsTick(live);
            assert(live[`fetch${vital}`]() > 899, 'Standing actor must recover');
            live.fillupVitals();
            assert(!regen.timer.replenish, 'Refilling all resources must stop the interval');

            live[`setMax${vital}`](1300);
            assert(regen.timer.replenish, 'Increasing the cap must restart regeneration');
            regen.replenishVitalsTick(live);
            assert(live[`fetch${vital}`]() > 1000, 'New capacity must gradually recover');
            live[`setMax${vital}`](1000);
            live.fillupVitals();
        }
        live.setMp(900);
        live.setHp(0);
        assert(!regen.timer.replenish, 'Lethal damage must stop regeneration immediately');
        live.state.setDead(true);
        live.setHp(100);
        live.setMaxHp(1200);
        assert(!regen.timer.replenish, 'Corpse stat updates must not restart regeneration');
        regen.replenishVitalsTick(live);
        assert.strictEqual(live.fetchHp(), 100, 'A stale tick must not heal a corpse');
        session.dataSendToMeAndOthers = () => {};
        session.arenaEphemeral = true;
        invoke('GameServer/Actor/Generics/Revive')(session, live, { delayMs: 0 });
        assert(regen.timer.replenish, 'Revival must resume partial recovery');
        session.actor = null;
        const hpBeforeLogoutTick = live.fetchHp();
        regen.replenishVitalsTick(live);
        assert.strictEqual(live.fetchHp(), hpBeforeLogoutTick, 'A detached actor must not regenerate');
        live.setMp(800);
        assert(!regen.timer.replenish, 'Late updates after logout must not restart regeneration');
    } finally {
        regen.stopReplenish();
    }
}

console.log('Automation regeneration checks passed');
