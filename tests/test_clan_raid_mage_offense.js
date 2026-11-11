'use strict';
const assert = require('node:assert/strict');
require('./helpers/databaseIsolation');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Shots = invoke('GameServer/Inventory/ShotStock');
const Native = invoke('GameServer/Bot/Population/BackgroundResolver').combat;
const Offense = require('../src/GameServer/Clan/ClanRaidOffense');
const Forecast = require('../src/GameServer/Bot/Population/RaidCombatAssessment');
const Estimate = require('../src/GameServer/Clan/ClanRaidEstimate');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Supply = require('../src/GameServer/Bot/Population/RaidSupplyPolicy');
const Fixed = require('../src/GameServer/Bot/Economy/FixedShotOffers');
Supply.useMarket(() => ({ npcOffersFor: id => Fixed.offers(id), tripFrom: () => () => 0 }));
const at = Date.now();
const state = { characterId: 990001, classId: 12, clanId: 77, level: 50, phase: 'cold', activity: 'hunting',
    stats: { classId: 12, money: [100000000,0,0,0] }, adena: 100000000, inventory: {} };
const owned = Combat.skillRecordsFromTree(12,50).filter(skill => skill.selfId === 1230);
assert.equal(owned.length, 1, 'the fixture owns a real learned Prominence rank');
state.stats.coldCombat = Combat.legacySnapshot(state, owned, at);
for (const slot of [7,14,6,9,10,11,12]) {
    if (slot === 14 && Object.values(state.inventory).some(row => row.slot === 7)) continue;
    const item = Data.items.find(item => item.etc?.slot === slot && item.etc.rank === 'c'
        && Gear.suitable(item,state,Gear.roleFor(state),'c'));
    if (item) state.inventory[item.selfId] = { selfId: item.selfId, slot, amount: 1, equipped: true };
}
const shot = Shots.planForState(state, { blessed: false });
state.inventory[shot.selfId] = { selfId: shot.selfId, amount: 100000, stackable: true };
const profile = Combat.fightProfile(state,at);
state.vitals = { hp: profile.maxHp, maxHp: profile.maxHp, mp: profile.maxMp, maxMp: profile.maxMp };
const npc = Data.npcs.find(npc => npc.selfId === 10484), target = Combat.npcCombatStats(npc);
const fighter = { state, profile, role: 'damage' };
const slow = Offense.attack(fighter,target,10,at);
assert.equal(slow.skillId,1230, 'the native chooser uses only the owned nuke');
const fastFighter = { ...fighter, profile: { ...profile, castSpd: profile.castSpd * 2 } };
const fast = Offense.attack(fastFighter,target,10,at);
assert(fast.dps > slow.dps && fast.casts > slow.casts, 'native cast speed increases DPS and spiritshot use');
const bothExecutors = Offense.attack(fastFighter,target,10,at,true,true);
assert(bothExecutors.casts <= fast.casts, 'admission respects the slower cold reuse when it differs');
assert(bothExecutors.reserveRate >= fast.rate, 'stock still covers faster native hot casts across a handoff');
const reused = Offense.attack({ ...fighter, profile: { ...profile,
    effects: [...profile.effects,{key:'reuse-delay',type:'buff',stats:{mReuseMul:5,mReuseDiv:.5}}] } },target,10,at);
assert(reused.dps < slow.dps && reused.casts < slow.casts, 'native reuse limits the cast rate');
const empty = { ...fighter, state: { ...state, vitals: { ...state.vitals, mp: 0 } } };
const emptyCharged = Offense.attack(empty,target,10,at);
assert(emptyCharged.dps < slow.dps && !emptyCharged.usesShots, 'an exhausted mage falls back to uncharged melee');
assert.equal(Offense.attack({ ...empty, charged: false },target,10,at).dps,emptyCharged.dps,
    'a spiritshot never doubles the damage of a normal weapon hit');
const nakedSpellbook = { ...fighter, profile: { ...profile, skills: [] } };
assert.equal(Offense.attack(nakedSpellbook,target,10,at).skillId,undefined,'a forecast cannot invent an unlearned nuke');
const blessedState = structuredClone(state), blessed = Shots.planForState(blessedState,{blessed:true});
blessedState.inventory[blessed.selfId] = { selfId: blessed.selfId, amount: 100000, stackable: true };
assert(Offense.attack({ ...fighter, state: blessedState },target,10,at).dps > slow.dps,
    'native Blessed Spiritshot strengthens magic separately from ordinary spiritshots');
assert(Offense.attack(fighter,{...target,mDef:target.mDef*4},10,at).dps < slow.dps, 'each NPC retains its own magic defense');
const necro = structuredClone(state);
necro.classId = 13; necro.stats.classId = 13;
necro.stats.coldCombat = Combat.legacySnapshot(necro,Combat.skillRecordsFromTree(13,50).filter(skill=>skill.selfId===1148),at);
const necroProfile = Combat.fightProfile(necro,at), boneSpell = necroProfile.skills.find(skill=>skill.selfId===1148);
assert(boneSpell?.itemId > 0 && boneSpell.itemCount > 0,'the native Death Spike owns its real material cost');
const necroFighter = { state:necro,profile:necroProfile,role:'damage' };
assert.equal(Offense.attack(necroFighter,target,60,at).skillId,undefined,'a mage cannot invent spell consumables');
const withBones = structuredClone(necro);
withBones.inventory[boneSpell.itemId] = {selfId:boneSpell.itemId,amount:boneSpell.itemCount*2};
assert.equal(Offense.attack({...necroFighter,state:withBones},target,60,at).casts,2,'actual spell materials cap sustained casting');
const tinyNpc = { ...npc, selfId: 990002, vitals: { ...npc.vitals, maxHp: 1000, revHp: 0 } };
const offenseFor = Offense.forRaid([fighter],at,Forecast.attack);
const damage = Forecast.damageEstimate([fighter],tinyNpc,{offenseFor});
const quick = Forecast.damageEstimate([fastFighter],tinyNpc,{offenseFor:Offense.forRaid([fastFighter],at,Forecast.attack)});
assert(Number.isFinite(damage.seconds) && damage.seconds < 720);
assert(quick.seconds < damage.seconds,'the duration search responds to native spell timing');
assert.equal(damage.attacks[0].rate*damage.seconds,damage.attacks[0].casts,'shot actions are casts, not weapon cycles');
const guardedNpc = Data.npcs.find(npc => Forecast.guardProfiles(npc).length > 0);
assert(guardedNpc);
const guardedDamage = Forecast.damageEstimate([fighter],guardedNpc,{offenseFor:(_fighter,target) => ({
    dps:100000, rate:target.selfId===guardedNpc.selfId?0:2, usesShots:target.selfId!==guardedNpc.selfId })});
assert.equal(guardedDamage.attacks[0].rate,0,'boss actions retain their actual zero shot rate');
assert.equal(guardedDamage.attacks[0].reserveRate,2,'guard casts still receive a full conservative reserve');
assert(guardedDamage.attacks[0].usesShots,'a mage casting only on guards must still procure spiritshots');
const choose = Native.chooseSkill; let reads = 0;
Native.chooseSkill = (...args) => { reads++; return choose(...args); };
try {
    const cached = { ...fighter };
    for (const seconds of [1,10,100,720]) Offense.attack(cached,target,seconds,at);
    assert.equal(reads,1,'horizon probes reuse one native action plan per immutable fighter and target');
} finally { Native.chooseSkill = choose; }

const fixture = require('./fixtures/raid_priority_world.json');
const members = fixture.expected.map(id => {
    const row = fixture.members.find(member => member.characterId === id);
    return { ...row, characterId:id, classId:row.stats.classId, clanId:77, level:id===2006587?50:row.level,
        phase:'cold', activity:'hunting', partyId:null, party:{}, adena:100000000,
        inventory:Life.inventorySummaryFromItems(row.items), stats:{...row.stats,clanId:77,money:[100000000,0,0,0],coldCombat:{...row.captured,
            skills:Combat.skillSnapshotsFromRecords(row.skills.map(([selfId,level])=>({selfId,level})))}} };
});
members[members.length-1] = state;
const spot = invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById(`raid:${fixture.bossId}`);
const assessment = Estimate.estimate(members,spot,new Map(),{timestamp:at,clanId:77}).assessment;
assert(assessment.ready,JSON.stringify(assessment.reasons));
const mageShots = assessment.shotPlans.find(plan => plan.id === state.characterId);
assert(mageShots && mageShots.selfId === shot.selfId);
assert.notEqual(mageShots.required,Math.ceil(1000/Combat.normalAttackMs(profile)*assessment.seconds*shot.perAction*1.3),
    'the real clan admission reserves mage shots from its native cast rate');
console.log('PASS clan mage native spell timing, reuse, MP, shot kinds, duration, immutable-plan cache and cast-based supply');
