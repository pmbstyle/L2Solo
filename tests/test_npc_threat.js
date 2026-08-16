const assert = require('assert');

require('../src/Global');

const C4SkillEffects = invoke('GameServer/Skills/C4SkillEffects');
const Npc = invoke('GameServer/Npc/Npc');
const SkillModel = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');

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

async function verifyCombatRetarget() {
    const observedTargets = [];
    const originalMeleeHit = npc.meleeHit;
    const originalSelectCombatSkill = npc.selectCombatSkill;
    const originalScheduleAction = npc.automation.scheduleAction;
    const originalHasCombatLineOfSight = npc.hasCombatLineOfSight;
    const originalIsTargetInAttackRange = npc.isTargetInAttackRange;
    npc.meleeHit = (_session, _attacker, target) => observedTargets.push(target);
    npc.selectCombatSkill = () => null;
    npc.automation.scheduleAction = (_session, _npc, _target, _range, callback) => callback();
    npc.hasCombatLineOfSight = () => true;
    npc.isTargetInAttackRange = () => true;

    try {
        assert.strictEqual(npc.addDamageHate(damageDealerSession, damageDealer, 500, 500), true);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        assert(observedTargets.includes(damageDealer), 'the NPC must initially attack the highest-hate damage dealer');

        observedTargets.length = 0;
        assert.strictEqual(npc.addDamageHate(tankSession, tank, 0, 1000), true);
        await new Promise((resolve) => setTimeout(resolve, 300));
        assert(observedTargets.length > 0, 'the NPC must continue its combat loop after threat transfer');
        assert(
            observedTargets.every((target) => target === tank),
            'the first attacks after threat transfer must target the tank'
        );
    }
    finally {
        npc.meleeHit = originalMeleeHit;
        npc.selectCombatSkill = originalSelectCombatSkill;
        npc.automation.scheduleAction = originalScheduleAction;
        npc.hasCombatLineOfSight = originalHasCombatLineOfSight;
        npc.isTargetInAttackRange = originalIsTargetInAttackRange;
        npc.abortCombatState(tankSession);
    }
}

verifyCombatRetarget()
    .then(() => console.log('NPC threat transfer checks passed'))
    .catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
