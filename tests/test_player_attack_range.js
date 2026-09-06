const assert = require('assert');
require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const Formulas = invoke('GameServer/Formulas');
const CompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

function fixture(kind = 'Weapon.DualFist', targetX = 40) {
    const timers = [], packets = [], damage = [], chases = [];
    const actor = {
        x: 0, effects: {},
        fetchId: () => 2000001, fetchLocX() { return this.x; },
        fetchLocY: () => 0, fetchLocZ: () => 0, fetchRadius: () => 8,
        fetchCollectiveAtkSpd: () => 333,
        state: { fetchDead: () => false, setHits(value) { this.hits = value; } },
        backpack: { fetchTotalWeaponKind: () => kind },
        automation: { scheduleAction(session, source, target, range, callback, options) {
            chases.push({ target, range, callback, options });
        } }
    };
    const target = {
        x: targetX, fetchId: () => 2000002, fetchLocX() { return this.x; },
        fetchLocY: () => 0, fetchLocZ: () => 0, fetchRadius: () => 8,
        state: { fetchDead: () => false }
    };
    const session = { actor, dataSendToMeAndOthers(packet) { packets.push(packet); } };
    const attack = new Attack();
    attack.queueTimer = (callback) => timers.push(callback);
    attack.prepareMeleeHit = () => ({ damage: 10, flags: 0 });
    attack.hit = (session, source, victim, amount) => damage.push({ victim, amount });
    attack.applyDamageAbsorb = () => {};
    return { actor, target, session, attack, timers, packets, damage, chases };
}

const originalChance = Formulas.calcHitChance;
const originalPickup = CompanionService.startQueuedGroundPickup;
try {
    Formulas.calcHitChance = () => true;
    CompanionService.startQueuedGroundPickup = () => false;

    const far = fixture('Weapon.DualFist', 1000);
    far.attack.meleeHit(far.session, far.target);
    assert.strictEqual(far.packets.length, 0, 'a distant target must not receive a melee attack animation');
    assert.strictEqual(far.timers.length, 0, 'a distant target must not schedule damage');
    assert.strictEqual(far.chases.length, 1, 'auto-attack must approach the escaped target');
    assert.strictEqual(far.chases[0].options.collisionAware, true);
    far.target.x = 2000;
    far.actor.x = 950;
    far.chases[0].callback();
    assert.strictEqual(far.timers.length, 0, 'arrival at an old target position must not authorize a remote hit');
    assert.strictEqual(far.chases.length, 2, 'arrival must chase again if the target kept running');
    far.actor.x = 1960;
    far.chases[1].callback();
    far.timers[0]();
    assert.strictEqual(far.damage.length, 1, 'attacks resume once the actor has actually caught up');

    const escaping = fixture();
    escaping.attack.meleeHit(escaping.session, escaping.target);
    escaping.target.x = 1000;
    escaping.timers[0]();
    assert.strictEqual(escaping.damage.length, 0, 'a target escaping during the swing must not take melee damage');
    escaping.timers[1]();
    assert.strictEqual(escaping.chases.length, 1, 'the next swing must approach instead of attacking from afar');
    assert.strictEqual(escaping.actor.state.hits, false);

    const between = fixture('Weapon.DualFist', 56);
    assert(AttackRange.isWithinRange(between.actor, between.target, 40), 'both collision radii count at the boundary');
    between.attack.meleeHit(between.session, between.target);
    between.timers[0]();
    assert.strictEqual(between.damage.length, 1, 'an in-range hit must still land');
    between.target.x = 57;
    between.timers[1]();
    assert.strictEqual(between.chases.length, 1, 'even the automatic repeat must respect the range boundary');

    const pole = fixture('Weapon.Pole');
    const secondary = { ...pole.target, x: 50, fetchId: () => 2000003 };
    pole.attack.resolveMeleeTargets = () => [pole.target, secondary];
    pole.attack.meleeHit(pole.session, pole.target);
    secondary.x = 1000;
    pole.timers[0]();
    assert.deepStrictEqual(pole.damage.map(entry => entry.victim.fetchId()), [pole.target.fetchId()],
        'polearm secondary targets must also remain in melee range at impact');

    const bow = fixture('Weapon.Bow', 600);
    bow.attack.meleeHit(bow.session, bow.target);
    bow.target.x = 1000;
    bow.timers[0]();
    assert.strictEqual(bow.damage.length, 1, 'a launched arrow may reach a target that leaves bow range');
    bow.timers[1]();
    assert.strictEqual(bow.chases.length, 1, 'the next arrow must still require bow range');
} finally {
    Formulas.calcHitChance = originalChance;
    CompanionService.startQueuedGroundPickup = originalPickup;
}
console.log('Player auto-attack range checks passed');
