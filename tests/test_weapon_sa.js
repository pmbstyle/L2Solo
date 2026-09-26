const assert = require('assert');
require('../src/Global');
const SA = invoke('GameServer/Items/C4WeaponSA');
const Equipment = invoke('GameServer/Items/C4EquipmentItemSkills');
const Stats = invoke('GameServer/Effects/EffectStats');
const Store = invoke('GameServer/Effects/EffectStore');
const Ticker = invoke('GameServer/Effects/EffectTicker');
const Restrictions = invoke('GameServer/Effects/EffectRestrictions');
const Attack = invoke('GameServer/Actor/Attack');
const Skill = invoke('GameServer/Model/Skill');
const Item = invoke('GameServer/Item/Item');
const ActorModel = invoke('GameServer/Model/Actor');
const DataCache = invoke('GameServer/DataCache');
const CalculateStats = invoke('GameServer/Actor/Generics/CalculateStats');
const BowResources = invoke('GameServer/Actor/BowResources');
DataCache.init();

function weapon(id, enchant = 0) {
    const t = DataCache.items.find(x => x.selfId === id);
    assert(t, `Missing usable template: ${id}`);
    return new Item(100000 + id, { selfId: id, ...t.template, ...t.stats, ...t.etc, amount: 1, equipped: true, enchant });
}
function actor(id = 2000001) {
    return {
        hp: 500, maxHp: 1000, mp: 1000, effects: {},
        fetchId: () => id, fetchName: () => 'SA tester', fetchLevel: () => 70,
        fetchHp() { return this.hp; }, fetchMaxHp() { return this.maxHp; }, setHp(n) { this.hp = n; },
        fetchMp() { return this.mp; }, fetchMaxMp: () => 1000, setMp(n) { this.mp = n; },
        fetchCollectivePAtk: () => 100, fetchCollectiveMAtk: () => 100,
        fetchCollectivePDef: () => 100, fetchCollectiveMDef: () => 100,
        fetchCollectiveCritical: () => 1000, fetchDex: () => 30,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0,
        statusUpdateVitals() {}, isDead() { return this.hp <= 0; },
        state: { fetchDead: () => false, setHits() {}, setCasts() {}, setTowards() {} },
        backpack: { fetchTotalWeaponPAtkRnd: () => 0 }
    };
}
function equip(a, id, enchant = 0) {
    const w = weapon(id, enchant);
    a.backpack.fetchEquippedWeapon = () => w;
    a.backpack.fetchItems = () => [w];
    a.backpack.fetchTotalWeaponKind = () => w.fetchKind();
    Equipment.sync(a, [w]);
    return w;
}
function session(a) { return { actor: a, dataSendToMe() {}, dataSendToMeAndOthers() {}, dataSendToOthers() {} }; }
const attack = new Attack();
attack.hit = (_s, _a, target, damage) => target.setHp(Math.max(0, target.fetchHp() - damage));
const offensive = new Skill({ selfId: 1230, name: 'Prominence', level: 1, spell: true });
const friendly = new Skill({ selfId: 1011, name: 'Heal', level: 1, spell: true });
const allActors = [];
try {
    // Every ordinary SA and C-S dual from the source is instantiable, without duplicate catalog IDs.
    for (const [id, data] of Object.entries(SA.catalog.weapons)) {
        const w = weapon(+id, 4);
        assert.strictEqual(DataCache.items.filter(x => x.selfId === +id).length, 1, `Duplicate template ${id}`);
        assert(w.fetchCritical() >= 40, `Weapon critical must use per-mille units: ${id}`);
        const e = Equipment.effectForItem(w);
        assert(e && Object.values(e.stats).every(Number.isFinite), `Invalid passive for ${id}`);
        const meaningful = Object.keys(e.stats).some(k => !k.startsWith('pvp')) || e.conditionalStats.length
            || data.oncrit || data.oncast || data.miser || data.cheapShot || data.attackAngle
            || /Light|Towering Blow|Back Blow|Critical Anger|Critical Drain|Magic Damage/.test(data.name);
        if (data.name.includes(' - ')) assert(meaningful, `Unimplemented SA: ${id} ${data.name}`);
    }
    assert.strictEqual(weapon(6364).fetchCritical(), weapon(6581).fetchCritical(), 'Installing Haste does not change base critical rate');
    assert.strictEqual(weapon(4682).fetchCritical(), 80, 'XML critical 8 is 80 per-mille in runtime');
    assert.strictEqual(weapon(4683).fetchMass(), 430, 'Light uses reduced item mass');
    assert.strictEqual(weapon(7720).fetchAttackRange(), 80, 'Towering Blow overrides the base pole range');

    const a = actor(); allActors.push(a);
    equip(a, 6601);
    assert.strictEqual(Stats.multiplier(a, 'pAtkSpdMul'), 1.07, 'Duplicated inline/skill Haste applies once');
    equip(a, 5632);
    assert.strictEqual(Stats.add(a, 'pAccuracyCombatAdd'), 4, 'Inline Guidance is active');
    equip(a, 5640);
    assert.strictEqual(Stats.add(a, 'mAtkAdd'), 30, 'Inline Empower replaces duplicate skill stat');
    equip(a, 7705); a.hp = 600;
    assert.strictEqual(Stats.add(a, 'pEvasionRateAdd'), 7, 'Conditional duplicate applies once');
    a.hp = 601;
    assert.strictEqual(Stats.add(a, 'pEvasionRateAdd'), 0, 'Risk bonus expires immediately above 60%');
    equip(a, 6580, 3);
    assert.strictEqual(Stats.multiplier(a, 'maxHpMul'), 1);
    equip(a, 6580, 4);
    assert.strictEqual(Stats.multiplier(a, 'maxHpMul'), 1.15);
    assert.strictEqual(Stats.multiplier(a, 'maxMpMul'), 1.2);
    assert.strictEqual(Stats.multiplier(a, 'maxCpMul'), 1.3);
    Equipment.sync(a, []);
    assert.strictEqual(Stats.multiplier(a, 'maxHpMul'), 1, 'Unequip removes dual bonuses');

    // Real model setters keep cached combat stats in sync when HP crosses the risk threshold.
    const risk = new ActorModel({ id: 2000010, hp: 1000, maxHp: 1000, dex: 30, level: 70, crit: 80, atkSpd: 379, evasion: 0 });
    risk.backpack = { fetchTotalArmorEvasion: () => 0, fetchTotalWeaponCritical: () => 80, fetchTotalWeaponAtkSpd: () => 379 };
    equip(risk, 4727); CalculateStats.refreshConditionalCombatStats(risk);
    const highCrit = risk.fetchCollectiveCritical();
    risk.setHp(600);
    assert.strictEqual(risk.fetchCollectiveCritical(), highCrit + 138.7);
    risk.setHp(601);
    assert.strictEqual(risk.fetchCollectiveCritical(), highCrit);

    const cheap = weapon(5611);
    assert.strictEqual(SA.bowMpCost(cheap, () => 0.379), 2);
    assert.strictEqual(SA.bowMpCost(cheap, () => 0.38), 10);
    const miser = weapon(4814);
    assert.strictEqual(SA.soulshotCost(miser, () => 0.299), 7);
    assert.strictEqual(SA.soulshotCost(miser, () => 0.3), miser.fetchSoulshot());
    equip(a, 5612);
    assert.strictEqual(Stats.multiplier(a, 'atkReuseMul'), 0.85);
    equip(a, 5638);
    assert.strictEqual(attack.skillMpCost(a, { fetchConsumedMp: () => 100, fetchSpell: () => true }), 115);
    assert.strictEqual(attack.skillMpCost(a, { fetchConsumedMp: () => 100, fetchSpell: () => false }), 100);
    assert.strictEqual(SA.pvpMultiplier(a, actor(2000002), 'magic'), 1.05);
    assert.strictEqual(SA.pvpMultiplier(a, actor(12345), 'magic'), 1);
    equip(a, 4842); assert.strictEqual(SA.attackAngle(a), 180);

    // Execute every sourced proc through the real effect engine (controls, DoT and support buffs).
    for (const [id, data] of Object.entries(SA.catalog.weapons)) {
        if (!data.oncrit && !data.oncast) continue;
        const source = actor(); const target = actor(2000002); allActors.push(source, target);
        equip(source, +id);
        source.soulshotLoaded = source.spiritshotLoaded = source.blessedSpiritshotLoaded = true;
        let result;
        if (data.oncast) {
            const proc = SA.procSkill(data.oncast);
            assert(proc?.fetchSemantic().durationMs > 0, `Missing proc duration for ${id}`);
            const trigger = proc.fetchSemantic().effectType === 'buff' ? friendly : offensive;
            result = SA.onCast(session(source), source, target, trigger, { attack, rng: () => 0 });
            assert(result?.effect, `Cast proc must apply ${id}: ${data.name}`);
            const other = trigger === friendly ? offensive : friendly;
            assert.strictEqual(SA.onCast(session(source), source, target, other, { attack, rng: () => 0 }), null);
        } else {
            result = SA.onCritical(session(source), source, target, { damage: 100, attack, rng: () => 0 });
            if (!/Drain/.test(data.name)) assert(result?.effect, `Crit proc must apply ${id}: ${data.name}`);
        }
        assert.strictEqual(source.mp, 1000, 'Procs never spend extra MP');
        assert(source.soulshotLoaded && source.spiritshotLoaded && source.blessedSpiritshotLoaded, 'Procs preserve shots');
        Ticker.clearAll(target);
    }
    const target = actor(2000002); allActors.push(target);
    equip(a, 5639);
    SA.onCast(session(a), a, target, offensive, { attack, rng: () => 0 });
    assert.strictEqual(Restrictions.canMove(target), false, 'Paralyze actually immobilizes');
    assert.strictEqual(Restrictions.canAttack(target), false);
    Ticker.clearAll(target); target.effects = {};
    const stunWeapon = equip(a, 5627);
    assert.strictEqual(SA.onCritical(session(a), a, target, { damage: 100, attack, rng: () => 0.999 }), null);
    assert.strictEqual(SA.onCritical(session(a), a, target, { damage: 0, attack, rng: () => 0 }), null);
    equip(a, 4682);
    assert.strictEqual(SA.onCritical(session(a), a, target, { weapon: stunWeapon, damage: 100, attack, rng: () => 0 }), null, 'Switching weapons cannot proc the old SA');
    equip(a, 5606);
    const damage = SA.onCast(session(a), a, target, offensive, { attack, rng: () => 0 });
    assert(damage.damage > 0 && target.hp < 500, 'Magic Damage actually hits');
    assert.strictEqual(SA.onCast(session(a), a, target, friendly, { attack, rng: () => 0 }), null);
    equip(a, 6584); a.hp = 500;
    assert.strictEqual(attack.applyDamageAbsorb(session(a), a, 100), 3);
    assert.strictEqual(a.hp, 503);
    equip(a, 5604); a.hp = 500;
    SA.onCritical(session(a), a, target, { damage: 200, hpDamage: 4, attack });
    assert.strictEqual(a.hp, 504, 'Critical Drain cannot heal overkill or CP-only damage');
    equip(a, 4681); a.hp = 100;
    const hit = attack.prepareMeleeHit(a, target, true, false, () => 0.5);
    assert(hit.anger && hit.damage > 140, 'Critical Anger adds attack-scaled critical damage');
    SA.onCritical(session(a), a, target, { damage: hit.damage, anger: hit.anger, attack });
    assert.strictEqual(a.hp, 88);
    a.hp = 12;
    assert.strictEqual(SA.criticalAnger(a), 0, 'Critical Anger cannot kill its wielder');
    a.hp = 0;
    SA.onCritical(session(a), a, target, { damage: 100, anger: true, attack });
    assert.strictEqual(a.hp, 0, 'Critical Anger cannot revive a wielder killed by reflected damage');

    // Exercise the queued combat entry points, not just the SA dispatch helpers.
    const native = new Attack();
    const callbacks = [];
    native.queueTimer = callback => callbacks.push(callback);
    native.hit = attack.hit;
    native.fetchSkillTargetsInRadius = () => [];
    native.blockedPvpDefense = () => false;
    native.checkParticipants = () => false;
    const fighter = actor(); const victim = actor(2000003); allActors.push(fighter, victim);
    fighter.fetchCollectiveAtkSpd = () => 333;
    fighter.fetchCollectiveAccur = () => 80;
    fighter.fetchCollectiveCastSpd = () => 333;
    fighter.automation = { replenishVitals() {} };
    victim.fetchCollectiveEvasion = () => 30;
    const savedRandom = Math.random;
    const Automation = invoke('GameServer/Automation');
    const savedApproach = Automation.needsGeodataApproach;
    try {
        Math.random = () => 0.1;
        Automation.needsGeodataApproach = () => false;
        equip(fighter, 5627);
        native.meleeHit(session(fighter), victim);
        assert.strictEqual(Store.list(victim).length, 0, 'No proc before impact');
        callbacks.shift()();
        assert(Store.list(victim).some(e => e.key === 'stun'), 'Native critical impact triggers stun');
        callbacks.length = 0;
        Ticker.clearAll(victim); victim.effects = {};
        victim.hp = 1000;
        equip(fighter, 5639);
        native.remoteHit(session(fighter), victim, new Skill({ selfId: 1230, name: 'Prominence', level: 1,
            spell: true, power: 10, mp: 10, hp: 0, itemId: 0, itemCount: 0, distance: 600, hitTime: 100, reuse: 0 }));
        assert.strictEqual(Store.list(victim).length, 0, 'No proc while casting');
        // A chance roll of zero also passes the separate effect-resistance roll.
        Math.random = () => 0;
        while (callbacks.length) callbacks.shift()();
        assert(Store.list(victim).some(e => e.key === 'paralyze'), 'Native landed spell triggers SA');
    } finally {
        Math.random = savedRandom;
        Automation.needsGeodataApproach = savedApproach;
        native.destructor();
        Ticker.clearAll(victim);
    }

    // Cheap Shot is used by the actual arrow/MP transaction, with one chance roll.
    const bowActor = actor(); allActors.push(bowActor); equip(bowActor, 5611); bowActor.mp = 2;
    let arrows = 1;
    bowActor.backpack.fetchItemFromSelfId = () => ({ fetchAmount: () => arrows, fetchId: () => 123 });
    bowActor.backpack.deleteItem = (_s, _id, n, cb) => { arrows -= n; cb(); };
    assert.strictEqual(BowResources.consume(session(bowActor), bowActor, () => 0), true);
    assert.strictEqual(arrows, 0); assert.strictEqual(bowActor.mp, 0);
    console.log(`Weapon SA checks passed: ${Object.keys(SA.catalog.weapons).length} catalog entries and every proc variant`);
} finally {
    allActors.forEach(Ticker.clearAll);
    attack.destructor();
}
