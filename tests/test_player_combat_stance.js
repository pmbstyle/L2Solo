const assert = require('assert');
require('../src/Global');

const State = invoke('GameServer/Model/State');
const Generics = invoke('GameServer/Actor/Generics');
const World = invoke('GameServer/World/World');
const Attack = invoke('GameServer/Actor/Attack');
const saved = [];
const timers = new Map();
let now = 0;
function patch(object, key, value) {
    const old = object[key];
    saved.push(() => { object[key] = old; });
    object[key] = value;
}
function advance(ms) {
    const end = now + ms;
    while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
            .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.at;
        timers.delete(id);
        timer.fn();
    }
    now = end;
}
function character(id) {
    const actor = {
        state: new State(), hp: 100,
        fetchId: () => id,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8, fetchCollectiveAtkSpd: () => 333,
        fetchHp() { return this.hp; },
        setHp(value) { this.hp = value; },
        statusUpdateVitals() {},
        automation: { replenishVitals() {}, abortAll() { actor.aborts++; } },
        aborts: 0,
        isDead: () => false
    };
    actor.session = {
        actor, packets: [],
        dataSendToMe(packet) { this.packets.push(packet); },
        dataSendToMeAndOthers(packet) { this.packets.push(packet); }
    };
    return actor;
}
function packets(actor, opcode) {
    return actor.session.packets.filter(packet => packet[0] === opcode
        && packet.readInt32LE(1) === actor.fetchId());
}

try {
    patch(global, 'setTimeout', (fn, ms) => {
        const id = { unref() {} };
        timers.set(id, { fn, at: now + ms });
        return id;
    });
    patch(global, 'clearTimeout', id => timers.delete(id));
    patch(Date, 'now', () => now);
    // Keep the real incoming-hit, combat-entry and NPC-kill handlers; isolate
    // world removal/rewards, which have no bearing on the victim's stance.
    patch(World, 'removeNpc', () => {});
    const player = character(2000001);
    const bot = character(2000002);
    bot.session.accountId = 'bot_stance_test';
    bot.isDead = () => true; // Skip reward distribution after kill cleanup.
    const monster = {
        fetchKind: () => 'Monster', fetchId: () => 900001,
        fetchLocX: () => 20, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchRadius: () => 8, state: new State()
    };

    Generics.receivedHit(player.session, player, 10, { source: monster });
    assert(player.state.fetchCombats(), 'receiving an NPC hit enters combat');
    assert.strictEqual(packets(player, 0x2b).length, 1);
    Generics.npcDied(bot.session, bot, monster);
    player.state.setTowards('pickup');
    advance(15000);
    assert.strictEqual(player.state.fetchCombats(), false,
        'a passive victim must leave combat after another character kills its attacker');
    assert.strictEqual(packets(player, 0x2c).length, 1, 'send AutoAttackStop to the victim');
    assert.strictEqual(player.aborts, 0, 'stance expiry must preserve movement and pickup');
    assert.strictEqual(player.state.fetchTowards(), 'pickup');

    // Another attacker can relay the hit through its own session. The victim
    // still receives both stance packets, and every hit renews the deadline.
    const attacked = character(2000003);
    const otherMonster = { ...monster, fetchId: () => 900002 };
    Generics.receivedHit(bot.session, attacked, 1, { source: monster });
    advance(14000);
    Generics.receivedHit(bot.session, attacked, 1, { source: otherMonster });
    advance(14999);
    assert(attacked.state.fetchCombats(), 'another incoming hit extends the stance');
    advance(1);
    assert(!attacked.state.fetchCombats());
    assert.strictEqual(packets(attacked, 0x2b).length, 1, 'do not duplicate combat entry');
    assert.strictEqual(packets(attacked, 0x2c).length, 1);
    assert(!bot.session.packets.some(packet => packet[0] === 0x2b
        && packet.readInt32LE(1) === attacked.fetchId()), 'entry uses the victim session');

    // Lisvus renews on a landed normal hit and offensive cast completion,
    // rather than accepting a swing/cast or merely staying busy.
    const fighter = character(2000004);
    fighter.backpack = { fetchTotalWeaponKind: () => 'Weapon.Sword' };
    const attack = new Attack();
    const swings = [];
    attack.prepareMeleeHit = () => ({ damage: 1, flags: 0 });
    attack.resolveMeleeTargets = () => [monster];
    attack.queueTimer = callback => swings.push(callback);
    patch(invoke('GameServer/Npc/Generics'), 'receivedHit', () => {});
    patch(invoke('GameServer/Formulas'), 'calcHitChance', () => true);
    Generics.enterCombatState(fighter.session, fighter);
    advance(14000);
    attack.meleeHit(fighter.session, monster);
    advance(500);
    swings[0](); // Land the accepted swing; skip the automatic repeat.
    fighter.state.setHits(false);
    advance(14999);
    assert(fighter.state.fetchCombats(), 'a landed outgoing swing refreshes the deadline');
    advance(1);
    assert(!fighter.state.fetchCombats());

    const missed = character(2000009);
    missed.backpack = fighter.backpack;
    patch(invoke('GameServer/Formulas'), 'calcHitChance', () => false);
    Generics.enterCombatState(missed.session, missed);
    advance(14000);
    const missedSwing = swings.length;
    attack.meleeHit(missed.session, monster);
    advance(500);
    swings[missedSwing]();
    advance(500);
    assert(!missed.state.fetchCombats(), 'a missed normal hit does not renew the stance');

    const caster = character(2000005);
    attack.chargeShotForSkill = () => {};
    attack.calculatedSkillHitTime = () => 20000;
    const spell = {
        fetchSpell: () => true, fetchTargetKind: () => 'enemy',
        fetchSelfId: () => 1177, fetchLevel: () => 1, fetchReuseTime: () => 0,
        setCalculatedHitTime(ms) { this.hitTime = ms; },
        fetchCalculatedHitTime() { return this.hitTime; }
    };
    Generics.enterCombatState(caster.session, caster);
    advance(14000);
    attack.beginRemoteCast(caster.session, caster, monster, spell);
    advance(1000);
    assert(!caster.state.fetchCombats(), 'cast acceptance does not extend the stance');
    assert(caster.state.fetchCasts(), 'stance expiry does not abort the long cast');
    attack.finishRemoteCast(caster.session, caster, spell, true);
    assert(caster.state.fetchCombats(), 'completed offensive casting starts the stance again');
    advance(14999);
    assert(caster.state.fetchCombats(), 'completed casting grants the full idle timeout');
    advance(1);
    assert(!caster.state.fetchCombats());

    const killer = character(2000008);
    Generics.enterCombatState(killer.session, killer);
    killer.isDead = () => true; // Isolate the native death cleanup from rewards.
    Generics.npcDied(killer.session, killer, monster);
    assert(killer.state.fetchCombats(), 'a kill must not immediately clear the killer stance');
    assert.strictEqual(packets(killer, 0x2c).length, 0);
    monster.state.setDead(true);
    attack.checkParticipants(killer, monster);
    assert(killer.state.fetchCombats(), 'a dead target stops repeat attacks without clearing stance');
    monster.state.setDead(false);
    advance(15000);
    assert(!killer.state.fetchCombats());

    const cancelled = character(2000006);
    Generics.enterCombatState(cancelled.session, cancelled);
    const staleExpiry = [...timers.values()][0].fn;
    Generics.abortCombatState(cancelled.session, cancelled);
    assert.strictEqual(timers.size, 0, 'explicit combat stop clears its timer');
    Generics.enterCombatState(cancelled.session, cancelled);
    staleExpiry();
    assert(cancelled.state.fetchCombats(), 'a cancelled callback cannot end a new encounter');
    advance(15000);
    assert.strictEqual(packets(cancelled, 0x2c).length, 2, 'each encounter stops only once');

    const disconnected = character(2000007);
    disconnected.attack = { destructor() {} };
    disconnected.automation.destructor = () => {};
    patch(Generics, 'unselect', () => {});
    Generics.enterCombatState(disconnected.session, disconnected);
    const lateExpiry = [...timers.values()][0].fn;
    invoke('GameServer/Actor/Actor').prototype.destructor.call(disconnected);
    assert.strictEqual(timers.size, 0, 'death/logout disposal clears the stance timer');
    lateExpiry();
    assert.strictEqual(packets(disconnected, 0x2c).length, 0, 'no packet after disposal');

    monster.state.setCombats(true);
    invoke('GameServer/Actor/CombatStance').refresh(bot.session, monster);
    assert.strictEqual(timers.size, 0, 'NPC combat remains owned by its separate combat loop');

    console.log('Player combat stance: third-party kill, renewed hits/swings/casts, owner packets, movement and disposal passed');
} finally {
    saved.reverse().forEach(restore => restore());
}
