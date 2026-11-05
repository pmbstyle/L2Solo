const assert = require('assert');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init();
const Profiles = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Skillset = invoke('GameServer/Actor/Skillset');
const Utility = invoke('GameServer/Bot/AI/BotCombatUtility');
const Feedback = invoke('GameServer/Bot/AI/BotActionFeedback');
const Attack = invoke('GameServer/Actor/Attack');
const skills = new Skillset().populateSnapshot(Profiles.skillSnapshotsFromRecords([{ selfId: 56, level: 15 }, { selfId: 19, level: 1 }]));
let allowed = true, weapon = 'Weapon.Bow';
const bot = { fetchId: () => 1, fetchClassId: () => 9, fetchLevel: () => 40,
    fetchHp: () => 1000, fetchMaxHp: () => 1000, fetchMp: () => 1000, fetchMaxMp: () => 1000,
    canUseSkill: () => allowed, skillset: { skills }, backpack: { fetchTotalWeaponKind: () => weapon } };
const session = { accountId: 'bot_feedback', actor: bot, dataSendToMe() {} };
const target = { fetchId: () => 2, fetchHp: () => 1000 };
const selected = Utility.select(bot, target, 'archer', { pvp: true });
assert(selected);
// Use the native rejection gate, not a simulated selector failure.
allowed = false;
Attack.prototype.remoteHit.call(Object.assign(new Attack(), {
    blockedPvpDefense: () => false, checkParticipants: () => false
}), session, target, selected.skill);
allowed = true;
assert(Feedback.blocked(bot, target, selected.skill), 'a native rejection backs the skill off on this target');
const rejectedAlternatives = [];
const fallback = Utility.select(bot, target, 'archer', { pvp: true, rejectedAlternatives });
assert(fallback && fallback.skill !== selected.skill, 'native rejection must allow a different useful attack');
assert(rejectedAlternatives.some(entry => entry.reason === 'native_rejection_backoff'));
assert(!Feedback.blocked(bot, { ...target, fetchId: () => 3 }, selected.skill), 'new targets are independent');
weapon = 'Weapon.Blunt';
assert(!Feedback.blocked(bot, target, selected.skill), 'a changed loadout is reassessed');
weapon = 'Weapon.Bow';
assert(!Feedback.blocked(bot, target, selected.skill, Date.now() + Feedback.RETRY_MS), 'failed attempts cannot lock a skill forever');
Feedback.record(session, bot, target, selected.skill, 'ineffective', 'miss');
assert(!Feedback.blocked(bot, target, selected.skill), 'ordinary misses do not suppress valid attacks');
for(const outcome of [{heal:20},{mpRestore:10},{effect:{id:1201}},{charges:1},{cancelled:[1068]}]) {
    assert(Feedback.effective(outcome),'native support/control/charge result fields count as useful results');
}
assert(!Feedback.effective({heal:0,effect:null,missed:true}));
Feedback.result(session,bot,target,selected.skill,{skillType:'heal',heal:20});
const player = { accountId: 'human', actor: bot };
Feedback.record(player, bot, target, selected.skill, 'rejected', 'test');
assert(!Feedback.blocked(bot, target, selected.skill), 'a player cast is not bot feedback');
const backstab = new Skillset().populateSnapshot(Profiles.skillSnapshotsFromRecords([{selfId:30,level:1}]))[0];
let x=10;
const dagger = {...bot,fetchClassId:()=>8,fetchLocX:()=>x,fetchLocY:()=>0,attack:new Attack(),
    backpack:{fetchTotalWeaponKind:()=> 'Weapon.Knife'}};
const facing = {...target,fetchHead:()=>0,fetchLocX:()=>0,fetchLocY:()=>0};
assert.strictEqual(Utility.evaluate(dagger,facing,backstab,'dagger',{pvp:true}),null,'Backstab must not waste MP from the front');
x=-10;
assert(Utility.evaluate(dagger,facing,backstab,'dagger',{pvp:true}),'native rear position opens the attack window');
facing.fetchHead=()=>32767;
assert.strictEqual(Utility.evaluate(dagger,facing,backstab,'dagger',{pvp:true}),null,'target turning invalidates the previous attack window');
console.log('Native rejection feedback, alternate action, target/loadout changes and bounded retry passed');
