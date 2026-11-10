const assert = require('assert');

require('../src/Global');
// An attack on a character flags the attacker at the swing or the skill's
// landing (PvpFlag.attack); the flag packets are not under test here.
invoke('GameServer/Actor/PvpFlag').mark = () => {};

const Attack = invoke('GameServer/Actor/Attack');
const SkillModel = invoke('GameServer/Model/Skill');
const World = invoke('GameServer/World/World');
const Geo = invoke('GameServer/Geodata/GeodataEngine');

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
        fetchIsOnline: () => true,
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
            fetchCombats() { return !!this.combats; },
            setCombats(value) { this.combats = value; },
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
        fetchMaxHp: () => 1000,
        fetchMp: () => 100,
        fetchMaxMp: () => 100,
        setHp(value) { this.hp = value; },
        broadcastVitals() {
            this.vitalsBroadcasts += 1;
            invoke('GameServer/Npc/Generics/BroadcastVitals')(this);
        },
        enterCombatState() {
            if (!this.state.fetchCombats()) this.enteredCombat += 1;
            this.state.combats = true;
        },
        isDead: () => dead,
        automation: {
            replenishVitals() {}
        },
        state: {
            fetchDead: () => dead,
            fetchCombats() { return !!this.combats; }
        }
    };
}

function player(id, x, y, level = 70) {
    return {
        hp: 1000,
        fetchId: () => id,
        fetchName: () => `Player${id}`,
        fetchLevel: () => level,
        fetchLocX: () => x,
        fetchLocY: () => y,
        fetchLocZ: () => 0,
        fetchHead: () => 0,
        fetchCollectiveMDef: () => 50,
        fetchCollectivePDef: () => 100,
        fetchDex: () => 30,
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        statusUpdateVitals() {},
        automation: {
            replenishVitals() {}
        },
        state: {
            fetchDead: () => false,
            fetchSeated: () => false,
            fetchCombats: () => false,
            setCombats() {}
        }
    };
}

function session(caster) {
    return {
        accountId: `player_${caster.fetchId()}`,
        fetchAccountId() { return this.accountId; },
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
const underground = npc(1004082, 110, 0);
underground.fetchLocZ = () => -1689;
const closeFloor = npc(1004083, 120, 0);
closeFloor.fetchLocZ = () => 64;
const behindWall = npc(1004084, 130, 0);
const originalVisibility = Geo.hasLineOfSight;
Geo.hasLineOfSight = (_x, _y, _z, x, _toY, z) => z !== 64 && x !== behindWall.fetchLocX();
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
    return [primary, nearby, outside, deadNearby, underground, closeFloor, behindWall];
};
Math.random = () => 0;
caster.setDestId(primary.fetchId());
// The caster's client sees the NPCs it hit (vitals go to the real players registered near them).
World.user = { sessions: [], revision: 0 };
World.insertUser(testSession);

try {
    attack.remoteHit(testSession, primary, flameStrike());
} finally {
    World.removeUser(testSession);
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
    World.user = originalWorldUser;
    Math.random = originalRandom;
    Geo.hasLineOfSight = originalVisibility;
}

assert.strictEqual(primary.fetchHp(), 967, 'runtime TARGET_AREA skill should damage the primary NPC');
assert.strictEqual(nearby.fetchHp(), 967, 'runtime TARGET_AREA skill should damage a live attackable nearby NPC');
assert.strictEqual(outside.fetchHp(), 1000, 'runtime TARGET_AREA skill should not damage NPCs outside sourced radius');
assert.strictEqual(deadNearby.fetchHp(), 0, 'runtime TARGET_AREA skill should ignore dead non-corpse targets');
assert.strictEqual(primary.enteredCombat, 1, 'primary NPC should enter combat after taking area damage');
assert.strictEqual(nearby.enteredCombat, 1, 'secondary NPC should enter combat because it took area damage, not only social aggro');
for (const target of [underground, closeFloor, behindWall]) {
    assert.strictEqual(target.fetchHp(), 1000, 'area damage must not cross floors or walls');
    assert.strictEqual(target.enteredCombat, 0, 'an excluded area target must receive no aggression');
}

const launched = testSession.packets.find((packet) => packet?.[0] === 0x76);
assert(launched, 'magic area skill should broadcast MagicSkillLaunched');
assert.strictEqual(launched.readInt32LE(13), 2, 'MagicSkillLaunched should include every affected target');
assert.strictEqual(launched.readInt32LE(17), primary.fetchId(), 'MagicSkillLaunched should include primary target first');
assert.strictEqual(launched.readInt32LE(21), nearby.fetchId(), 'MagicSkillLaunched should include secondary target');

// The same native impact path for a self-centered physical aura: this is
// the Whirlwind that used to hit a dungeon mob under a surface hunter.
{
    const auraCaster = actor(), auraSession = session(auraCaster);
    auraCaster.backpack.fetchTotalWeaponKind = () => 'Weapon.Pole';
    const surface = npc(1004085, 80, 0), deep = npc(1004086, 90, 0), close = npc(1004087, 100, 0);
    deep.fetchLocZ = () => -1689;
    close.fetchLocZ = () => 64;
    const data = require('../data/Skills/Active/active.json').find(row => row.selfId === 36);
    const whirlwind = new SkillModel({ selfId: 36, ...data.template, ...data.time, ...data.levels[2], level: 3 });
    const fetchNpcs = World.fetchNpcsInRadius;
    World.fetchNpcsInRadius = () => [surface, deep, close];
    Geo.hasLineOfSight = (_x, _y, _z, _toX, _toY, z) => z !== 64;
    Math.random = () => 0;
    try {
        attack.remoteHit(auraSession, auraCaster, whirlwind);
        assert.strictEqual(surface.fetchHp(), 967, 'Whirlwind still damages a nearby enemy on its floor');
        for (const target of [deep, close]) {
            assert.strictEqual(target.fetchHp(), 1000, 'Whirlwind cannot damage another floor');
            assert.strictEqual(target.enteredCombat, 0, 'Whirlwind cannot pull another floor into combat');
        }
        assert.strictEqual(surface.enteredCombat, 1, 'Whirlwind still provokes the reachable victim');
    } finally {
        World.fetchNpcsInRadius = fetchNpcs;
        Geo.hasLineOfSight = originalVisibility;
        Math.random = originalRandom;
        invoke('GameServer/Actor/CombatStance').clear(auraCaster);
    }
}
assert.deepStrictEqual(caster.statusUpdates.map((entry) => entry.id), [caster.fetchId()],
    'the caster updates its own vitals after paying the cast');
assert.deepStrictEqual(
    testSession.packets.filter((packet) => packet?.[0] === 0x0e).map((packet) => packet.readInt32LE(1)),
    [primary.fetchId(), nearby.fetchId()],
    'area damage should send vitals updates for every affected visible NPC, not only the selected primary target'
);

const npcCaster = actor();
npcCaster.fetchId = () => 1004999;
npcCaster.fetchName = () => 'Area Monster';
npcCaster.fetchKind = () => 'Monster';
const playerPrimary = player(2004999, 100, 0);
const playerNearby = player(2005000, 240, 0);
const playerOutside = player(2005001, 500, 0);
const npcSession = session(npcCaster);
const playerPrimarySession = session(playerPrimary);
const playerNearbySession = session(playerNearby);
const playerOutsideSession = session(playerOutside);
playerPrimary.session = playerPrimarySession;
playerNearby.session = playerNearbySession;
playerOutside.session = playerOutsideSession;

World.user = { sessions: [playerPrimarySession, playerNearbySession, playerOutsideSession] };
Math.random = () => 0;
try {
    attack.remoteHit(npcSession, playerPrimary, flameStrike());
} finally {
    World.user = originalWorldUser;
    Math.random = originalRandom;
}

assert.strictEqual(playerPrimary.fetchHp(), 967, 'NPC TARGET_AREA skill should damage its selected player target');
assert.strictEqual(playerNearby.fetchHp(), 967, 'NPC TARGET_AREA skill should damage nearby players');
assert.strictEqual(playerOutside.fetchHp(), 1000, 'NPC TARGET_AREA skill should not damage players outside sourced radius');
const npcLaunched = npcSession.packets.find((packet) => packet?.[0] === 0x76);
assert(npcLaunched, 'NPC area spell should broadcast MagicSkillLaunched');
assert.strictEqual(npcLaunched.readInt32LE(13), 2, 'NPC area spell should include each affected player in MagicSkillLaunched');

const resistedPlayer = player(2005002, 100, 0, 100);
const resistedPlayerSession = session(resistedPlayer);
resistedPlayer.session = resistedPlayerSession;
World.user = { sessions: [resistedPlayerSession] };
Math.random = () => 0.99;
try {
    attack.remoteHit(npcSession, resistedPlayer, flameStrike());
} finally {
    World.user = originalWorldUser;
    Math.random = originalRandom;
}

assert.strictEqual(resistedPlayer.fetchHp(), 1000, 'resisted NPC magic should not deal damage');
const resistedMessage = resistedPlayerSession.packets.find((packet) => packet?.[0] === 0x64 && packet.readInt32LE(1) === 159);
assert(resistedMessage, 'a player should receive the C4 magic-resisted system message for an NPC spell');
assert.strictEqual(resistedMessage.readInt32LE(9), 0, 'magic-resisted system message should carry the monster name as text');
assert(!npcSession.packets.some(packet => packet?.[0] === 0x64 && [46, 158].includes(packet.readInt32LE(1))),
    'an NPC proxy must not send the receiving player cast-use or caster-failure messages');

const debuffCaster = actor();
const debuffSession = session(debuffCaster);
const hex = new SkillModel({ selfId: 122, name: 'Hex', level: 1, spell: true, distance: 600, hp: 0 });
World.user = { sessions: [resistedPlayerSession] };
Math.random = () => 0.99;
try {
    attack.remoteHit(debuffSession, resistedPlayer, hex);
} finally {
    World.user = originalWorldUser;
    Math.random = originalRandom;
    invoke('GameServer/Actor/CombatStance').clear(debuffCaster);
}
assert.deepStrictEqual(debuffSession.packets.filter(packet => packet?.[0] === 0x64).map(packet => packet.readInt32LE(1)),
    [46, 158], 'a resisted player debuff reports its use and failure to its caster');
assert.strictEqual(resistedPlayerSession.packets.filter(packet => packet?.[0] === 0x64 && packet.readInt32LE(1) === 159).length,
    1, 'a resisted debuff must not reuse the target-side nuke-resistance message');

const stunVictim = npc(1005010, 100, 0);
const stun = new SkillModel({ selfId: 100, name: 'Stun Attack', level: 1, spell: false });
debuffSession.packets.length = 0;
World.user = { sessions: [debuffSession] };
Math.random = () => 0.99;
try {
    attack.applyRemoteCastEffect(debuffSession, debuffCaster, stunVictim, stun, {
        magicSkill: false, shotState: attack.captureShotState(debuffCaster)
    });
} finally {
    World.user = originalWorldUser;
    Math.random = originalRandom;
}
assert.strictEqual(stunVictim.fetchHp(), 967, 'a resisted secondary stun must preserve the landed skill damage');
assert.deepStrictEqual(debuffSession.packets.filter(packet => packet?.[0] === 0x64).map(packet => packet.readInt32LE(1)),
    [158, 35], 'caster failure and damage feedback must both arrive when only the secondary effect resisted');

const Store = invoke('GameServer/Effects/EffectStore');
const holyAuraData = require('../data/Skills/Active/active.json').find(row => row.selfId === 107);
for (const hasUndead of [true, false]) {
    const auraCaster = actor(), auraSession = session(auraCaster);
    const living = npc(1005020, 50, 0), undead = npc(1005021, 100, 0), neutral = npc(1005022, 75, 0);
    living.fetchUndead = () => false;
    undead.fetchUndead = () => true;
    neutral.fetchUndead = () => true;
    neutral.fetchAttackable = () => false;
    const aura = new SkillModel({ selfId: 107, ...holyAuraData.template, ...holyAuraData.time, ...holyAuraData.levels[0] });
    World.fetchNpcsInRadius = () => hasUndead ? [living, undead, neutral] : [living, neutral];
    Math.random = () => 0;
    try {
        attack.remoteHit(auraSession, auraCaster, aura);
        assert(auraSession.packets.some(packet => packet[0] === 0x48), 'an undead aura must cast from its living caster');
        assert.strictEqual(auraCaster.mp, 1000 - aura.fetchConsumedMp(), 'an undead aura pays MP even without eligible targets');
        assert.strictEqual(living.enteredCombat, 0, 'an undead aura must not provoke living monsters');
        assert.strictEqual(Store.hasDebuff(living, 'root'), false, 'Holy Aura must not root living monsters');
        assert.strictEqual(neutral.enteredCombat, 0, 'an undead aura must preserve ordinary enemy eligibility');
        assert.strictEqual(Store.hasDebuff(neutral, 'root'), false, 'Holy Aura must not root non-hostile undead');
        assert.strictEqual(Store.hasDebuff(undead, 'root'), hasUndead, 'Holy Aura must still root nearby undead');
        assert(!auraSession.packets.some(packet => packet[0] === 0x64 && [109, 158].includes(packet.readInt32LE(1))),
            'living bystanders and an empty undead aura must not report invalid target or a resisted effect');
    } finally {
        Store.remove(undead, 'root');
        World.fetchNpcsInRadius = originalFetchNpcsInRadius;
        Math.random = originalRandom;
    }
}

console.log('Skill area runtime checks passed');
