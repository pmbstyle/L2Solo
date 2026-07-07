const assert = require('assert');

require('../src/Global');

const AttackRequest = invoke('GameServer/Actor/Generics/AttackRequest');
const SkillExec = invoke('GameServer/Actor/Generics/SkillExec');
const SkillModel = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');
const activeSkills = require('../data/Skills/Active/active.json');

function attackActor(weaponKind) {
    return {
        effects: {},
        storedAttack: null,
        isDead: () => false,
        isBlocked: () => false,
        fetchId: () => 2000001,
        fetchDestId: () => 0,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        backpack: {
            fetchTotalWeaponKind: () => weaponKind
        },
        automation: {
            fetchDestId: () => 0,
            abortAll() {}
        },
        state: {
            inMotion: () => false,
            fetchTowards: () => false,
            setTowards() {}
        }
    };
}

function session() {
    return {
        packets: [],
        dataSendToMeAndOthers(packet) {
            this.packets.push(packet);
        }
    };
}

function activeSkill(selfId) {
    const entry = activeSkills.find((skill) => skill.selfId === selfId);
    assert(entry, `active skill ${selfId} should exist`);
    return entry;
}

function skillFromActive(selfId, levelIndex = 0) {
    const entry = activeSkill(selfId);
    return new SkillModel({
        selfId: entry.selfId,
        ...entry.template,
        ...entry.time,
        ...entry.levels[levelIndex]
    });
}

assert.strictEqual(
    AttackRequest.fetchNormalAttackRange(attackActor('Weapon.Bow'), {}),
    AttackRequest.BOW_ATTACK_RANGE,
    'normal bow attacks should use ranged movement'
);
assert.strictEqual(
    AttackRequest.fetchNormalAttackRange(attackActor('Weapon.Sword'), {}),
    0,
    'normal melee attacks should still close to melee range'
);
assert.strictEqual(
    AttackRequest.fetchNormalAttackRange(attackActor('Weapon.Bow'), { range: 900 }),
    900,
    'explicit attack ranges should be preserved'
);

const bowActor = attackActor('Weapon.Bow');
AttackRequest(session(), bowActor, { id: 3000001, ctrl: true });
assert.strictEqual(
    bowActor.storedAttack.range,
    AttackRequest.BOW_ATTACK_RANGE,
    'player bow attack requests should store the bow attack range for AttackExec'
);

const swordActor = attackActor('Weapon.Sword');
AttackRequest(session(), swordActor, { id: 3000001, ctrl: true });
assert.strictEqual(
    swordActor.storedAttack.range,
    0,
    'player melee attack requests should store zero range'
);

(async () => {
    const powerShotData = activeSkill(56);
    const windStrikeData = activeSkill(1177);
    assert.strictEqual(powerShotData.template.distance, 700, 'Power Shot should keep sourced distance 700');
    assert.strictEqual(windStrikeData.template.distance, 600, 'Wind Strike should keep sourced distance 600');

    const powerShot = skillFromActive(56, powerShotData.levels.length - 1);
    assert.strictEqual(powerShot.fetchDistance(), 700, 'Power Shot model should expose distance 700');

    const originalFetchNpc = World.fetchNpc;
    let scheduledRange;
    World.fetchNpc = () => Promise.resolve({
        fetchId: () => 3000001,
        fetchAttackable: () => true
    });

    const caster = {
        skillset: {
            fetchSkill: () => powerShot
        },
        automation: {
            scheduleAction(_session, _actor, _target, range) {
                scheduledRange = range;
            }
        }
    };

    try {
        SkillExec(session(), caster, { id: 3000001, selfId: 56, ctrl: true });
        await new Promise((resolve) => setImmediate(resolve));
    } finally {
        World.fetchNpc = originalFetchNpc;
    }

    assert.strictEqual(scheduledRange, 700, 'SkillExec should schedule movement using skill.fetchDistance()');
    console.log('Player ranged combat checks passed');
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
