const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const SkillModel = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');

function actor() {
    return {
        hp: 1000,
        mp: 1000,
        maxHp: 1000,
        destId: undefined,
        soulshotLoaded: false,
        spiritshotLoaded: false,
        blessedSpiritshotLoaded: false,
        fetchId: () => 2004078,
        fetchName: () => 'AreaCaster',
        fetchLevel: () => 70,
        fetchDestId() { return this.destId; },
        setDestId(value) { this.destId = value; },
        fetchHp() { return this.hp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMp() { return this.mp; },
        setHp(value) { this.hp = value; },
        setMp(value) { this.mp = value; },
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        fetchCollectiveMAtk: () => 100,
        fetchCollectivePAtk: () => 100,
        fetchCollectiveCastSpd: () => 333,
        fetchCollectiveAtkSpd: () => 333,
        statusUpdates: [],
        statusUpdateVitals(target) {
            this.statusUpdates.push({
                id: target.fetchId(),
                hp: target.fetchHp()
            });
        },
        backpack: {},
        automation: {
            replenishVitals() {}
        },
        state: {
            fetchDead: () => false,
            setCasts() {},
            setHits() {}
        }
    };
}

function npc(id, x, y, dead = false) {
    return {
        hp: dead ? 0 : 1000,
        enteredCombat: 0,
        vitalsBroadcasts: 0,
        fetchId: () => id,
        fetchName: () => `Mob${id}`,
        fetchLevel: () => 70,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        fetchAttackable: () => true,
        fetchCollectiveMDef: () => 50,
        fetchCollectivePDef: () => 100,
        fetchDex: () => 30,
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        broadcastVitals() {
            this.vitalsBroadcasts += 1;
            invoke('GameServer/Npc/Generics/BroadcastVitals')(this);
        },
        enterCombatState() {
            this.enteredCombat += 1;
        },
        isDead: () => dead,
        automation: {
            replenishVitals() {}
        },
        state: {
            fetchDead: () => dead,
            fetchCombats: () => false
        }
    };
}

function session(caster) {
    return {
        actor: caster,
        packets: [],
        dataSendToMe(packet) {
            this.packets.push(packet);
        },
        dataSendToMeAndOthers(packet) {
            this.packets.push(packet);
        },
        dataSendToOthers(packet) {
            this.packets.push(packet);
        }
    };
}

function flameStrike() {
    return new SkillModel({
        selfId: 1181,
        name: 'Flame Strike',
        passive: false,
        spell: true,
        distance: 500,
        hitTime: 4000,
        reuse: 15000,
        buff: 0,
        level: 2,
        power: 16,
        mp: 34,
        hp: 0,
        itemId: 0,
        itemCount: 0
    });
}

const originalFetchNpcsInRadius = World.fetchNpcsInRadius;
const originalRandom = Math.random;
const caster = actor();
const primary = npc(1004078, 100, 0);
const nearby = npc(1004079, 240, 0);
const outside = npc(1004080, 500, 0);
const deadNearby = npc(1004081, 120, 0, true);
const testSession = session(caster);
const attack = new Attack();
const originalWorldUser = World.user;

attack.queueTimer = (callback) => {
    callback();
    return null;
};
attack.prepareSkillDamage = () => 33;
World.fetchNpcsInRadius = (x, y, radius) => {
    assert.strictEqual(x, primary.fetchLocX(), 'TARGET_AREA lookup should be centered on selected target X');
    assert.strictEqual(y, primary.fetchLocY(), 'TARGET_AREA lookup should be centered on selected target Y');
    assert.strictEqual(radius, 200, 'TARGET_AREA lookup should use sourced skill radius');
    return [primary, nearby, outside, deadNearby];
};
Math.random = () => 0;
caster.setDestId(primary.fetchId());
World.user = { sessions: [testSession] };

try {
    attack.remoteHit(testSession, primary, flameStrike());
} finally {
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
    World.user = originalWorldUser;
    Math.random = originalRandom;
}

assert.strictEqual(primary.fetchHp(), 967, 'runtime TARGET_AREA skill should damage the primary NPC');
assert.strictEqual(nearby.fetchHp(), 967, 'runtime TARGET_AREA skill should damage a live attackable nearby NPC');
assert.strictEqual(outside.fetchHp(), 1000, 'runtime TARGET_AREA skill should not damage NPCs outside sourced radius');
assert.strictEqual(deadNearby.fetchHp(), 0, 'runtime TARGET_AREA skill should ignore dead non-corpse targets');
assert.strictEqual(primary.enteredCombat, 1, 'primary NPC should enter combat after taking area damage');
assert.strictEqual(nearby.enteredCombat, 1, 'secondary NPC should enter combat because it took area damage, not only social aggro');

const launched = testSession.packets.find((packet) => packet?.[0] === 0x76);
assert(launched, 'magic area skill should broadcast MagicSkillLaunched');
assert.strictEqual(launched.readInt32LE(13), 2, 'MagicSkillLaunched should include every affected target');
assert.strictEqual(launched.readInt32LE(17), primary.fetchId(), 'MagicSkillLaunched should include primary target first');
assert.strictEqual(launched.readInt32LE(21), nearby.fetchId(), 'MagicSkillLaunched should include secondary target');
assert.deepStrictEqual(
    caster.statusUpdates.map((entry) => entry.id),
    [caster.fetchId(), primary.fetchId(), nearby.fetchId()],
    'area damage should send vitals updates for every affected visible NPC, not only the selected primary target'
);

console.log('Skill area runtime checks passed');
