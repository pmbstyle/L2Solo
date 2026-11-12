'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
require('../src/Global');
const Geodata = require('../src/GameServer/Geodata/GeodataEngine');
const Protocol = require('../src/GameServer/Bot/Population/ColdSimulationProtocol');
const Calculation = require('../src/GameServer/Bot/Population/PartyGoalCalculation');
const timestamp = Date.now();
const epoch = 'party-goal-native';
const members = [701, 702].map(characterId => ({ characterId, phase: 'cold', updatedAt: timestamp,
    level: 20, activity: 'resting', adena: 10000, inventory: {},
    // Crafters (a learned Create Item level): their goal query asks the
    // occupation planner with the query's own recipe knowledge.
    spotId: 'execution-ground', stats: { classId: 0, dwarvenCraftLevel: 1 }, timing: { nextResolveAt: timestamp + 3600000 },
    simulation: { revision: 2 },
    vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 } }));
const party = { partyId: 'goal-worker', memberIds: [701, 702], leaderId: 701,
    stats: { objective: { clanGoalKey: 'clan-native', spotId: 'protected' } } };
const observer = String.raw`
const assert=require('node:assert/strict');
Config.staticShotsDisabled=true;
parentPort.on('message',message=>{
    if(!message.queryProbe)return;
    if(message.queryProbe==='refuse-goal-answer') {
        const real=Protocol.validateEnvelope;
        Protocol.validateEnvelope=(m,...rest)=>{
            if(m.type==='party_goal_result'&&m.payload.ok){Protocol.validateEnvelope=real;return {ok:false,reason:'forced_refusal',bytes:0};}
            return real(m,...rest);
        };
    }
    if(message.queryProbe==='enable-static-shots') Config.staticShotsDisabled=false;
    if(message.queryProbe==='hold-meeting'||message.queryProbe==='hold-page') {
        const mode=message.queryProbe==='hold-meeting'?'meeting':'page';
        const held={id:701,mode,input:{mode,state:kernel.states.get(701).state}};
        occupationPlanner.waiting.set(occupationPlanner.keyOf(701,mode),held);
        module.exports.heldMeeting=held;
    }
    if(message.queryProbe==='release-meeting'||message.queryProbe==='release-page') {
        const key=occupationPlanner.keyOf(701,module.exports.heldMeeting.mode);
        assert.strictEqual(occupationPlanner.waiting.get(key),module.exports.heldMeeting);
        occupationPlanner.waiting.delete(key);
    }
    if(message.queryProbe==='hold-lifecycle') {
        kernel.commanding.add(701);kernel.commandStartedAt.set(701,{kind:'lifecycle'});
    }
    if(message.queryProbe==='release-lifecycle') {
        kernel.commanding.delete(701);kernel.commandStartedAt.delete(701);
    }
    parentPort.postMessage({probe:message.queryProbe,slots:[...occupationPlanner.slots.values(),...occupationPlanner.cards.values()].map(entry=>({
        id:entry.id,mode:entry.mode,recipeBook:entry.input.recipeBook,knownShotRecipes:entry.input.knownShotRecipes,
        canonical:entry.input.state===kernel.states.get(entry.id)?.state}))});
});`;
const wrapper = String.raw`
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const {parentPort,workerData}=require('node:worker_threads');
const loaded=new Module(workerData.workerPath,module);loaded.filename=workerData.workerPath;
loaded.paths=Module._nodeModulePaths(path.dirname(workerData.workerPath));
loaded._compile(fs.readFileSync(workerData.workerPath,'utf8')+workerData.observer,workerData.workerPath);`;
const worker = new Worker(wrapper, { eval: true,
    workerData: { sharedGeodata: Geodata.sharedDescriptor(), workerEpoch: epoch, observer, workerPath: path.resolve(__dirname, '../src/GameServer/Bot/Population/ColdSimulationWorker.js') },
    resourceLimits: { maxOldGenerationSizeMb: 256 } });
const messages = []; let fault;
worker.on('message', message => messages.push(message)); worker.on('error', error => { fault = error; });
async function wait(predicate) {
    const deadline = Date.now() + 12000;
    while (!messages.some(predicate)) {
        if (fault) throw fault;
        if (Date.now() > deadline) throw Error('party goal native reply timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    return messages.find(predicate);
}
function post(type, payload, id) {
    const message = Protocol.envelope(type, epoch, payload, id);
    if (id?.startsWith('raid-')) assert(Protocol.validateEnvelope(message,'main').ok,
        JSON.stringify(Protocol.validateEnvelope(message,'main')));
    worker.postMessage(message);
}
(async () => {
    await wait(message => message.type === 'ready' && message.payload.phase === 'loaded');
    post('init', { config: { pvpAggression: 0 } }, 'init');
    await wait(message => message.type === 'ready' && message.payload.phase === 'running');
    post('pause', {}, 'pause');
    post('snapshot_page', { rows: members.map(state => ({ state })),
        initial: true, done: true, ack: true }, 'snapshot');
    await wait(message => message.msgId === 'snapshot');
    const request = { party, members, escrows: [0, 0], timestamp, replyBy: Date.now() + 5000 };
    post('party_goal_request', request, 'goals');
    const response = await wait(message => message.type === 'party_goal_result' && message.msgId === 'goals');
    assert.equal(response.payload.ok, true, response.payload.reason);
    assert.deepEqual(response.payload.joint.objective, party.stats.objective);
    assert.equal(response.payload.joint.memberGoals.length, 2);
    assert.deepEqual(response.payload.sources, Calculation.sources(members));
    assert(!messages.some(message => message.type === 'fault'), 'native worker loads no forbidden dependency');
    const materialMembers = members.map((member, index) => ({ ...member, updatedAt: timestamp + 1,
        stats: { ...member.stats, equipmentPlan: { target: { selfId: 5726 + index } },
            partyRequest: { materialParty: true, status: 'open', reason: 'craft_material', spotId: 'material-camp',
                npcId: 600 + index, itemId: 4097 + index, amount: 12, requiredTotal: 12, targetId: 5726 + index } } }));
    const materialObjective = materialMembers[0].stats.partyRequest;
    const materialAgreement = require('../src/GameServer/Bot/Population/CraftMaterialParty').agreement(materialMembers, materialObjective);
    post('party_goal_request', { ...request, members: materialMembers, party: { ...party, startedAt: timestamp,
        stats: { objective: materialObjective, agreement: materialAgreement } }, replyBy: Date.now() + 5000 }, 'material-goals');
    const materialReply = await wait(message => message.type === 'party_goal_result' && message.msgId === 'material-goals');
    assert.equal(materialReply.payload.ok, true, materialReply.payload.reason);
    assert.equal(materialReply.payload.joint.memberGoals.filter(goal => goal.amount === 12).length, 2);
    assert(Protocol.validateEnvelope(materialReply, 'worker').ok, 'native material goal advice crosses the worker boundary');
    // The forming verdict of a roster before main builds its party: the accepted ids only.
    const forming = (id, roster, requested) => post('party_goal_request', { ...request, members: roster,
        party: { partyId: `forming-${id}`, leaderId: roster[0].characterId, memberIds: roster.map(member => member.characterId),
            stats: { forming: { requested } } }, replyBy: Date.now() + 5000 }, id);
    const verdict = async id => {
        const reply = await wait(message => message.type === 'party_goal_result' && message.msgId === id);
        assert.equal(reply.payload.ok, true, reply.payload.reason);
        assert(Protocol.validateEnvelope(reply, 'worker').ok, 'a forming verdict crosses the worker boundary');
        assert.equal(reply.payload.joint.memberGoals, undefined, 'a verdict builds no goals');
        return reply.payload.joint;
    };
    forming('material-admission', materialMembers, materialObjective);
    const admission = await verdict('material-admission');
    assert.deepEqual(admission.formingAccepted, [], 'a missing camp forecast refuses unsafe formation in the worker');
    worker.postMessage({ queryProbe: 'canonical' });
    const prepared = await wait(message => message.probe === 'canonical');
    assert.equal(prepared.slots.filter(row => row.mode !== 'wish').length, 0,
        'a party goal asks no workshop: each member\'s held answer is read');
    // A crafter at its station that requires the party joins without weighing income.
    const required = { status: 'open', priority: 'required', spotId: 'execution-ground', requestedAt: timestamp };
    const stationed = (member, at) => ({ ...member, updatedAt: timestamp + at,
        stats: { ...member.stats, craftStationId: 1, partyRequest: required } });
    forming('all-accept', [stationed(members[0], 2), stationed(members[1], 2)], required);
    assert.deepEqual((await verdict('all-accept')).formingAccepted, [701, 702]);
    // An adventurer without a forecast of the spot declines; the reply names the one who joins.
    forming('decliner', [stationed(members[0], 3), { ...members[1], updatedAt: timestamp + 3 }], required);
    assert.deepEqual((await verdict('decliner')).formingAccepted, [701]);
    // T43 table: '-10_10' is gone; '-5_10' is a level-14 spot with rows for every role.
    const incomeSpot = { id: '-5_10', minLevel: 14, maxLevel: 14, avgLevel: 14, density: 20,
        tagsAuthoritative: true, tags: ['starter', 'normal_hp'], npcEntries: [], center: { locX: 0, locY: 0 } };
    post('catalog_page', { catalog: 'spots', rows: [incomeSpot], done: true }, 'income-spots');
    const incomeMembers = members.map(member => ({ ...member, spotId: incomeSpot.id, updatedAt: timestamp + 10 }));
    post('party_goal_request', { ...request, members: incomeMembers, party: { ...party, spotId: incomeSpot.id,
        startedAt: timestamp - 600000, stats: { objective: { spotId: incomeSpot.id } } },
        replyBy: Date.now() + 5000 }, 'income');
    const income = await wait(message => message.type === 'party_goal_result' && message.msgId === 'income');
    assert.equal(income.payload.ok, true, income.payload.reason);
    assert(Protocol.validateEnvelope(income, 'worker').ok, 'native worker income packet is admitted on main');
    const changed = structuredClone(members); changed[0].updatedAt++; changed[0].stats.partyRequest = { spotId: 'fresh-request' };
    post('party_goal_request', { ...request, members: changed, replyBy: Date.now() + 5000 }, 'changed');
    const fresh = await wait(message => message.type === 'party_goal_result' && message.msgId === 'changed');
    assert.equal(fresh.payload.ok, true, fresh.payload.reason);
    assert.equal(fresh.payload.joint.memberGoals[0].spotId, 'fresh-request', 'complete new input supersedes old mirror');
    assert.deepEqual(fresh.payload.sources, Calculation.sources(changed));
    worker.postMessage({ queryProbe: 'private-release' });
    const released = await wait(message => message.probe === 'private-release');
    assert(released.slots.every(row => row.mode === 'wish' || row.canonical), 'no completed planner slot retains a private query snapshot');
    worker.postMessage({queryProbe:'hold-meeting'});
    await wait(message=>message.probe==='hold-meeting');
    post('party_goal_request',{...request,replyBy:Date.now()+5000},'during-meeting');
    const blocked=await wait(message=>message.type==='party_goal_result'&&message.msgId==='during-meeting');
    assert.equal(blocked.payload.reason,'party_goal_member_busy','party advice cannot cancel native trade preparation');
    worker.postMessage({queryProbe:'release-meeting'});
    await wait(message=>message.probe==='release-meeting');
    worker.postMessage({queryProbe:'hold-page'});
    await wait(message=>message.probe==='hold-page');
    post('party_goal_request',{...request,replyBy:Date.now()+5000},'during-refresh');
    const refresh=await wait(message=>message.type==='party_goal_result'&&message.msgId==='during-refresh');
    assert.equal(refresh.payload.reason,'party_goal_member_busy','party advice cannot drop a pending plan page');
    worker.postMessage({queryProbe:'release-page'});
    await wait(message=>message.probe==='release-page');
    worker.postMessage({queryProbe:'hold-lifecycle'});
    await wait(message=>message.probe==='hold-lifecycle');
    post('party_goal_request',{...request,replyBy:Date.now()+5000},'during-lifecycle');
    const lifecycle=await wait(message=>message.type==='party_goal_result'&&message.msgId==='during-lifecycle');
    assert.equal(lifecycle.payload.ok,true,'a lifecycle command waiting for main review may request party advice');
    worker.postMessage({queryProbe:'release-lifecycle'});
    await wait(message=>message.probe==='release-lifecycle');
    const page = (pageIndex, id, replyBy = Date.now() + 5000) => post('party_goal_request', {
        ...(pageIndex === 0 ? { party } : { partyId: party.partyId }), members: [members[pageIndex]], escrows: [0],
        timestamp, replyBy, pageIndex, pageCount: 2 }, id);
    const pageDeadline = Date.now() + 5000;
    page(0, 'paged', pageDeadline); page(1, 'paged', pageDeadline);
    const paged = await wait(message => message.type === 'party_goal_result' && message.msgId === 'paged');
    assert.equal(paged.payload.ok, true, paged.payload.reason);
    assert.deepEqual(paged.payload.sources, Calculation.sources(members));
    page(1, 'out-of-order');
    const disordered = await wait(message => message.type === 'party_goal_result' && message.msgId === 'out-of-order');
    assert.equal(disordered.payload.reason, 'party_goal_page_order');
    page(0, 'missing-page', Date.now() + 100);
    const missing = await wait(message => message.type === 'party_goal_result' && message.msgId === 'missing-page');
    assert.equal(missing.payload.reason, 'party_goal_expired');
    page(0, 'duplicate-page', pageDeadline); page(0, 'duplicate-page', pageDeadline);
    const duplicate = await wait(message => message.type === 'party_goal_result' && message.msgId === 'duplicate-page');
    assert.equal(duplicate.payload.ok, false); assert.equal(duplicate.payload.reason, 'party_goal_page_changed');
    const slotDeadline = Date.now() + 200;
    page(0, 'slot-a', slotDeadline); page(0, 'slot-b', slotDeadline); page(0, 'slot-c', slotDeadline);
    const busy = await wait(message => message.type === 'party_goal_result' && message.msgId === 'slot-c');
    assert.equal(busy.payload.reason, 'party_goal_busy', 'partial assemblies share the same admission bound');
    await wait(message => message.type === 'party_goal_result' && message.msgId === 'slot-a');
    await wait(message => message.type === 'party_goal_result' && message.msgId === 'slot-b');
    const nine = Array.from({ length: 9 }, (_, i) => ({ ...members[0], characterId: 710 + i,
        stats: { ...members[0].stats, transportFixture: 'x'.repeat(140000) } }));
    const largeParty = { ...party, leaderId: 710, memberIds: nine.map(member => member.characterId) };
    const largeDeadline = Date.now() + 5000;
    for (let i = 0; i < nine.length; i++) post('party_goal_request', {
        ...(i === 0 ? { party: largeParty } : { partyId: largeParty.partyId }),
        members: [nine[i]], escrows: [0], timestamp, replyBy: largeDeadline, pageIndex: i, pageCount: 9 }, 'nine');
    const largest = await wait(message => message.type === 'party_goal_result' && message.msgId === 'nine');
    assert.equal(largest.payload.ok, true, largest.payload.reason);
    assert.equal(largest.payload.joint.memberGoals.length, 9, 'complete maximum roster survives multiple pages');
    invoke('GameServer/DataCache').init({ validate: false });
    const Combat = invoke('GameServer/Bot/Population/ColdCombatProfile');
    const frozen = require('./fixtures/raid_priority_world.json');
    const raiders = frozen.expected.map(id => {
        const row = frozen.members.find(s => s.characterId === id);
        return { ...row, level: id === 2006587 ? 50 : row.level, phase: 'cold', updatedAt: timestamp,
            activity: 'shopping', currentRegion: 'Giran', party: {},
            stats: { ...row.stats, coldCombat: { ...row.captured,
                skills: Combat.skillSnapshotsFromRecords(row.skills.map(([selfId, level]) => ({ selfId, level }))) } },
            inventory: Object.fromEntries(row.items.map(item => [item.selfId,
                [1463,1464].includes(item.selfId) ? { ...item, amount: 0 } : item])) };
    });
    const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
    const shops = [1463,1464].map((selfId, i) => ({ id: 960000 + i, ownerId: 970000 + i,
        storeType: 1, kind: 'shop', custodyPolicy: 0, town: 'Giran', revision: 1,
        lines: [{ lineId: 980000 + i, selfId, count: 1000000, price: 1 }] }));
    const marketPage = (rows, revision, from = null) => post('table_page', { tables: [{ name: 'board', from,
        to: revision, full: from === null, removed: [], last: true, rows: rows.map(s => [s.id, rowOf(s)]) }] }, `raid-book-${revision}`);
    marketPage(shops, 1);
    const raidParty = { partyId: 'market-raid-worker', leaderId: raiders[0].characterId,
        memberIds: raiders.map(s => s.characterId), stats: { objective: {
            sourceKind: 'raid', opportunisticRaid: true, spotId: `raid:${frozen.bossId}`, fundRaidSupplies: true } } };
    const raidReply = async id => {
        const replyBy = Date.now() + 5000;
        for (let i = 0; i < raiders.length; i++) post('party_goal_request', {
            ...(i === 0 ? { party: raidParty } : { partyId: raidParty.partyId }), members: [raiders[i]], escrows: [0],
            timestamp: frozen.at, replyBy, pageIndex: i, pageCount: 9 }, id);
        const reply = await wait(m => m.type === 'party_goal_result' && m.msgId === id);
        assert(reply.payload.ok, reply.payload.reason);
        assert(Protocol.validateEnvelope(reply, 'worker').ok);
        return reply.payload.joint.raidAssessment;
    };
    const fundedRaid = await raidReply('raid-backed');
    assert(fundedRaid.ready, JSON.stringify(fundedRaid.reasons));
    assert(fundedRaid.supplies.some(s => s.missing > 0 && s.available === s.missing && s.price === 1));
    raidParty.stats.objective.raidCandidateIds = [10099, 10431];
    raidParty.stats.objective.maxFightSeconds = fundedRaid.seconds - 1;
    const selectedRaid = await raidReply('raid-select-target');
    assert(selectedRaid.ready, JSON.stringify(selectedRaid.reasons));
    assert.equal(selectedRaid.targetSelection.bossId, 10431);
    assert.equal(selectedRaid.targetSelection.considered, 2);
    assert.equal(selectedRaid.targetSelection.rejected.raid_fight_too_long, 1);
    const selectedPayload = { ok:true, joint:{objective:raidParty.stats.objective,raidAssessment:selectedRaid,
        memberGoals:raiders.map(s => ({ characterId:s.characterId }))},
        sources:Calculation.sources(raiders) };
    assert(Protocol.validateEnvelope(Protocol.envelope('party_goal_result',epoch,selectedPayload),'worker').ok);
    const invalidTarget = structuredClone(selectedPayload); invalidTarget.joint.raidAssessment.targetSelection.bossId = 999999;
    assert(!Protocol.validateEnvelope(Protocol.envelope('party_goal_result',epoch,invalidTarget),'worker').ok);
    const invalidCount = structuredClone(selectedPayload); invalidCount.joint.raidAssessment.targetSelection.considered = 10000;
    assert(!Protocol.validateEnvelope(Protocol.envelope('party_goal_result',epoch,invalidCount),'worker').ok);
    raidParty.stats.objective.maxFightSeconds = 1;
    const slowRaid = await raidReply('raid-all-too-slow');
    assert.equal(slowRaid.targetSelection.fullForecast, false);
    assert.equal(slowRaid.reason, 'raid_no_fast_target');
    delete raidParty.stats.objective.raidCandidateIds;
    delete raidParty.stats.objective.maxFightSeconds;
    marketPage(shops.map(s => ({ ...s, revision: 2, custodyPolicy: 1, kind: 'sell_ad' })), 2, 1);
    const advertisedRaid = await raidReply('raid-conditional');
    assert(advertisedRaid.reasons.includes('raid_supplies_unavailable'),
        'the real simulation worker reads current backed supply and refuses conditional ads');
    worker.postMessage({ queryProbe:'enable-static-shots' });
    await wait(message => message.probe==='enable-static-shots');
    const fallbackRaid = await raidReply('raid-static-fallback');
    assert(fallbackRaid.ready, JSON.stringify(fallbackRaid.reasons));
    assert(fallbackRaid.supplies.filter(s => s.missing > 0).every(s =>
        s.available === s.missing && s.price > 1 && s.cost <= s.cash),
        'the real worker funds the expensive configured fallback without treating conditional ads as stock');
    marketPage(shops.map(s => ({ ...s, revision:3, lines:s.lines.map(l => ({...l,count:100})) })),3,2);
    const mixedRaid = await raidReply('raid-mixed-fallback');
    assert(mixedRaid.ready, JSON.stringify(mixedRaid.reasons));
    assert(mixedRaid.supplies.some(s => s.missing > 100 && s.cost < s.missing * s.price),
        'a cheaper backed stack is used before the configured remainder');
    const mixedSupply=mixedRaid.supplies.find(s => s.reserveCost>s.cost+1);
    assert(mixedSupply,'the worker transports the fallback budget separately from the cheap quote');
    const dd=raiders.find(s=>s.characterId===mixedSupply.id),walletBefore=dd.adena,moneyBefore=dd.stats.money;
    dd.adena=Math.ceil(mixedSupply.cost)+1;dd.stats.money=[dd.adena,0,0,0];
    const underfunded=await raidReply('raid-unaffordable-reserve');
    assert(underfunded.reasons.includes('raid_consumables_funds'),
        'a cheap fill never hides an unaffordable backup across the real worker boundary');
    dd.adena=walletBefore;
    if(moneyBefore===undefined)delete dd.stats.money;else dd.stats.money=moneyBefore;
    const invalidReserve=structuredClone(selectedPayload);
    invalidReserve.joint.raidAssessment.supplies[0].reserveCost=invalidReserve.joint.raidAssessment.supplies[0].cash+1;
    assert(!Protocol.validateEnvelope(Protocol.envelope('party_goal_result',epoch,invalidReserve),'worker').ok,
        'ready advice cannot authorize an unfunded static reserve');
    // An answer the worker's own validator refuses is answered as a refusal at once: main waits on it.
    worker.postMessage({ queryProbe: 'refuse-goal-answer' });
    post('party_goal_request', { ...request, replyBy: Date.now() + 5000 }, 'refused');
    const refused = await wait(message => message.type === 'party_goal_result' && message.msgId === 'refused');
    assert.deepEqual(refused.payload, { ok: false, reason: 'party_goal_result_refused' });
    post('party_goal_request', { ...request, replyBy: timestamp }, 'expired');
    const expired = await wait(message => message.type === 'party_goal_result' && message.msgId === 'expired');
    assert.equal(expired.payload.ok, false);
    console.log('PASS native 256MiB worker: complete source replacement, protected goal, expired request; wire bytes',
        Protocol.byteLength(Protocol.envelope('party_goal_request', epoch, request)), Protocol.byteLength(response));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => worker.terminate());
