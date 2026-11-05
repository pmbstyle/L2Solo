const assert = require('assert');

require('../src/Global');

const calculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const ReceivedHit = invoke('GameServer/Actor/Generics/ReceivedHit');
const EffectStore = invoke('GameServer/Effects/EffectStore');
const Formulas = invoke('GameServer/Formulas');
const Actor = invoke('GameServer/Actor/Actor');
const Skill = invoke('GameServer/Model/Skill');

function actor() {
    return {
        level: 1,
        classId: 0,
        hp: 100,
        mp: 100,
        cp: 0,
        effects: {},
        fetchLevel() { return this.level; },
        fetchClassId() { return this.classId; },
        fetchCon() { return 43; },
        fetchMen() { return 25; },
        fetchStr() { return 40; },
        fetchDex() { return 30; },
        fetchInt() { return 21; },
        fetchWit() { return 11; },
        fetchHp() { return this.hp; },
        fetchMp() { return this.mp; },
        fetchCp() { return this.cp; },
        fetchMaxHp() { return this.maxHp; },
        fetchMaxMp() { return this.maxMp; },
        fetchMaxCp() { return this.maxCp; },
        fetchPAtk() { return 4; },
        fetchMAtk() { return 6; },
        fetchPDef() { return 80; },
        fetchMDef() { return 41; },
        fetchAccur() { return 0; },
        fetchEvasion() { return 0; },
        fetchCritical() { return 40; },
        fetchAtkSpd() { return 300; },
        fetchWalkSpd() { return 80; },
        fetchRunSpd() { return 115; },
        isSpellcaster() { return 0; },
        setMaxHp(value) { this.maxHp = value; },
        setHp(value) { this.hp = value; },
        setMaxMp(value) { this.maxMp = value; },
        setMp(value) { this.mp = value; },
        setMaxCp(value) { this.maxCp = value; },
        setCp(value) { this.cp = value; },
        setMaxLoad(value) { this.maxLoad = value; },
        setLoad(value) { this.load = value; },
        setCollectivePAtk(value) { this.collectivePAtk = value; },
        setCollectiveMAtk(value) { this.collectiveMAtk = value; },
        setCollectivePDef(value) { this.collectivePDef = value; },
        setCollectiveMDef(value) { this.collectiveMDef = value; },
        setCollectiveAccur(value) { this.collectiveAccur = value; },
        setCollectiveEvasion(value) { this.collectiveEvasion = value; },
        setCollectiveCritical(value) { this.collectiveCritical = value; },
        setCollectiveAtkSpd(value) { this.collectiveAtkSpd = value; },
        setCollectiveCastSpd(value) { this.collectiveCastSpd = value; },
        setCollectiveWalkSpd(value) { this.collectiveWalkSpd = value; },
        setCollectiveRunSpd(value) { this.collectiveRunSpd = value; },
        backpack: {
            fetchTotalArmorBonusMp: () => 0,
            fetchTotalLoad: () => 0,
            fetchTotalWeaponPAtk: () => 4,
            fetchTotalWeaponMAtk: () => 6,
            fetchTotalArmorPDef: () => 76,
            fetchTotalArmorMDef: () => 41,
            fetchTotalWeaponAccur: () => 0,
            fetchTotalArmorEvasion: () => 0,
            fetchTotalWeaponCritical: () => 40,
            fetchTotalWeaponAtkSpd: () => 300
        }
    };
}

function combatActor({ hp = 100, cp = 0 } = {}) {
    return {
        id: 2000002,
        hp,
        cp,
        session: null,
        fetchId() { return this.id; },
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        fetchCp() { return this.cp; },
        setCp(value) { this.cp = value; },
        state: {
            fetchSeated: () => false,
            fetchCombats: () => false,
            setCombats() {}
        },
        automation: {
            replenishVitals() {}
        },
        statusUpdateVitals() {}
    };
}

function hitSession(attacker) {
    return {
        actor: attacker,
        dataSendToMeAndOthers() {}
    };
}

const fighter = actor();
calculateStats({}, fighter);
assert.strictEqual(Math.round(fighter.fetchMaxCp()), Math.round(Formulas.calcCp(1, 0, 43)), 'max CP should be calculated from sourced class template parameters');
assert.strictEqual(fighter.fetchCp(), fighter.fetchMaxCp(), 'first CP stat calculation should fill legacy zero CP to max');

// T109: a 2nd class reads its own template, not its starting class's curve.
const gladiator = actor();
gladiator.level = 76;
gladiator.classId = 2;
calculateStats({}, gladiator);
assert.strictEqual(gladiator.fetchMaxHp(), Formulas.calcHp(76, 2, 43), 'a Gladiator\'s max HP is its class template value');
assert.strictEqual(Math.round(gladiator.fetchMaxHp()), 4847);
assert.strictEqual(gladiator.fetchMaxMp(), Formulas.calcMp(76, 2, 25), 'a Gladiator\'s max MP is its class template value');

fighter.setCp(10);
EffectStore.apply(fighter, { id: 9001, key: 'cp-set-bonus', stats: { maxCpMul: 1.5 } });
calculateStats({}, fighter);
assert.strictEqual(Math.round(fighter.fetchMaxCp()), Math.round(Formulas.calcCp(1, 0, 43) * 1.5), 'maxCpMul effects should increase max CP');
assert.strictEqual(fighter.fetchCp(), 10, 'recalculating max CP should not refill existing current CP');

fighter.setCp(999999);
calculateStats({}, fighter);
assert.strictEqual(fighter.fetchCp(), fighter.fetchMaxCp(), 'current CP should clamp down to max CP');

const playerVictim = combatActor({ hp: 100, cp: 30 });
ReceivedHit(hitSession({ fetchId: () => 2000001 }), playerVictim, 20);
assert.strictEqual(playerVictim.fetchCp(), 10, 'PvP damage should consume CP before HP');
assert.strictEqual(playerVictim.fetchHp(), 100, 'PvP damage fully absorbed by CP should not reduce HP');

ReceivedHit(hitSession({ fetchId: () => 2000001 }), playerVictim, 40);
assert.strictEqual(playerVictim.fetchCp(), 0, 'PvP overflow damage should consume remaining CP');
assert.strictEqual(playerVictim.fetchHp(), 70, 'PvP overflow damage should reduce HP after CP is gone');

const npcHitVictim = combatActor({ hp: 100, cp: 30 });
ReceivedHit(hitSession({ fetchId: () => 3000001, fetchKind: () => 'Monster' }), npcHitVictim, 20);
assert.strictEqual(npcHitVictim.fetchCp(), 30, 'NPC damage should not consume player CP');
assert.strictEqual(npcHitVictim.fetchHp(), 80, 'NPC damage should still reduce HP directly');

// C4 PcStatus.reduceHp: a summon or pet is playable, its damage goes to CP first.
for (const servitor of [{ fetchId: () => 1000001, fetchKind: () => 'Monster', fetchIsSummon: () => true },
    { fetchId: () => 1000002, fetchKind: () => 'Pet', fetchIsSummon: () => true, fetchIsPet: () => true }]) {
    const summonHitVictim = combatActor({ hp: 100, cp: 30 });
    ReceivedHit(hitSession({ fetchId: () => 2000001 }), summonHitVictim, 40, { source: servitor });
    assert.deepStrictEqual([summonHitVictim.fetchCp(), summonHitVictim.fetchHp()], [0, 90],
        'summon and pet damage consumes CP before HP');
}

// A vitals update (regen tick, received hit) leaves the stats a full rebuild
// would give: after a plain HP change, a passive's HP threshold crossing, an
// effect added or expired without its own refresh, a move, nightfall.
const packets = [];
const live = Object.assign(actor(), {
    level: 40, moving: false, night: false,
    session: { dataSendToMe: (packet) => packets.push(packet) },
    fetchId: () => 2000003, fetchMaxLoad() { return this.maxLoad; },
    state: { inMotion() { return live.moving; }, fetchWalkin: () => false, fetchSeated: () => false },
    gameTime: { isNight: () => live.night },
    skillset: { fetchSkills: () => [290, 225, 294].map((selfId) => new Skill({ selfId, level: 1, passive: true })) }
});
live.backpack.fetchItems = () => [];
const statsOf = (a) => ['maxHp', 'maxMp', 'maxCp', 'hp', 'mp', 'cp', 'load', 'maxLoad', 'collectivePAtk',
    'collectiveMAtk', 'collectivePDef', 'collectiveMDef', 'collectiveAccur', 'collectiveEvasion',
    'collectiveCritical', 'collectiveAtkSpd', 'collectiveCastSpd', 'collectiveWalkSpd', 'collectiveRunSpd']
    .map((key) => a[key]);
function vitals(a) {
    packets.length = 0;
    Actor.prototype.statusUpdateVitals.call(a, a);
    const stats = statsOf(a), packet = packets[0];
    calculateStats({}, a);
    packets.length = 0;
    Actor.prototype.statusUpdateVitals.call(a, a);
    assert.deepStrictEqual(statsOf(a), stats, 'a vitals update leaves the stats of a full rebuild');
    assert.deepStrictEqual(packets[0], packet, 'and the same status packet');
    return stats;
}
calculateStats({}, live);
live.setHp(live.fetchMaxHp());
calculateStats({}, live);
const healthyPAtk = live.collectivePAtk, restingEvasion = live.collectiveEvasion, dayAccuracy = live.collectiveAccur;
live.setHp(live.fetchMaxHp() * 0.5);
vitals(live);
assert.strictEqual(live.collectivePAtk, healthyPAtk, 'a hit above the threshold keeps the stats');
live.setHp(live.fetchMaxHp() * 0.3);
vitals(live);
assert.strictEqual(live.collectivePAtk, healthyPAtk + 32.9, 'a hit to 30 % HP turns on the low-HP passive');
live.setHp(live.fetchMaxHp() * 0.31);
vitals(live);
assert.strictEqual(live.collectivePAtk, healthyPAtk, 'regen above 30 % turns it off');
EffectStore.apply(live, { id: 9002, key: 'quiet-might', stats: { pAtkMul: 2 } });
vitals(live);
assert.strictEqual(live.collectivePAtk, healthyPAtk * 2, 'an effect added without a refresh counts at the next update');
live.effects['quiet-might'].expiresAt = Date.now() - 1;
vitals(live);
assert.strictEqual(live.collectivePAtk, healthyPAtk, 'an effect expired without a refresh stops counting');
live.moving = true;
vitals(live);
assert.strictEqual(live.collectiveEvasion, restingEvasion + 4, 'running turns on the running passive');
live.night = true;
vitals(live);
assert.strictEqual(live.collectiveAccur, dayAccuracy + 3, 'nightfall turns on the night passive');

console.log('CP stat checks passed');
