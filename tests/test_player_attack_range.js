const assert = require('assert');
require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const Formulas = invoke('GameServer/Formulas');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const CompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');

function fixture(kind = 'Weapon.DualFist', targetX = 40) {
    const timers = [], timerDelays = [], packets = [], damage = [], chases = [];
    const actor = {
        x: 0, effects: {}, mp: 10,
        isDead: () => false, fetchMp() { return this.mp; },
        setMp(mp) { this.mp = mp; }, statusUpdateVitals() {},
        fetchId: () => 2000001, fetchLocX() { return this.x; },
        fetchLocY: () => 0, fetchLocZ: () => 0, fetchRadius: () => 8,
        fetchCollectiveAtkSpd: () => 333,
        state: { fetchDead: () => false, setHits(value) { this.hits = value; } },
        backpack: { fetchTotalWeaponKind: () => kind },
        automation: { scheduleAction(session, source, target, range, callback, options) {
            chases.push({ target, range, callback, options });
        } }
    };
    if (kind === 'Weapon.Bow') {
        actor.backpack = new Backpack({ items: [], paperdoll: {} });
        actor.backpack.items = [
            new Item(1, { selfId: 14, kind, rank: 'none', mp: 2, equipped: true, slot: 14 }),
            new Item(2, { selfId: 17, kind: 'Other.Arrow', amount: 2, stackable: true })
        ];
    }
    const target = {
        x: targetX, fetchId: () => 2000002, fetchLocX() { return this.x; },
        fetchLocY: () => 0, fetchLocZ: () => 0, fetchRadius: () => 8,
        state: { fetchDead: () => false }
    };
    const session = { actor, persistenceMode: 'ephemeral', dataSendToMe(packet) { packets.push(packet); }, dataSendToMeAndOthers(packet) { packets.push(packet); } };
    const attack = new Attack();
    attack.queueTimer = (callback, delay) => { timers.push(callback); timerDelays.push(delay); };
    attack.prepareMeleeHit = () => ({ damage: 10, flags: 0 });
    attack.hit = (session, source, victim, amount) => damage.push({ victim, amount });
    attack.applyDamageAbsorb = () => {};
    return { actor, target, session, attack, timers, timerDelays, packets, damage, chases };
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
    assert.strictEqual(bow.actor.fetchMp(), 8);
    assert.strictEqual(bow.actor.backpack.fetchItemFromSelfId(17).fetchAmount(), 1);
    assert.deepStrictEqual(
        bow.timerDelays.map(Math.round),
        [1554, 3108],
        'a bow hit should land after drawing and repeat only after the separate C4 reuse phase'
    );
    assert(bow.packets.some(packet => packet[0] === 0x6d), 'a player bow attack should show its draw and reload gauge');
    bow.target.x = 1000;
    bow.timers[0]();
    assert.strictEqual(bow.damage.length, 1, 'a launched arrow may reach a target that leaves bow range');
    bow.timers[1]();
    assert.strictEqual(bow.chases.length, 1, 'the next arrow must still require bow range');
    assert.strictEqual(bow.actor.fetchMp(), 8, 'chasing must not spend MP');
    assert.strictEqual(bow.actor.backpack.fetchItemFromSelfId(17).fetchAmount(), 1);

    const missed = fixture('Weapon.Bow', 600);
    Formulas.calcHitChance = () => false;
    missed.attack.meleeHit(missed.session, missed.target);
    assert.strictEqual(missed.actor.fetchMp(), 8, 'a missed shot costs MP');
    assert.strictEqual(missed.actor.backpack.fetchItemFromSelfId(17).fetchAmount(), 1);
    Formulas.calcHitChance = () => true;

    for (const reason of ['no_mp', 'no_arrows', 'wrong_grade']) {
        const blocked = fixture('Weapon.Bow', 600);
        if (reason === 'no_mp') blocked.actor.mp = 1;
        if (reason === 'no_arrows') blocked.actor.backpack.items.pop();
        if (reason === 'wrong_grade') blocked.actor.backpack.items[0].model.rank = 'd';
        blocked.attack.meleeHit(blocked.session, blocked.target);
        assert.strictEqual(blocked.timers.length, 0, `${reason} must prevent the shot`);
        assert.strictEqual(blocked.actor.mp, reason === 'no_mp' ? 1 : 10);
        if (reason !== 'no_arrows') assert.strictEqual(blocked.actor.backpack.items[1].fetchAmount(), 2);
        assert(blocked.packets.some(packet => packet[0] === 0x25), 'rejected shot sends ActionFailed');
    }
    const WriteQueue = invoke('GameServer/Persistence/CharacterWriteQueue');
    const originalItemAmount = WriteQueue.itemAmount;
    const writes = [];
    try {
        WriteQueue.itemAmount = (...args) => writes.push(args);
        const persistent = fixture('Weapon.Bow', 600);
        persistent.session.persistenceMode = undefined;
        persistent.attack.meleeHit(persistent.session, persistent.target);
        assert.deepStrictEqual(writes, [[2000001, 2, 1]], 'remaining arrows are queued for persistence');
        const last = fixture('Weapon.Bow', 600);
        last.session.persistenceMode = undefined;
        last.actor.backpack.items[1].setAmount(1);
        last.attack.meleeHit(last.session, last.target);
        assert.deepStrictEqual(writes.at(-1), [2000001, 2, 0], 'last arrow deletion is queued for persistence');
    } finally { WriteQueue.itemAmount = originalItemAmount; }

    for (const [rank, arrow] of [['none', 17], ['d', 1341], ['c', 1342], ['b', 1343], ['a', 1344], ['s', 1345]]) {
        const graded = fixture('Weapon.Bow', 600);
        graded.actor.backpack.items[0].model.rank = rank;
        Object.assign(graded.actor.backpack.items[1].model, { selfId: arrow, amount: 1 });
        graded.actor.mp = 2;
        graded.attack.meleeHit(graded.session, graded.target);
        assert.strictEqual(graded.actor.mp, 0);
        assert.strictEqual(graded.actor.backpack.fetchItemFromSelfId(arrow), undefined, 'last arrow is removed');
        assert.strictEqual(graded.timers.length, 2);
    }

} finally {
    Formulas.calcHitChance = originalChance;
    CompanionService.startQueuedGroundPickup = originalPickup;
}
console.log('Player auto-attack range checks passed');
