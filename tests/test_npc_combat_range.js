const assert = require('assert');

require('../src/Global');

const Attack = invoke('GameServer/Actor/Attack');
const Npc = invoke('GameServer/Npc/Npc');
const SkillModel = invoke('GameServer/Model/Skill');
const Formulas = invoke('GameServer/Formulas');
const ConsoleText = invoke('GameServer/ConsoleText');

function npcWithRange(atkRadius, selfId = 900000) {
    return new Npc(900000, {
        selfId,
        kind: 'Monster',
        name: 'Range Test Mob',
        title: '',
        level: 1,
        hostile: true,
        str: 1,
        dex: 30,
        con: 1,
        int: 1,
        wit: 1,
        men: 1,
        pAtk: 1,
        pAtkRnd: 0,
        pDef: 1,
        mAtk: 1,
        mDef: 1,
        accur: 4.75,
        atkSpd: 253,
        castSpd: 333,
        atkRadius,
        walk: 60,
        run: 120,
        maxHp: 100,
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
}

function actorAt(x) {
    return {
        hp: 1000,
        fetchId: () => 2000001,
        fetchRadius: () => 8,
        fetchLocX: () => x,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchHp() { return this.hp; },
        fetchMaxHp: () => 1000,
        setHp(value) { this.hp = value; },
        fetchCollectivePDef: () => 100,
        fetchCollectiveMDef: () => 100,
        fetchCollectiveEvasion: () => 34,
        fetchLevel: () => 1,
        fetchDex: () => 30,
        fetchHead: () => 0,
        statusUpdateVitals() {},
        automation: {
            replenishVitals() {}
        },
        state: {
            fetchDead: () => false,
            fetchSeated: () => false,
            fetchCombats: () => false,
            setHits() {},
            setCasts() {},
            setSits() {},
            setCombats() {}
        }
    };
}

const rangedNpc = npcWithRange(500);
const target = actorAt(1000);

assert.strictEqual(
    rangedNpc.fetchCombatAttackRange(target),
    500,
    'NPC combat should use its own attack radius instead of the target collision radius'
);

assert.deepStrictEqual(
    rangedNpc.fetchCombatStopCoords(target),
    { locX: 500, locY: 0, locZ: 0 },
    'ranged NPC should stop at attack radius distance, not on the target coordinates'
);

rangedNpc.setLocXYZ(rangedNpc.fetchCombatStopCoords(target));
assert.strictEqual(rangedNpc.isTargetInAttackRange(target), true, 'ranged NPC should be able to attack from its stop point');
assert.notStrictEqual(rangedNpc.fetchLocX(), target.fetchLocX(), 'ranged NPC must not snap onto the player');

const meleeNpc = npcWithRange(40);
assert.strictEqual(
    Math.round(meleeNpc.fetchCollectiveAccur()),
    39,
    'NPC accuracy should include its base accuracy, DEX, and level'
);
assert.strictEqual(
    Math.round(meleeNpc.fetchCollectiveEvasion()),
    34,
    'NPC evasion should include its DEX and level like other creatures'
);
assert.strictEqual(
    Formulas.calcHitChance(meleeNpc, target, () => 0.85),
    true,
    'a low-level NPC should not be pinned to the 20% minimum hit chance against a low-level player'
);
assert.deepStrictEqual(
    meleeNpc.fetchCombatStopCoords(target),
    { locX: 960, locY: 0, locZ: 0 },
    'melee NPC should still close to melee attack radius'
);

const casterNpc = npcWithRange(40, 109);
casterNpc.setCollectiveCastSpd(999999);
casterNpc.automation.replenishVitals = () => {};
const casterSkill = casterNpc.selectCombatSkill(target);
assert(casterSkill, 'NPC with sourced combat skills should select a spell before falling back to melee');
assert.strictEqual(casterSkill.fetchSelfId(), 4001, 'Salamander should select its sourced NPC Wind Strike skill');
casterSkill.model.reuse = 1;
assert.strictEqual(casterNpc.fetchSkillCastRange(casterSkill, target), 600, 'NPC spell should preserve sourced cast range');

const castStop = casterNpc.fetchCombatStopCoords(target, casterNpc.fetchSkillCastRange(casterSkill, target));
assert.deepStrictEqual(
    castStop,
    { locX: 400, locY: 0, locZ: 0 },
    'spellcasting NPC should stop at cast range instead of melee range'
);

casterNpc.setLocXYZ(castStop);
const session = {
    packets: [],
    clientPackets: [],
    dataSendToMe(packet) {
        this.clientPackets.push(packet);
    },
    dataSendToMeAndOthers(packet) {
        this.packets.push(packet);
    }
};
casterNpc.castSkill(session, target, casterSkill);

const castPacket = session.packets.find((packet) => packet[0] === 0x48);
assert(castPacket, 'spellcasting NPC should broadcast MagicSkillUse instead of opening with melee');
assert.strictEqual(castPacket.readInt32LE(9), 4001, 'MagicSkillUse should carry the selected NPC skill id');
assert.strictEqual(castPacket.readInt32LE(25), castStop.locX, 'MagicSkillUse should start from the ranged stop point');
assert.strictEqual(session.packets.some((packet) => packet[0] === 0x05), false, 'spellcasting path should not emit an immediate melee attack');
casterNpc.state.setCasts(false);
AttackHelperCleanup(casterNpc);

const originalCalcHitChance = Formulas.calcHitChance;
Formulas.calcHitChance = () => false;
meleeNpc.setCollectiveAtkSpd(999999);
meleeNpc.meleeHit(session, meleeNpc, target);
Formulas.calcHitChance = originalCalcHitChance;

const npcPhysicalSkill = new SkillModel({
    selfId: 4032,
    name: 'NPC Strike',
    passive: false,
    spell: false,
    distance: 40,
    hitTime: 1000,
    reuse: 1000,
    buff: 0,
    level: 1,
    power: 18,
    mp: 0,
    hp: 0,
    itemId: 0,
    itemCount: 0
});
assert.doesNotThrow(
    () => new Attack().prepareSkillDamage(meleeNpc, target, npcPhysicalSkill, false),
    'physical NPC skills should not require a player backpack'
);

function AttackHelperCleanup(npc) {
    npc.abortCombatState({
        dataSendToMeAndOthers() {}
    });
}

setTimeout(() => {
    assert(
        session.clientPackets.some((packet) => packet[0] === 0x64 && packet.readInt32LE(1) === ConsoleText.caption.actorHit),
        'NPC skill damage should forward its hit system message to the targeted player'
    );
    assert(
        session.clientPackets.some((packet) => packet[0] === 0x64 && packet.readInt32LE(1) === ConsoleText.caption.missedHit),
        'NPC melee misses should send the evasion system message to the targeted player'
    );
    console.log('NPC combat range checks passed');
}, 25);
