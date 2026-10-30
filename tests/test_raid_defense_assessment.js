'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Gear = invoke('GameServer/Bot/AI/GearAcquisitionPlanner');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const Catalog = invoke('GameServer/RaidBoss/RaidBossSourceCatalog');
const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const { RaidSearchCounters } = require('../src/GameServer/Bot/Population/RaidSearchCounters');
const at = 1800000000000;
function member(id, classId, level, weapon, healer = false) {
    const items = [weapon, 40, 45, 50, ...(healer ? [432, 465] : [347, 376, 625])]
        .map((selfId, i) => ({ selfId, name: Data.items.find(t => t.selfId === selfId).template.name,
            amount: 1, equipped: 1, slot: [71, 93, 124, 178, 291].includes(selfId) ? 14 : [7, 12, 6, 9, 10, 11, 8][i] }));
    items.push(...[114, 114, 118, 876, 876].map((selfId, i) => ({ selfId, amount: 1, equipped: 1, slot: i + 1 })));
    items.push({ selfId: weapon === 3 ? 1835 : 1463, amount: 2500, slot: 0, equipped: 0 });
    const state = { characterId: id, name: `raider_${id}`, accountName: `bot_${id}`, level, classId,
        adena: 100000, phase: 'cold', activity: 'hunting', updatedAt: at, party: { partyId: null },
        stats: { classId, coldCombat: { classId, skills: Combat.skillsFor({ classId, level }) } },
        inventory: Life.inventorySummaryFromItems(items) };
    const p = Combat.profileFor(state); state.vitals = { hp: p.maxHp, maxHp: p.maxHp, mp: p.maxMp, maxMp: p.maxMp };
    return state;
}
function equip(state, selfId, enchant = 0) {
    const item = Data.items.find(i => i.selfId === selfId), slot = item.etc.slot;
    for (const [key, row] of Object.entries(state.inventory)) if (row.slot === slot
        || slot === 15 && [10, 11].includes(row.slot) || [10, 11].includes(slot) && row.slot === 15
        || [7, 14].includes(slot) && [7, 14].includes(row.slot)) delete state.inventory[key];
    Object.assign(state.inventory, Life.inventorySummaryFromItems([{ selfId, name: item.template.name,
        amount: 1, equipped: 1, slot, enchant }]));
}
const party = [member(1,32,26,3), member(2,42,29,178,true), member(3,29,26,178,true),
    member(4,54,31,157), member(5,56,29,93), member(6,56,28,168),
    member(7,54,28,156), member(8,1,29,124), member(9,56,30,291)];
const spot = Catalog.findById('raid:10366');
(async () => {
    const original = JSON.stringify(party), fit = Policy.assessment(party,spot,{timestamp:at});
    assert(fit.ready, JSON.stringify(fit)); assert.deepEqual(fit.reasons,[]); assert.deepEqual(fit.unchecked,[]);
    assert.equal(fit.defense.requiredHp,(fit.defense.bossDps+fit.defense.guardDps)*12);
    assert(fit.healing>=fit.healingRequired && fit.seconds<=720);
    assert.equal(JSON.stringify(party),original,'assessment preserves physical bags, funds, vitals and skills');
    // The Warrior holds a C two-hander (user 10-29), the others a C War Axe.
    const older = party.map(s => member(s.characterId,s.classId,44,
        Policy.role(s)==='healer'?178:s.classId===1?71:162,Policy.role(s)==='healer'));
    const boss42 = Catalog.findById('raid:10007');
    const d = structuredClone(older); for (const id of [46,606,351,377,1123]) equip(d[0],id,3);
    const c = structuredClone(older); equip(c[0],62);
    const strongD=Policy.assessment(d,boss42,{timestamp:at,fundSupplies:true});
    const smallC=Policy.assessment(c,boss42,{timestamp:at,fundSupplies:true});
    assert.equal(Gear.combatReadiness(d[0]).armorRank,1);
    assert(strongD.defense && smallC.defense,'both kits reach actual combat defense checks');
    assert(strongD.defense.pDef>smallC.defense.pDef,'enchant and item defense matter more than one C boot');
    assert(!strongD.reasons.includes('raid_tank_armor'));
    const full = structuredClone(older); equip(full[0],60);
    assert.deepEqual(Policy.tankArmor(full[0]),[],'full-body heavy armor closes both torso slots');
    assert(Policy.assessment(full,boss42,{timestamp:at,fundSupplies:true}).defense);
    delete full[0].inventory[625];
    assert(Policy.tankArmor(full[0]).includes('raid_tank_shield'));
    const robe = structuredClone(older); equip(robe[0],432); equip(robe[0],465);
    assert(Policy.tankArmor(robe[0]).includes('raid_tank_body'),'caster robes cannot stand in for heavy tank armor');
    const unarmed = structuredClone(party); delete unarmed[0].inventory[3]; delete unarmed[0].inventory[625];
    const gearFail=Policy.assessment(unarmed,spot,{timestamp:at});
    assert(gearFail.reasons.includes('raid_equipment') && gearFail.reasons.includes('raid_tank_shield'));
    assert.deepEqual(gearFail.unchecked,['combat'],'structurally unsafe kits do not launch a speculative preparation');
    const npcRows=Data.npcs;
    let multiple;
    try {
        Data.npcs=npcRows.map(n=>n.selfId===spot.raidBossTemplateId ? { ...n,
            stats:{...n.stats,pAtk:1000000,mAtk:1000000},vitals:{...n.vitals,revHp:1000000} } : n);
        multiple=Policy.assessment(party,spot,{timestamp:at,fundSupplies:true});
        assert(multiple.reasons.includes('raid_damage_below_regeneration'));
        assert(multiple.reasons.includes('raid_tank_survival'));
        assert(multiple.reasons.includes('raid_skill_burst_survival'));
        assert.deepEqual(multiple.unchecked,['duration','healing','supplies']);
        assert.equal(multiple.seconds,undefined,'nonpositive net damage never creates a negative or infinite kill time');
        const objective={sourceKind:'raid',opportunisticRaid:true,spotId:spot.id,fundRaidSupplies:true};
        const group={partyId:'defense_test',leaderId:1,memberIds:party.map(s=>s.characterId),stats:{objective}};
        const joint=await Calculation.calculate(group,party,()=>{throw Error('no personal planner')},at);
        const payload={ok:true,joint,sources:Calculation.sources(party)};
        const valid=value=>Protocol.validateEnvelope(Protocol.envelope('party_goal_result','test',value),'worker').ok;
        assert(valid(payload),'all independent failures and defense facts survive the worker boundary');
        const wrong=structuredClone(payload); wrong.joint.raidAssessment.ready=true;
        assert(!valid(wrong),'a ready forecast cannot carry rejected or untested criteria');
        const invalid=structuredClone(payload); invalid.joint.raidAssessment.defense.pDef=Infinity;
        assert(!valid(invalid),'nonfinite defense is rejected at the worker boundary');
        const duplicate=structuredClone(payload); duplicate.joint.raidAssessment.reasons.push(duplicate.joint.raidAssessment.reason);
        assert(!valid(duplicate),'duplicate reason arrays cannot inflate counters');
    } finally { Data.npcs=npcRows; }
    const counters=new RaidSearchCounters();counters.begin(at);counters.forecast({...multiple,workMs:3.5},spot.raidBossTemplateId);
    const report=counters.snapshot();assert.equal(report.total.forecasts,1);assert.equal(report.total.forecastFailures,1);
    assert.equal(report.total.forecastWorkMs,3.5);
    assert.equal(report.rejections.forecast.raid_damage_below_regeneration,1);
    assert.equal(report.additionalReasons.raid_tank_survival,1);
    assert.equal(report.additionalReasons.raid_damage_below_regeneration,undefined);
    assert.equal(report.unchecked.supplies,1);
    report.lastForecast.defense.pDef=0;assert(counters.lastForecast.defense.pDef>0);
    console.log('Real tank defense, independent failures, finite horizons and bounded diagnostic transport passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
