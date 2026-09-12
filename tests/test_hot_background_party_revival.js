const assert = require('assert');
require('../src/Global');
const Hot = invoke('GameServer/Bot/AI/HotBackgroundParty');
const Revival = invoke('GameServer/Bot/AI/PartyRevivalService');
const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
const World = invoke('GameServer/World/World');
const State = invoke('GameServer/Model/State');
const Effects = invoke('GameServer/Skills/C4SkillEffects');
const Threats = invoke('GameServer/Bot/AI/BotPvpThreats');
const saved = [];
function patch(o, k, v) { const old = o[k]; saved.push(() => o[k] = old); o[k] = v; }
const resurrection = { fetchPassive: () => false, fetchSkillType: () => 'resurrect',
    fetchTargetKind: () => 'corpse_player', fetchConsumedMp: () => 20, fetchPower: () => 20,
    fetchSelfId: () => 1016, fetchSemantic: () => ({ skillType: 'resurrect' }), fetchSpell: () => true };
function member(id, skills = []) {
    const state = new State();
    const actor = { state, x: 0, mp: 100, fetchId: () => id, fetchName: () => `test_${id}`,
        fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0,
        fetchIsOnline: () => true, isDead: () => state.fetchDead(), fetchClassId: () => 0,
        fetchHp: () => 100, fetchMaxHp: () => 100, fetchMaxMp: () => 100, fetchMp() { return this.mp; },
        canUseSkill: () => true, skillset: { skills }, fetchDestId() { return this.dest; },
        select({id}) { this.dest = id; }, unselect() { this.dest = undefined; },
        automation: { abortAll() {}, replenishVitals() {} }, attack: { clearTimers() {}, resetQueuedEvent() {} } };
    const s = { actor, accountId: `bot_test_${id}`, arenaEphemeral: true, hotBackgroundPartyId: 'revival',
        dataSendToOthers() {}, dataSendToMe() {}, packets: [], dataSendToMeAndOthers(p) { this.packets.push(p); } };
    actor.session = s;
    return s;
}
try {
    const leader = member(2000100, [resurrection]);
    const healer = member(2000101, [resurrection]);
    const fallen = member(2000102);
    const group = [leader, healer, fallen];
    patch(Parties, 'find', id => id === 'revival' ? { partyId: id, status: 'hot', leaderId: 2000100,
        memberIds: group.map(s => s.actor.fetchId()), stats: {} } : null);
    patch(World, 'user', { sessions: group });
    patch(World, 'npc', { spawns: [] });
    patch(World, 'fetchNpcsInRadius', () => []);
    let danger = false;
    patch(Threats, 'context', () => ({ threats: danger ? [{}] : [] }));
    const requests = [];
    const Generics = { skillExec(s, a, data) { requests.push({s, a, data}); a.state.setCasts(true); } };
    const AI = { executeCombat() { throw Error('A rescue must not start another hunt'); } };
    const tick = s => Hot.tick(s, s.actor, Generics, AI);
    const now = Date.now();
    fallen.actor.state.setDead(true); fallen.deathTimerStart = now - 13000;
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now), false, 'background corpse must survive the solo 12-second deadline');
    tick(healer);
    assert.strictEqual(healer.lastDecision.action, 'party_wait_resurrection', 'other members hold the camp for the elected provider');
    tick(leader); tick(healer);
    assert.strictEqual(requests.length, 1, 'only one provider starts the native skill request');
    assert.strictEqual(requests[0].data.id, fallen.actor.fetchId());
    assert.strictEqual(requests[0].s, leader, 'an autonomous leader can resurrect too');
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now + 20000), false);
    fallen.deathTimerStart = now - 61000;
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now), false, 'in-flight rescue owns the target past the safe-wait deadline');
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now + 26000), true, 'a failed attempt cannot hold a corpse forever');

    // Run the actual resurrection effect and stand-up callback, rather than
    // treating a skill selection as evidence that the target revived.
    const nativeTimers = [];
    patch(global, 'setTimeout', fn => { nativeTimers.push(fn); return 0; });
    const result = Effects.execute(leader, leader.actor, fallen.actor, resurrection);
    assert.strictEqual(result.resurrected, true);
    assert(fallen.packets.some(p => p[0] === 0x07));
    nativeTimers.forEach(fn => fn());
    assert.strictEqual(fallen.actor.isDead(), false);
    assert.strictEqual(fallen.deathTimerStart, undefined);
    assert.strictEqual(fallen.actor.x, 0, 'native resurrection keeps the corpse location');
    saved.pop()();
    leader.actor.state.setCasts(false);

    leader.actor.state.setDead(true); leader.deathTimerStart = now;
    tick(healer);
    assert.strictEqual(requests.at(-1).data.id, leader.actor.fetchId(), 'dead leader remains the rescue anchor and is revived first');
    healer.actor.state.setDead(true); healer.actor.state.setCasts(false);
    assert.strictEqual(Revival.shouldTownRespawn(leader, healer, now), true, 'no living provider means normal town recovery');
    assert.strictEqual(Revival.tick(fallen, leader, Generics).handled, false, 'an unskilled survivor cannot conjure a resurrection scroll');
    leader.actor.state.setDead(false); leader.partyRevivalAttempt = null;
    leader.actor.skillset.skills = []; healer.actor.state.setDead(false);
    fallen.actor.state.setDead(true); fallen.deathTimerStart = now;
    healer.actor.mp = 0;
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now + 13000), false, 'allow a nearby learned provider time to regenerate MP');
    const before = requests.length;
    tick(healer);
    assert.strictEqual(requests.length, before, 'no MP does not fall back to a free scroll');
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now + 61000), true, 'safe waiting has a finite budget');
    healer.actor.mp = 100; healer.actor.x = 2000;
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now), true, 'remote providers do not trap a corpse');
    healer.actor.x = 0;
    danger = true;
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now + 10000), false);
    assert.strictEqual(Revival.tick(healer, leader, Generics).handled, false, 'PvP prevents an unsafe resurrection');
    danger = false;
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now + 90000), false, 'combat time does not consume the safe resurrection budget');
    leader.actor.state.setDead(true); healer.actor.state.setDead(true);
    assert.strictEqual(Revival.shouldTownRespawn(leader, fallen, now), true, 'a wipe releases the group for town recovery');
    console.log('Hot background party resurrection checks passed');
} finally { saved.reverse().forEach(fn => fn()); }
