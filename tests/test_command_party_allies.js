'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const World = invoke('GameServer/World/World');
const Awareness = invoke('GameServer/Bot/AI/PartyAwareness');
const Following = invoke('GameServer/Bot/AI/States/FollowingState');
const Attack = invoke('GameServer/Actor/Attack');
const Skill = invoke('GameServer/Model/Skill');
const { registerSessions } = require('./helpers/worldSessions');
const restores = [];
function patch(object, key, value) { const old = object[key]; restores.push(() => { object[key] = old; }); object[key] = value; }
function member(id, owner = null, clan = 77) {
    const actor = { clan, target: 0, fetchId: () => id, fetchSelfId: () => 0,
        fetchName: () => `member${id}`, fetchClassId: () => 1, fetchLevel: () => 40,
        fetchClanId: () => actor.clan, fetchPvpFlag: () => 1, fetchKarma: () => 0,
        fetchDestId: () => actor.target, fetchIsOnline: () => true, fetchAttackable: () => false,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHp: () => 1000, fetchMaxHp: () => 1000,
        isDead: () => false, select({ id }) { actor.target = id; }, unselect() { actor.target = 0; },
        state: { fetchDead: () => false, fetchCasts: () => false, fetchHits: () => false, fetchTowards: () => false,
            setHits() {}, setCasts() {} },
        backpack: { fetchTotalWeaponKind: () => 'Weapon.Sword', fetchEquippedArmors: () => [], fetchItems: () => [] },
        attack: { abortCast() {}, clearTimers() {}, resetQueuedEvent() {} }, automation: { abortAll() {} } };
    const session = { actor, accountId: owner ? `bot_${id}` : `player_${id}`, plan: 'following',
        dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
    if (owner) Object.assign(session, { partyCompanion: true, followPlayerSession: owner });
    actor.session = session;
    return session;
}
async function main() {
    const commander = member(81001), primary = member(81002, commander), extra = member(81003), outsider = member(81004), enemy = member(81005, null, 99);
    Object.assign(extra, { partyCompanion: true, followPlayerSession: extra });
    const group = { active: true, commander, owner: extra, number: 1, movement: 'follow' };
    extra.clanCommandParty = group;
    commander.commandParties = new Map([[1, group]]);
    patch(World, 'user', {}); patch(World, 'npc', { spawns: [] });
    registerSessions([commander, primary, extra, outsider, enemy]);
    patch(World, 'fetchUser', async id => World.user.sessions.find(s => s.actor.fetchId() === id).actor);
    patch(invoke('GameServer/Bot/AI/PendingSweep'), 'tick', () => false);
    const dispatched = [];
    const assist = target => {
        commander.actor.target = target.actor.fetchId();
        primary.currentTargetId = undefined;
        Following.tickLootAndLeaderTarget({ session: primary, bot: primary.actor, Generics: {},
            BotAI: { executePvPCombat(_s, _a, target) { dispatched.push(target.fetchId()); } },
            playerSession: commander, player: commander.actor, role: 'dps', partyThreat: null,
            leaderTargetId: target.actor.fetchId(), acted: false, keepRoleDecision: false });
    };
    for (const ally of [extra, outsider]) {
        commander.actor.target = ally.actor.fetchId();
        assert.equal(Awareness.leaderCombatTargetId(commander), null, 'flagged command members and clanmates are never assist targets');
        assist(ally); await new Promise(resolve => setImmediate(resolve));
    }
    assert.deepEqual(dispatched, []);
    extra.actor.clan = 99;
    assert.equal(Awareness.isCombatAlly(commander, extra.actor), true, 'the command roster is an ally boundary independent of clan flags');
    assist(enemy); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dispatched, [enemy.actor.fetchId()], 'ordinary flagged enemies still receive assist attacks');
    dispatched.length = 0;
    let release;
    World.fetchUser = () => new Promise(resolve => { release = resolve; });
    assist(enemy);
    enemy.actor.clan = 77;
    release(enemy.actor); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(dispatched, [], 'a target that becomes an ally during lookup cannot receive an attack');
    const native = Object.create(Attack.prototype);
    assert.equal(native.blockedPvpDefense(primary, primary.actor, extra.actor), true,
        'native assist attacks reject allies even outside the PvP-defense controller');
    assert.equal(native.commandImpactAllowed(primary, primary.actor, enemy.actor), false,
        'an already launched hit is rechecked after a clan change');
    const nuke = new Skill({ selfId: 1177, level: 1, passive: false, spell: true, power: 100 });
    native.restoreShotState = () => assert.fail('an allied secondary target must be rejected before native effects');
    native.applyRemoteCastEffect(primary, primary.actor, enemy.actor, nuke, {});
    assert.equal(native.commandImpactAllowed(commander, commander.actor, extra.actor), true,
        'the player retains manual native combat control');
    console.log('Command allies: flagged selection, shared roster, clan membership, asynchronous lookup and native impacts passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => restores.reverse().forEach(restore => restore()));
