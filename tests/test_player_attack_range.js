const assert = require('assert');
require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const AttackRange = invoke('GameServer/Actor/AttackRange');
const Formulas = invoke('GameServer/Formulas');
const Backpack = invoke('GameServer/Actor/Backpack');
const Item = invoke('GameServer/Item/Item');
const CompanionService = invoke('GameServer/Bot/AI/PartyCompanionService');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const ValidatePosition = invoke('GameServer/Network/Request/ValidatePosition');

function fixture(kind = 'Weapon.DualFist', targetX = 40) {
    const timers = [], timerDelays = [], packets = [], damage = [], chases = [];
    const actor = {
        x: 0, effects: {}, mp: 10,
        isDead: () => false, fetchMp() { return this.mp; },
        setMp(mp) { this.mp = mp; }, statusUpdateVitals() {},
        fetchId: () => 2000001, fetchLocX() { return this.x; },
        fetchLocY: () => 0, fetchLocZ: () => 0, fetchRadius: () => 8,
        fetchCollectiveAtkSpd: () => 333,
        state: {
            fetchDead: () => false,
            fetchHits() { return !!this.hits; },
            inMotion() { return false; },
            setHits(value) { this.hits = value; }
        },
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
    assert.strictEqual(bow.actor.state.fetchHits(), false, 'movement should unlock as soon as the arrow is released');
    bow.timers[1]();
    assert.strictEqual(bow.chases.length, 1, 'the next arrow must still require bow range');
    assert.strictEqual(bow.actor.fetchMp(), 8, 'chasing must not spend MP');
    assert.strictEqual(bow.actor.backpack.fetchItemFromSelfId(17).fetchAmount(), 1);

    const movingBow = fixture('Weapon.Bow', 600);
    movingBow.attack.meleeHit(movingBow.session, movingBow.target);
    movingBow.timers[0]();
    movingBow.session.moveRouteGeneration = 1;
    movingBow.timers[1]();
    assert.strictEqual(movingBow.timerDelays.length, 2,
        'movement during bow reload should cancel the automatic next shot');
    assert.strictEqual(movingBow.actor.fetchMp(), 8, 'movement during reload must not spend MP on another arrow');
    assert.strictEqual(movingBow.actor.backpack.fetchItemFromSelfId(17).fetchAmount(), 1,
        'movement during reload must not consume another arrow');

    const reloadingBow = fixture('Weapon.Bow', 600);
    reloadingBow.attack.meleeHit(reloadingBow.session, reloadingBow.target);
    reloadingBow.timers[0]();
    reloadingBow.attack.meleeHit(reloadingBow.session, reloadingBow.target);
    assert.strictEqual(reloadingBow.actor.fetchMp(), 8, 'a repeated attack request must wait for bow reload');
    assert.strictEqual(reloadingBow.actor.backpack.fetchItemFromSelfId(17).fetchAmount(), 1,
        'a repeated attack request must not consume an arrow during bow reload');
    reloadingBow.timers[1]();
    assert.strictEqual(reloadingBow.actor.fetchMp(), 6, 'the queued attack should start when bow reload completes');
    assert.strictEqual(reloadingBow.actor.backpack.fetchItemFromSelfId(17), undefined,
        'the queued attack should consume and remove its last arrow only after bow reload completes');

    const repeated = fixture('Weapon.DualFist', 40);
    repeated.attack.meleeHit(repeated.session, repeated.target);
    repeated.attack.meleeHit(repeated.session, repeated.target);
    assert.strictEqual(repeated.packets.length, 1, 'a repeated melee request during a swing must not swing again');
    assert.strictEqual(repeated.timers.length, 2, 'a repeated melee request during a swing must not start a second loop');
    repeated.timers[0]();
    repeated.timers[1]();
    assert.strictEqual(repeated.packets.length, 2, 'the running loop still swings again after the swing ends');

    const rooted = fixture('Weapon.Knife', 40);
    rooted.session.actor.attack = rooted.attack;
    rooted.attack.meleeHit(rooted.session, rooted.target);
    const root = EffectStore.apply(rooted.actor, { key: 'root', id: 1201, type: 'debuff', durationMs: 60000 });
    EffectRestrictions.interruptOnApply(rooted.session, rooted.actor, root);
    rooted.packets.length = 0;
    for (let cycle = 0; cycle < 3; cycle++) {
        assert.strictEqual(ValidatePosition(rooted.session, Buffer.alloc(21)), false);
        rooted.timers[cycle * 2]();
        rooted.timers[cycle * 2 + 1]();
    }
    assert.strictEqual(rooted.damage.length, 3, 'root and position acknowledgements must preserve every in-range swing');
    assert.strictEqual(rooted.packets.filter(p => p[0] === 0x05).length, 3, 'auto-attack must continue at every weapon cycle');
    assert(!rooted.packets.some(p => p[0] === 0x47 || p[0] === 0x25), 'rooted validation must not send combat-interrupting packets');
    rooted.target.x = 200;
    rooted.timers[6]();
    rooted.timers[7]();
    assert.strictEqual(rooted.chases.length, 1, 'an auto-attack leaving root range must retain its target through automation');
    EffectStore.remove(rooted.actor, 'root');

    const switched = fixture('Weapon.DualFist', 40);
    const other = { ...switched.target, fetchId: () => 2000003 };
    switched.attack.meleeHit(switched.session, switched.target);
    switched.attack.meleeHit(switched.session, other);
    switched.timers[0]();
    switched.timers[1]();
    assert.strictEqual(switched.packets.length, 2, 'a target switch during a swing waits for the swing end');
    assert.strictEqual(switched.damage[0].victim, switched.target, 'the first swing keeps its target');
    assert.strictEqual(switched.timers.length, 4, 'the next swing starts once');
    switched.timers[2]();
    assert.strictEqual(switched.damage.at(-1).victim, other, 'the next swing hits the latest requested target');

    const groundClick = fixture('Weapon.DualFist', 40);
    let dequeued = 0;
    groundClick.attack.dequeueEvent = () => { dequeued++; groundClick.attack.resetQueuedEvent(); };
    groundClick.attack.meleeHit(groundClick.session, groundClick.target);
    groundClick.attack.meleeHit(groundClick.session, groundClick.target);
    groundClick.attack.queueEvent('move', {});
    groundClick.timers.forEach(timer => timer());
    assert.strictEqual(dequeued, 1, 'a ground click queued during the swing runs at the swing end');
    assert.strictEqual(groundClick.packets.length, 1, 'no loop swings again after the ground click');
    assert.strictEqual(groundClick.timers.length, 2, 'no loop is left to override the ground click');

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

const DataCache = invoke('GameServer/DataCache'), originalNpcs = DataCache.npcs;
try {
    let staticReads = 0, sourceRadius = 8;
    DataCache.npcs = [{ selfId: 1, collision: { radius: 10 } }, { selfId: 1, model: { radius: 30 } },
        { fetchRadius: () => { staticReads++; return Infinity; }, collision: { radius: 1000 } },
        { model: { radius: 0 }, collision: { radius: 1000 } }, { collision: { radius: -20 } }];
    const source = { fetchRadius: () => sourceRadius };
    assert.strictEqual(AttackRange.maxKnownTargetRadius(), 30,
        'the query maximum includes all raw duplicate NPC rows and preserves collision-radius precedence/normalization');
    assert.strictEqual(AttackRange.targetQueryRadius(source, 40), 78);
    sourceRadius = 12;
    assert.strictEqual(AttackRange.targetQueryRadius(source, 40), 82, 'the actor\'s current radius remains fresh');
    assert.strictEqual(staticReads, 1, 'repeated query reads reuse the prepared static maximum');
    DataCache.npcs.push({ collision: { radius: 45 } });
    assert.strictEqual(AttackRange.maxKnownTargetRadius(), 45, 'source growth refreshes the static maximum');
    DataCache.npcs = [{ collision: { radius: 90 } }];
    assert.strictEqual(AttackRange.targetQueryRadius(source, 40), 142, 'source replacement refreshes the maximum');
    DataCache.npcs = null;
    assert.strictEqual(AttackRange.targetQueryRadius(source, 40), 52, 'a missing dataset still contributes zero');
} finally { DataCache.npcs = originalNpcs; }
console.log('Player auto-attack range checks passed');
