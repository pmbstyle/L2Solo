const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
let role = 'buffer', seated = true, casting = false, moves = 0, aborted = 0;
const casts = [];
const heal = { fetchTargetKind: () => 'friendly', fetchConsumedMp: () => 10, fetchDistance: () => 600, fetchSelfId: () => 1015 };
const leader = { effects: { clan_alliance_poison: {} }, hp: 20, fetchId: () => 2000001, isDead: () => false,
    fetchIsOnline: () => true, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHp() { return this.hp; }, fetchMaxHp: () => 100 };
const bot = { x: 200, mp: 12, fetchId: () => 2000002, isDead: () => false,
    fetchLocX() { return this.x; }, fetchLocY: () => 0, fetchLocZ: () => 0,
    fetchMp() { return this.mp; }, fetchMaxMp: () => 100, canUseSkill: () => true,
    state: { fetchSeated: () => seated, setSeated: v => { seated = v; }, fetchCasts: () => casting, setCasts: v => { casting = v; } },
    automation: { abortAll() { aborted++; } }, select() {}, unselect() {} };
const state = { stage: 'gathering', leaderId: leader.fetchId(), members: [] };
const session = { actor: bot, plan: 'resting', partyCompanion: true, followPlayerSession: { actor: leader },
    currentTargetId: 2000099, pendingSupportApproach: { targetId: 2000099 } };
session.followPlayerSession.partyRevivalAttempt = { providerId: bot.fetchId(), targetId: 2000099 };
const mocks = {
    'GameServer/Clan/ClanAllianceService': { records: new Map([[1, state]]), clanOf: s => s === session ? 2 : 1, idOf: s => s.actor.fetchId(), loc: a => ({ locX: a.fetchLocX(), locY: a.fetchLocY(), locZ: a.fetchLocZ() }) },
    'GameServer/Bot/AI/BotRoles': { inferRole: () => role },
    'GameServer/Bot/AI/BotSkillCapabilities': { healSkills: () => [heal], selectHealSkill: () => heal },
    'GameServer/Bot/AI/CompanionNavigationRecovery': { move(s, b, to) { assert.strictEqual(to.locX, 0); moves++; } },
    'GameServer/Bot/AI/BotSupportPlanner': { cancelSupportCast() {} },
    'GameServer/Effects/EffectStore': { impairments: () => ({}) }
};
const moduleObject = { exports: {} };
vm.runInNewContext(fs.readFileSync('src/GameServer/Bot/AI/ClanAllianceSupportAI.js', 'utf8'), {
    module: moduleObject, invoke: key => { assert(key in mocks, key); return mocks[key]; }
});
const ai = moduleObject.exports;
const generics = { skillExec(s, b, request) { casts.push(request); casting = true; } };
assert(ai.tick(session, bot, generics));
assert(ai.leaderFor(session), 'a party healer from another clan still protects the poisoned leader');
assert.strictEqual(casts[0].id, leader.fetchId(), 'buffer uses its learned heal on the poisoned leader');
assert.strictEqual(seated, false, 'resting support wakes to heal even with low MP if one cast is affordable');
assert.strictEqual(session.pendingSupportApproach, undefined, 'old courier buff approach is cancelled');
assert.strictEqual(session.followPlayerSession.partyRevivalAttempt, null, 'support releases the remote resurrection assignment');
const abortsDuringCast = aborted;
ai.tick(session, bot, generics);
assert.strictEqual(aborted, abortsDuringCast, 'active healing is not interrupted by the next tick');
assert.strictEqual(casts.length, 1);
casting = false; bot.mp = 0;
ai.tick(session, bot, generics);
assert(seated, 'out-of-mana support regenerates beside the leader');
bot.mp = 12; session.clanAllianceSupportRetryAt = 0; role = 'healer';
ai.tick(session, bot, generics);
assert.strictEqual(casts.length, 2, 'healer resumes before full MP recovery');
casting = false; bot.x = 85000;
ai.tick(session, bot, generics);
assert.strictEqual(moves, 1, 'a displaced support returns only toward the leader');
state.members = [{ id: bot.fetchId(), delivered: false }];
assert.strictEqual(ai.tick(session, bot, generics), false, 'assigned courier still performs its own quest task');
state.members[0].delivered = true;
assert(ai.leaderFor(session), 'finished support courier resumes leader healing');
state.stage = 'cured';
assert(ai.leaderFor(session), 'support stays while the leader has received but not used the medicine');
delete leader.effects.clan_alliance_poison;
assert.strictEqual(ai.tick(session, bot, generics), false, 'antidote releases normal party behavior');
state.stage = 'gathering'; role = 'tank';
assert.strictEqual(ai.leaderFor(session), null, 'combat roles do not enter support duty');
console.log('Clan poison support: leader-only healing, rest interruption, movement and duty release passed');
