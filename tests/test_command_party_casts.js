'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Tracker = invoke('GameServer/Bot/AI/HotPartyCastTracker');
const Attack = invoke('GameServer/Actor/Attack');
const World = invoke('GameServer/World/World');
const Skill = invoke('GameServer/Model/Skill');
const originalNow = Date.now, originalScan = World.fetchNpcsInRadius;
const actors = [];
function actor(id) {
    const body = { hp: 10000, fetchId: () => id, fetchDestId: () => 0,
        fetchAttackable: () => true, fetchIsOnline: () => true, isDead: () => false,
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
        fetchHp: () => body.hp, fetchMaxHp: () => 10000,
        fetchMAtk: () => 1000, fetchMDef: () => 100, fetchCastSpd: () => 333,
        fetchPAtk: () => 100, fetchPDef: () => 100, fetchAtkSpd: () => 333,
        attack: {}, state: { fetchCasts: () => true } };
    actors.push(body);
    return body;
}
const main = { actor: actor(1), commandParties: new Map([[1, {}]]) };
const primary = { actor: actor(2), partyCompanion: true, followPlayerSession: main };
const helper = { actor: actor(3), partyCompanion: true };
helper.followPlayerSession = helper;
helper.clanCommandParty = { active: true, commander: main, movement: 'follow' };
primary.actor.session = primary; helper.actor.session = helper;
const target = actor(100), add = actor(101);
const nuke = new Skill({ selfId: 1177, passive: false, level: 1, spell: true, power: 100, hitTime: 1000, distance: 600 });
const sleep = new Skill({ selfId: 1069, passive: false, level: 1, spell: true, hitTime: 1000, distance: 600 });
const root = new Skill({ selfId: 1201, passive: false, level: 1, spell: true, hitTime: 1000, distance: 600 });
try {
    let now = 10000;
    Date.now = () => now;
    assert.equal(Tracker.begin(primary, primary.actor, target, nuke), true);
    assert.equal(Tracker.mayCast(helper, target, nuke), true, 'a full-health target accepts simultaneous damage from both parties');
    assert.equal(Tracker.mayCast(helper, target, sleep), false, 'Sleep cannot be scheduled on an off-target with an accepted damage cast');
    target.hp = 1;
    assert.equal(Tracker.mayCast(helper, target, nuke), false, 'already committed lethal damage prevents another wasted nuke');
    Tracker.clear(primary.actor);
    assert.equal(Tracker.mayCast(helper, target, nuke), true, 'an interrupted cast releases its damage reservation');
    target.hp = 10000;
    Tracker.begin(primary, primary.actor, add, sleep);
    assert.equal(Tracker.mayCast(helper, add, root), false, 'another party cannot root an add with a sleep in flight');
    assert.equal(Tracker.mayCast(helper, add, sleep), false, 'pending sleep is shared across parties');
    assert.equal(Tracker.mayCast(helper, add, nuke), false, 'damage does not break another party sleep reservation');
    const native = { blockedPvpDefense: () => false, checkParticipants: () => false, validateSkillTarget: () => true };
    helper.actor.canUseSkill = () => { assert.fail('a conflicting cast must be rejected before reuse or resources are touched'); };
    Attack.prototype.remoteHit.call(native, helper, add, root);
    delete helper.actor.canUseSkill;
    const unrelated = { actor: actor(4), partyCompanion: true, followPlayerSession: { actor: actor(5) } };
    assert.equal(Tracker.mayCast(unrelated, add, root), true, 'unrelated parties do not share command reservations');
    const area = new Skill({ selfId: 1177, passive: false, level: 1, spell: true, power: 100, hitTime: 1000, distance: 600 });
    area.semantic = { ...area.semantic, sourceTarget: 'area', radius: 200 };
    World.fetchNpcsInRadius = () => [add];
    assert.equal(Tracker.mayCast(helper, target, area), false, 'splash damage also preserves a controlled add');
    Tracker.clear(primary.actor);
    assert.equal(Tracker.mayCast(helper, add, root), true, 'cast cancellation permits a replacement controller immediately');
    const Effects = invoke('GameServer/Effects/EffectStore');
    Effects.apply(add, { key: 'sleep', id: 1069, category: 'sleep', type: 'debuff', durationMs: 30000 });
    const landing = Object.create(Attack.prototype);
    landing.restoreShotState = () => assert.fail('a nuke accepted before Sleep must not enter the native effect pipeline');
    assert.equal(landing.commandImpactAllowed(helper, helper.actor, add), false,
        'an already launched arrow or polearm secondary hit cannot break off-target Sleep');
    assert.equal(landing.commandImpactAllowed(helper, helper.actor, add, nuke), false);
    landing.applyRemoteCastEffect(helper, helper.actor, add, nuke, {});
    Effects.remove(add, 'sleep');
    Tracker.begin(primary, primary.actor, target, nuke);
    primary.actor.attack.abortCast = () => { Tracker.clear(primary.actor); return true; };
    assert.equal(Tracker.cancelForDeadNpc(target), 1);
    assert.equal(Tracker.trackedCount(target), 0, 'death clears all outstanding reservations');
    assert.equal(Tracker.mayCast(helper, target, nuke), true);
    Tracker.begin(primary, primary.actor, add, sleep);
    assert.equal(Tracker.mayCast(main, add, nuke), true, 'the human retains manual skill control');
    Tracker.clear(primary.actor);
    Tracker.begin(main, main.actor, target, nuke);
    main.actor.attack.abortCast = () => assert.fail('command coordination must not change human cast cancellation');
    assert.equal(Tracker.cancelForDeadNpc(target), 0);
    Tracker.begin(primary, primary.actor, add, sleep);
    now += 10000;
    assert.equal(Tracker.mayCast(helper, add, root), true, 'a missing completion callback cannot reserve control forever');
    console.log('Command party casts: concurrent damage, overkill, shared control, splash, native recheck, cancellation and death passed');
} finally {
    Date.now = originalNow; World.fetchNpcsInRadius = originalScan;
    actors.forEach(body => Tracker.clear(body));
}
