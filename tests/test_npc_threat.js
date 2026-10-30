const assert = require('assert');

require('../src/Global');

const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const Npc = invoke('GameServer/Npc/Npc');
const SkillModel = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');
const PathfindingWorkerPool = invoke('GameServer/Geodata/PathfindingWorkerPool');

function actor(id) {
    return {
        fetchId: () => id,
        fetchLevel: () => 40,
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
assert.strictEqual(npc.getHating(tank), outcome.aggroDamage, 'Aggression hate should be stored on the tank entry');
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

function verifyNoPathForget() {
    const originalRequest = PathfindingWorkerPool.request;
    PathfindingWorkerPool.request = () => Promise.resolve(null);
    return withCombatStubs(async () => {
        assert.strictEqual(npc.addDamageHate(damageDealerSession, damageDealer, 500, 500), true);
        assert.strictEqual(await waitFor(() => !npc.state.fetchCombats(), 15000), true,
            'a target with no path must end the chase after the path timeout');
        assert.strictEqual(npc.getHating(damageDealer), 0, 'a chase with no path must forget its actor');
    }, { lineOfSight: false }).finally(() => { PathfindingWorkerPool.request = originalRequest; });
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
verifyCombatRetarget()
    .then(verifyOutOfReachForget)
    .then(verifyNoPathForget)
    .then(() => console.log('NPC threat transfer checks passed'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
