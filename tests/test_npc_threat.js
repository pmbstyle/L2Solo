const assert = require('node:assert/strict');
const { mock } = require('node:test');

require('../src/Global');

const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const Npc = invoke('GameServer/Npc/Npc');
const SkillModel = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const EffectTicker = invoke('GameServer/Effects/EffectTicker');
const EffectRestrictions = invoke('GameServer/Effects/EffectRestrictions');
const Formulas = invoke('GameServer/Formulas');

function actor(id) {
    return {
        fetchId: () => id,
        fetchLevel: () => 40,
        fetchCollectivePDef: () => 100,
        fetchDex: () => 30,
        fetchLocX: () => 20,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchRadius: () => 8,
        fetchHead: () => 0,
        state: { fetchDead: () => false },
        fetchIsOnline: () => true,
        effects: {}
    };
}

function session(value) {
    const current = {
        actor: value,
        packets: [],
        dataSendToMe() {},
        dataSendToMeAndOthers(packet) {
            this.packets.push(packet);
        }
    };
    if (value) value.session = current;
    return current;
}

const npc = new Npc(900010, {
    selfId: 900000,
    kind: 'Monster',
    name: 'Threat Test Mob',
    title: '',
    level: 40,
    hostile: true,
    str: 1,
    dex: 30,
    con: 1,
    int: 1,
    wit: 1,
    men: 1,
    pAtk: 100,
    pAtkRnd: 0,
    pDef: 100,
    mAtk: 100,
    mDef: 100,
    accur: 4.75,
    atkSpd: 253,
    castSpd: 333,
    atkRadius: 40,
    walk: 60,
    run: 120,
    maxHp: 1000,
    maxMp: 100,
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

const damageDealer = actor(2000101);
const tank = actor(2000102);
const damageDealerSession = session(damageDealer);
const tankSession = session(tank);

assert.strictEqual(npc.addDamageHate(damageDealerSession, damageDealer, 500, 500), true);
assert.strictEqual(npc.fetchDestId(), damageDealer.fetchId(), 'the first damage dealer should engage the NPC');
assert.strictEqual(npc.getHating(damageDealer), 500, 'normal damage should become hate');

const aggression = new SkillModel({
    selfId: 28,
    name: 'Aggression',
    level: 1,
    passive: false,
    spell: false,
    distance: 400,
    mp: 0,
    power: 300,
    hitTime: 0,
    reuse: 0,
    buff: 0
});

const outcome = C4SkillEffects.execute(
    tankSession,
    tank,
    npc,
    aggression,
    { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } }
);

assert(outcome.aggroDamage > 0, 'Aggression should produce hate instead of HP damage');
assert.strictEqual(npc.fetchDestId(), tank.fetchId(), 'Aggression should transfer the NPC target to the tank');
assert.strictEqual(npc.getHating(tank), outcome.aggroDamage + 1, 'Aggression must retain its engagement hate as well as skill hate');
assert.strictEqual(npc.getHating(damageDealer), 500, 'Aggression should not erase existing damage hate');

npc.abortCombatState(tankSession);

for (const [selfId, name] of [[18, 'Hate Aura'], [286, 'Provoke']]) {
    const nextDamageDealer = actor(2000110 + selfId);
    npc.addDamageHate(tankSession, nextDamageDealer, 500, 500);

    const taunt = new SkillModel({
        selfId,
        name,
        level: 1,
        passive: false,
        spell: false,
        distance: 400,
        mp: 0,
        power: 300,
        hitTime: 0,
        reuse: 0,
        buff: 0
    });
    const tauntOutcome = C4SkillEffects.execute(
        tankSession,
        tank,
        npc,
        taunt,
        { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } }
    );

    assert(tauntOutcome.aggroDamage > 0, `${name} should produce hate instead of HP damage`);
    assert.strictEqual(npc.fetchDestId(), tank.fetchId(), `${name} should transfer the NPC target to the tank`);
    npc.abortCombatState(tankSession);
}

const offlineTarget = actor(2000103);
offlineTarget.fetchIsOnline = () => false;
const offlineSession = session(offlineTarget);
assert.strictEqual(
    npc.addDamageHate(offlineSession, offlineTarget, 100, 100),
    false,
    'an offline actor must not enter the NPC hate table'
);

const crossNpcTarget = {
    fetchId: () => 900011,
    fetchKind: () => 'Monster',
    fetchIsSummon: () => false,
    state: { fetchDead: () => false }
};
assert.strictEqual(
    npc.addDamageHate(tankSession, crossNpcTarget, 100, 100),
    false,
    'an ordinary NPC must not enter another NPC hate table'
);
assert.strictEqual(npc.getHating(crossNpcTarget), 0, 'cross-NPC hate must not be retained for later retargeting');

const originalFetchNpcsInRadius = World.fetchNpcsInRadius;
const originalWorldNpc = World.npc;
World.npc ||= {};
const originalNpcGrid = World.npc.grid;
World.npc.grid ||= {};
World.fetchNpcsInRadius = () => [npc];

try {
    const currentTankHate = 600;
    assert.strictEqual(npc.addDamageHate(tankSession, tank, 0, currentTankHate), true);

    const ultimateDefense = new SkillModel({
        selfId: 110,
        name: 'Ultimate Defense',
        level: 2,
        passive: false,
        spell: false,
        distance: 0,
        mp: 0,
        power: 0,
        hitTime: 0,
        reuse: 0,
        buff: 30000
    });
    const defenseOutcome = C4SkillEffects.execute(
        tankSession,
        tank,
        tank,
        ultimateDefense,
        { magicSkill: false, rng: () => 0, attack: { clearLoadedShot() {} } }
    );
    const expectedAggroPointsHate = Math.floor((150 * 438) / (npc.fetchLevel() + 7));
    assert.strictEqual(
        defenseOutcome.aggroPointsApplied,
        expectedAggroPointsHate,
        'a successful self-buff with sourced aggroPoints must add native hate'
    );
    assert.strictEqual(
        npc.getHating(tank),
        currentTankHate + expectedAggroPointsHate,
        'aggroPoints hate must be retained on the caster entry'
    );
}
finally {
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
    if (originalNpcGrid === undefined) delete World.npc.grid;
    else World.npc.grid = originalNpcGrid;
    if (originalWorldNpc === undefined) delete World.npc;
    else World.npc = originalWorldNpc;
    npc.abortCombatState(tankSession);
}

const waitFor = async (predicate, timeoutMs = 2500) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !predicate()) await new Promise((resolve) => setTimeout(resolve, 25));
    return predicate();
};

// The combat loop runs for real; only its swing, skill choice, range and
// line of sight are fixed so the test reads whom the mob turns to.
async function withCombatStubs(run, { meleeHit = () => {}, lineOfSight = true } = {}) {
    const originals = {
        meleeHit: npc.meleeHit, selectCombatSkill: npc.selectCombatSkill,
        hasCombatLineOfSight: npc.hasCombatLineOfSight, isTargetInAttackRange: npc.isTargetInAttackRange
    };
    const originalScheduleAction = npc.automation.scheduleAction;
    Object.assign(npc, {
        meleeHit, selectCombatSkill: () => null,
        hasCombatLineOfSight: () => lineOfSight, isTargetInAttackRange: () => true
    });
    npc.automation.scheduleAction = (_session, _npc, _target, _range, callback) => callback();
    try {
        npc.clearAggroList();
        await run();
    }
    finally {
        Object.assign(npc, originals);
        npc.automation.scheduleAction = originalScheduleAction;
        npc.abortCombatState(tankSession);
    }
}

function verifyCombatRetarget() {
    const observedTargets = [];
    return withCombatStubs(async () => {
        assert.strictEqual(npc.addDamageHate(damageDealerSession, damageDealer, 500, 500), true);
        assert.strictEqual(
            await waitFor(() => observedTargets.includes(damageDealer)),
            true,
            'the NPC must initially attack the highest-hate damage dealer'
        );

        observedTargets.length = 0;
        assert.strictEqual(npc.addDamageHate(tankSession, tank, 0, 1000), true);
        assert.strictEqual(
            await waitFor(() => observedTargets.length > 0 && observedTargets.every((target) => target === tank)),
            true,
            'the first attacks after threat transfer must target the tank'
        );
    }, { meleeHit: (_session, _attacker, target) => observedTargets.push(target) });
}

function verifyControlRecovery() {
    const originals = {
        hit: npc.hit, selectCombatSkill: npc.selectCombatSkill,
        hasCombatLineOfSight: npc.hasCombatLineOfSight, hostile: npc.model.hostile,
        scheduleAction: npc.automation.scheduleAction, calcHitChance: Formulas.calcHitChance
    };
    const hits = [];
    const sleep = new SkillModel({ selfId: 1069, name: 'Sleep', level: 1, passive: false,
        spell: true, distance: 600, mp: 0, power: 80, hitTime: 0, reuse: 0, buff: 30000 });
    const castSleep = () => C4SkillEffects.execute(damageDealerSession, damageDealer, npc, sleep,
        { magicSkill: true, rng: () => 0, attack: { clearLoadedShot() {} } }).effect;
    const advance = (ms) => {
        for (let remaining = ms; remaining > 0; remaining -= 100) mock.timers.tick(Math.min(remaining, 100));
    };
    const reset = () => {
        EffectTicker.clearAll(npc);
        for (const effect of EffectStore.list(npc)) EffectStore.remove(npc, effect.key);
        npc.abortCombatState(damageDealerSession);
        hits.length = 0;
        damageDealerSession.packets.length = 0;
        tankSession.packets.length = 0;
    };
    mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1000000 });
    try {
        npc.model.hostile = false;
        npc.hit = (_session, target) => hits.push(target);
        npc.selectCombatSkill = () => null;
        npc.hasCombatLineOfSight = () => true;
        npc.automation.scheduleAction = (_session, _npc, _target, _range, callback) => callback();
        Formulas.calcHitChance = () => true;
        reset();

        npc.addDamageHate(damageDealerSession, damageDealer, 500, 500);
        npc.addDamageHate(tankSession, tank, 0, 200);
        advance(1100); // Sleep interrupts a swing before its damage lands.
        assert(damageDealerSession.packets.some(packet => packet[0] === 0x05),
            'the monster must announce a swing before Sleep interrupts its damage');
        const effect = castSleep();
        assert(effect, 'native Sleep must land');
        const duration = effect.expiresAt - Date.now();
        assert.equal(duration, 30000, 'the regression must cover the full native Sleep duration');
        const hate = npc.getHating(damageDealer);
        advance(duration - 100);
        assert.equal(hits.length, 0, 'Sleep must cancel the pending swing and prevent attacks throughout its duration');
        assert.equal(npc.getHating(damageDealer), hate, 'Sleep must preserve the original attacker hate');
        assert.equal(npc.getHating(tank), 200, 'Sleep must preserve other hate entries too');
        advance(2500);
        assert(!EffectStore.hasDebuff(npc, 'sleep'), 'Sleep must naturally expire');
        assert(hits.length > 0 && hits.every(target => target === damageDealer),
            'a passive monster must resume attacking the highest-hate actor without a new hit or auto-aggro');
        assert.equal(npc.getHating(damageDealer), hate, 'waking must not reset or add hate');

        reset();
        npc.addDamageHate(damageDealerSession, damageDealer, 500, 500);
        castSleep(); // Also cover control before the initial combat callback.
        const stun = EffectStore.apply(npc, { key: 'stun', id: 100, type: 'debuff', durationMs: 32000 });
        EffectTicker.scheduleExpiry(damageDealerSession, npc, stun);
        EffectRestrictions.interruptOnApply(damageDealerSession, npc, stun);
        npc.addDamageHate(tankSession, tank, 0, 1000);
        advance(31000);
        assert.equal(hits.length, 0, 'expired Sleep must not bypass a remaining Stun');
        advance(3500);
        assert(hits.length > 0 && hits.every(target => target === tank),
            'after all controls expire the monster must select the current highest hate');

        for (const key of ['sleep', 'stun', 'paralyze']) {
            reset();
            npc.addDamageHate(damageDealerSession, damageDealer, 500, 500);
            const control = EffectStore.apply(npc, { key, id: 1069, type: 'debuff', durationMs: 30000 });
            EffectTicker.scheduleExpiry(damageDealerSession, npc, control);
            EffectRestrictions.interruptOnApply(damageDealerSession, npc, control);
            advance(1500);
            assert.equal(hits.length, 0, `${key} must block attacks`);
            if (key === 'sleep') EffectRestrictions.wakeOnDamage(npc, damageDealerSession);
            else EffectStore.remove(npc, key);
            advance(2500);
            assert(hits.length > 0, `removing ${key} early must resume combat without waiting for its old expiry`);
            assert.equal(npc.getHating(damageDealer), 500, `removing ${key} must preserve hate`);
        }

        reset();
        npc.addDamageHate(damageDealerSession, damageDealer, 500, 500);
        castSleep();
        npc.reduceAggro(damageDealerSession, null, 10000);
        advance(33000);
        assert.equal(hits.length, 0, 'a hate wipe during Sleep must prevent combat from resuming');
        assert.equal(npc.fetchMostHated(), null, 'Sleep expiry must not restore wiped hate');

        reset();
        const disconnected = actor(2000150);
        const disconnectedSession = session(disconnected);
        npc.addDamageHate(disconnectedSession, disconnected, 500, 500);
        castSleep();
        disconnected.fetchIsOnline = () => false;
        advance(33000);
        assert(hits.length > 0 && hits.every(target => target === damageDealer),
            'waking must discard a disconnected top-hate actor and attack the next valid target');
        assert.equal(npc.getHating(disconnected), 0, 'a disconnected actor must leave the hate table');
    }
    finally {
        reset();
        npc.hit = originals.hit;
        npc.selectCombatSkill = originals.selectCombatSkill;
        npc.hasCombatLineOfSight = originals.hasCombatLineOfSight;
        npc.model.hostile = originals.hostile;
        npc.automation.scheduleAction = originals.scheduleAction;
        Formulas.calcHitChance = originals.calcHitChance;
        mock.timers.reset();
    }
}

// A dropped chase forgets that actor (Lisvus forgets a hated actor that left its
// known list, or one it could not hit): the mob turns to the next hated actor, or
// leaves combat with no stale hate that would turn it away from its next attacker.
const far = actor(2000120);
far.fetchLocX = () => 5000;
const farSession = session(far);

function verifyOutOfReachForget() {
    return withCombatStubs(async () => {
        assert.strictEqual(npc.addDamageHate(farSession, far, 500, 500), true);
        assert.strictEqual(await waitFor(() => !npc.state.fetchCombats()), true, 'a target out of reach must end the chase');
        assert.strictEqual(npc.getHating(far), 0, 'a dropped chase must forget the actor out of reach');
        assert.strictEqual(npc.fetchMostHated(), null, 'a mob that left combat must keep no stale hate');

        npc.addDamageHate(farSession, far, 500, 500);
        npc.addDamageHate(damageDealerSession, damageDealer, 100, 100);
        assert.strictEqual(await waitFor(() => npc.fetchDestId() === damageDealer.fetchId()), true,
            'a mob that forgot the actor out of reach must turn to the next hated actor');
        assert.strictEqual(npc.getHating(far), 0, 'the actor out of reach must leave the hate table');
        assert.strictEqual(npc.state.fetchCombats(), true, 'the mob must keep fighting the next hated actor');
    });
}

// No way to the target, an empty path or a path pool that cannot answer (queue
// full, timed out, a crashed worker): the mob keeps hating it and backs its
// requests off; only its attack timeout (2 min without a hit, a cast or a blow
// taken, Lisvus L2AttackableAI.thinkAttack) drops that target, and the mob turns
// to the next hated actor with a timeout of its own.
function verifyNoPathForget(request = () => Promise.resolve(null), what = 'no path') {
    const originalRequest = PathfindingWorkerPool.request;
    let requests = 0;
    PathfindingWorkerPool.request = (...args) => { requests++; return request(...args); };
    return withCombatStubs(async () => {
        assert.strictEqual(npc.addDamageHate(damageDealerSession, damageDealer, 500, 500), true);
        assert.strictEqual(npc.addDamageHate(tankSession, tank, 0, 100), true);
        await new Promise((resolve) => setTimeout(resolve, 2500));
        assert.strictEqual(npc.state.fetchCombats(), true, `a target with ${what} does not end the chase`);
        assert(npc.getHating(damageDealer) > 0, `a chase with ${what} keeps hating its actor`);
        assert(requests >= 1 && requests <= 4, `a chase with ${what} backs its requests off (${requests} in 1.5 s of chase)`);
        npc.combatActiveAt = Date.now() - 120000;
        assert.strictEqual(await waitFor(() => npc.getHating(damageDealer) === 0), true,
            `the attack timeout drops a target with ${what}`);
        assert.strictEqual(npc.state.fetchCombats(), true, 'the mob turns to the next hated actor');
        assert.strictEqual(npc.fetchDestId(), tank.fetchId(), 'the next hated actor becomes the target');
        assert(Date.now() - npc.combatActiveAt < 60000, 'the next target gets an attack timeout of its own');
    }, { lineOfSight: false }).finally(() => { PathfindingWorkerPool.request = originalRequest; });
}

function verifyPoolErrorForget() {
    const full = () => Promise.reject(Object.assign(new Error('path worker queue is full'), { code: 'QUEUE_FULL' }));
    return verifyNoPathForget(full, 'only path pool errors');
}

function verifyAggroMutations() {
    npc.clearAggroList();
    assert.strictEqual(npc.addDamageHate(damageDealerSession, damageDealer, 0, 500), true);
    assert.strictEqual(npc.addDamageHate(tankSession, tank, 0, 200), true);

    const charm = new SkillModel({
        selfId: 15,
        name: 'Charm',
        level: 1,
        passive: false,
        spell: true,
        distance: 400,
        mp: 0,
        power: 100,
        hitTime: 0,
        reuse: 0,
        buff: 0
    });
    C4SkillEffects.execute(
        tankSession,
        tank,
        npc,
        charm,
        { magicSkill: true, rng: () => 0, attack: { clearLoadedShot() {} } }
    );
    assert.strictEqual(npc.getHating(tank), 100, 'Charm should reduce only the caster hate entry');
    assert.strictEqual(npc.getHating(damageDealer), 500, 'Charm must not reduce unrelated hate entries');

    npc.reduceAggro(tankSession, tank, 1000);
    assert.strictEqual(npc.getHating(tank), 0, 'over-reducing one hate entry must clamp it at zero');
    assert.strictEqual(npc.fetchMostHated(), damageDealer, 'zeroed hate must not displace a positive hate target');

    npc.reduceAggro(damageDealerSession, null, 1000);
    assert.strictEqual(npc.getHating(damageDealer), 0, 'over-reducing all hate entries must clamp every entry at zero');
    assert.strictEqual(npc.fetchMostHated(), null, 'an NPC with only zero-hate entries must have no most-hated target');

    npc.clearAggroList();
    npc.addDamageHate(damageDealerSession, damageDealer, 0, 500);
    npc.addDamageHate(tankSession, tank, 0, 200);
    assert.strictEqual(npc.removeAggroTarget(damageDealerSession, damageDealer), true, 'an aggro target should be removable');
    assert.strictEqual(npc.getHating(damageDealer), 0, 'removed aggro target must leave no hate behind');
    npc.abortCombatState(tankSession);
}

verifyAggroMutations();
npc.clearAggroList();
npc.addDamageHate(damageDealerSession, damageDealer, 300, 300);
npc.addDamageHate(tankSession, tank, 300, 300);
assert.strictEqual(npc.fetchMostHated(), damageDealer, 'a hate tie must keep the earliest entry');
npc.abortCombatState(tankSession);
verifyControlRecovery();
verifyCombatRetarget()
    .then(verifyOutOfReachForget)
    .then(() => verifyNoPathForget())
    .then(verifyPoolErrorForget)
    .then(() => console.log('NPC threat transfer checks passed'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
