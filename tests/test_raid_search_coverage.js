'use strict';
const assert = require('node:assert/strict');
require('../src/Global');
const Data = invoke('GameServer/DataCache'); Data.init({ validate: false });
const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Policy = require('../src/GameServer/Bot/Population/OpportunisticRaidPolicy');
const { BoardIndex } = require('../src/GameServer/AfkTrade/BoardIndex');
const board = new BoardIndex();
board.put({ id: 990001, ownerId: 990002, storeType: 1, kind: 'shop', town: 'Dion',
    lines: [{ lineId: 990003, selfId: 1463, count: 1000000, price: 10 }] });
require('../src/GameServer/Bot/Population/RaidSupplyPolicy').useMarket(() => ({ board, tripFrom: () => () => 0 }));
const Work = require('../src/GameServer/Bot/Population/RaidSearchWork');
const { RaidRosterCoverage, choose, combination, WINDOWS } = require('../src/GameServer/Bot/Population/RaidRosterCoverage');
const { RaidSearchCounters, LIMITS } = require('../src/GameServer/Bot/Population/RaidSearchCounters');
const at = 1800000000000;
const neutral = () => ({ready:true,disposition:'neutral',effective:{hostility:0}});
function member(id, classId, level, weapon, healer = false) {
    const gear = [weapon, 40, 45, 50, ...(healer ? [432, 465] : [347, 376, 625])];
    const slot = [7, 12, 6, 9, 10, 11, 8];
    const items = gear.map((selfId, i) => ({ selfId, amount: 1, equipped: 1,
        slot: [93, 178, 291].includes(selfId) ? 14 : slot[i], name: Data.items.find(t => t.selfId === selfId).template.name }));
    [114, 114, 118, 876, 876].forEach((selfId, i) => items.push({ selfId, amount: 1, equipped: 1,
        slot: i + 1, name: Data.items.find(t => t.selfId === selfId).template.name }));
    items.push({ selfId: weapon === 3 ? 1835 : 1463, amount: 2500, slot: 0, equipped: 0 });
    const s = { characterId: id, name: `adventurer_${id}`, accountName: `bot_${id}`, level, classId,
        adena: 100000, phase: 'cold', activity: 'hunting', party: { partyId: null }, updatedAt: at,
        stats: { classId, coldCombat: { classId, skills: Combat.skillsFor({ classId, level }) } },
        inventory: Life.inventorySummaryFromItems(items) };
    const p = Combat.profileFor(s); s.vitals = { hp: p.maxHp, maxHp: p.maxHp, mp: p.maxMp, maxMp: p.maxMp };
    return s;
}

async function run() {
    for (let n=1;n<=10;n++) for(let k=1;k<=Math.min(6,n);k++) {
        const seen=new Set(), count=choose(n,k);
        for(let rank=0n;rank<count;rank++) {
            const c=combination(n,k,rank); assert.equal(c.length,k);
            assert(c.every((x,i)=>x>=0&&x<n&&(!i||x>c[i-1])));
            seen.add(c.join(':'));
        }
        assert.equal(BigInt(seen.size),count,'combination enumeration covers its whole finite space');
    }
    assert(choose(1781,6)>BigInt(Number.MAX_SAFE_INTEGER),'full-world DD counts do not overflow rank arithmetic');
    const coverage=new RaidRosterCoverage(), healers=Array.from({length:4},(_,i)=>'h'+i), dd=Array.from({length:7},(_,i)=>'d'+i);
    const combos=new Set();
    for(let i=0;i<2*6*7;i++) combos.add(coverage.members(1,0,healers,dd).slice().sort().join(':'));
    assert.equal(combos.size,42,'systematic turns cover every healer-pair/DD-six combination despite exploratory turns');
    const deferredPool=[member(101,32,28,3),member(102,42,28,178,true),member(103,29,28,178,true),
        ...Array.from({length:6},(_,i)=>member(104+i,56,28,168))];
    const queuedIds=deferredPool.map(s=>s.characterId);
    const preserved=await Work.run(Policy.candidateSteps(deferredPool,new Map(),0,at,new RaidRosterCoverage(),[queuedIds]));
    assert.deepEqual(preserved.proposals[0].map(s=>s.characterId).sort((a,b)=>a-b),[...queuedIds].sort((a,b)=>a-b));
    delete deferredPool[0].inventory[625];
    const stale=await Work.run(Policy.candidateSteps(deferredPool,new Map(),0,at,new RaidRosterCoverage(),[queuedIds]));
    assert.equal(stale.proposals.length,0,'a queued tank whose shield disappeared is not reused from an old snapshot');
    const allDD=Array.from({length:180},(_,i)=>i), covered=new Set();
    for(let i=0;i<=2*Math.ceil(allDD.length/6);i++) for(const d of coverage.members(2,0,['a','b'],allDD).slice(2))covered.add(d);
    assert.equal(covered.size,180,'exploration reaches every DD, including everyone outside the former top 112');
    assert.equal(new Set(Array.from({length:8},()=>coverage.window(77,()=>true))).size,8,
        'each tank gets every level window independently of the global tank-cycle length');
    assert.deepEqual(WINDOWS.slice(0,3),[0,3,7],'proven windows retain first priority');
    const sparse=coverage.window(78,u=>u===2);assert.equal(sparse,2);
    for(let i=0;i<20;i++) {
        const c=coverage.members(1,0,healers.slice(0,2),Array.from({length:8},(_,j)=>j));
        assert.equal(new Set(c).size,8,'changed role-pool sizes retain valid ranks');
    }
    const pool=[member(1,32,28,3),member(2,42,28,178,true),member(3,29,28,178,true),
        ...Array.from({length:7},(_,i)=>member(4+i,56,28,168))];
    const poor=pool.find(s=>s.characterId===9);poor.adena=1;poor.stats.money=[0,0,0,0];poor.inventory[1463].amount=1;
    const spot=invoke('GameServer/RaidBoss/RaidBossSourceCatalog').findById('raid:10366');
    const old=Policy.rosters(pool,neutral,at);
    assert(old.length && old.every(r=>Policy.assessment(r,spot,{timestamp:at,fundSupplies:true}).reason==='raid_consumables_funds'),
        'the frozen greedy choice repeatedly includes the stronger-ranked unfunded DD');
    const progressing=new RaidRosterCoverage(), counters=new RaidSearchCounters();let found=false;
    for(let turn=0;turn<6;turn++) {
        counters.begin(at+turn*60000);
        const planned=await Work.run(Policy.candidateSteps(pool,new Map(),0,at,progressing));
        assert(planned.candidates.length<=72);assert(planned.proposals.length<=8);
        planned.proposals.forEach(r=>counters.roster(r));
        const rosters=await Work.run(Policy.proposalSteps(planned.proposals,planned.candidates,neutral,at,counters));
        for(const r of rosters) if(Policy.assessment(r,spot,{timestamp:at,fundSupplies:true}).ready)found=true;
        counters.finish();assert(counters.last.socialChecks<=288);
    }
    assert(found,'a real unchanged combat forecast accepts an alternative funded nine the greedy search missed');
    counters.begin(at);const proposed=await Work.run(Policy.candidateSteps(pool,new Map(),0,at,new RaidRosterCoverage()));
    const rejected=await Work.run(Policy.proposalSteps(proposed.proposals,proposed.candidates,()=>({ready:false}),at,counters));
    assert.equal(rejected.length,0);assert.equal(counters.last.rejections.assembly.raid_social_conflict,proposed.proposals.length);
    counters.reject('forecast','raid_healing_mana');counters.reject('forecast','raid_healing_mana');
    const report=counters.snapshot();assert.equal(report.rejections.forecast.raid_healing_mana,2);
    report.total.searches=0;assert(counters.total.searches>0,'observer snapshots cannot mutate counters');
    for(let i=0;i<2200;i++)counters.roster([{characterId:10000+i}]);
    assert.equal(counters.snapshot().recentDistinctRosters,2048,'distinct history has a fixed memory bound');
    assert.equal(LIMITS.forecasts,12);
    console.log('Full-pool raid coverage, missed funded roster, level-window fairness and bounded counters passed');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
