const assert = require('node:assert/strict');
const { createTrialWorld, abort, Service, DataCache, withRandom } = require('./helpers/secondProfessionHarness');
const { reloadActor } = require('./helpers/fighterProfessionHarness');
const Dialogue = require('./helpers/npcDialogueHarness');
const Response = invoke('GameServer/Network/Response');

// Authored C4 acceptance levels, eligible examples and initial issued items.
const STARTS = [
    [211,7644,35,1,0,[]], [212,7109,35,4,0,[]], [213,7106,35,7,0,[2647]],
    [214,7461,35,11,0,[2675]], [215,7648,35,15,0,[2723]], [216,7103,35,54,4,[3120]],
    [217,7191,37,1,0,[1558,1556]], [218,7460,37,19,1,[3141]], [219,7476,37,32,2,[3173]],
    [220,7514,37,45,3,[3204]], [221,7104,37,54,4,[3239]], [222,7623,39,1,0,[2763,2764,2765,2766,2767]],
    [223,7624,39,1,0,[3277]], [224,7702,39,7,0,[3294]], [225,7690,39,7,0,[2784]],
    [226,7473,39,15,0,[2810]], [227,7118,39,15,0,[2822]], [228,7629,39,11,0,[2841]],
    [229,7630,39,11,0,[3308]], [230,7634,39,11,0,[3352]], [231,7531,39,56,4,[]],
    [232,7565,39,50,3,[3391]], [233,7510,39,50,3,[]]
];

function journal(packet) {
    assert.equal(packet[0], 0x80);
    const rows = [];
    for (let i = 0; i < packet.readUInt16LE(1); i++) {
        rows.push({ id: packet.readInt32LE(3 + i * 8), condition: packet.readInt32LE(7 + i * 8) });
    }
    return rows;
}
function latestJournal(c) { return journal(c.session.packets.filter(p => p[0] === 0x80).at(-1)); }
function received(session, item) {
    // C4 SystemMessage: one ITEM_ID (type 3), then the earned item id.
    return session.packets.some(p => p[0] === 0x64 && p.length >= 17
        && p.readInt32LE(9) === 3 && p.readInt32LE(13) === item);
}

(async () => {
    const characters = STARTS.map(([q,,level,classId,race]) => ({id:193000+q,level:level-1,classId,race}));
    const c = await createTrialWorld('profession-content-audit', characters[0].id, characters.slice(1), characters[0]);
    try {
        const quests = Service.quests().filter(q => q.id >= 211 && q.id <= 233);
        assert.deepEqual(quests.map(q => q.id).sort((a,b) => a-b), STARTS.map(r => r[0]));
        const spawned = new Set(DataCache.npcSpawns.flatMap(g => g.spawns.filter(s => s.total > 0).map(s => s.selfId)));
        for (const q of quests) {
            for (const id of new Set([...q.npcs, ...q.killNpcs, ...(q.questSpawns || [])])) {
                assert(DataCache.npcs.some(n => n.selfId === id), `Q${q.id}: NPC ${id} template`);
                assert(spawned.has(id) || q.questSpawns?.includes(id), `Q${q.id}: NPC ${id} has a world or quest spawn`);
            }
            for (const id of q.questItems) assert(DataCache.items.some(i => i.selfId === id), `Q${q.id}: item ${id}`);
        }
        for (const [q,npc,level,,,items] of STARTS) {
            c.id = 193000+q; c.session = await c.world.session(c.id);
            await Dialogue.talk(c.session, c.world, npc);
            assert(!c.world.page(c.session).includes(`quest ${q} start`), `Q${q}: no premature acceptance link`);
            assert.equal(await c.event(q,'start',npc), false);
            await c.level(level);
            if (q === 216) await Service.giveItem(c.session,57,2000);
            c.session.packets.length = 0;
            await c.click(q,'start',npc);
            assert.deepEqual(latestJournal(c), [{id:q,condition:1}]);
            assert.equal(c.state(q).state,'started');
            for (const item of items) {
                assert.equal(await c.amount(item),1,`Q${q}: initial item ${item}`);
                assert(received(c.session,item),`Q${q}: item ${item} receipt reaches client`);
            }
            if (q === 216) assert.equal(await c.amount(57),0,'Valkon collects the exact fee');
            await c.reopen();
            assert.equal(c.state(q).state,'started');
            for (const item of items) assert.equal(await c.amount(item),1);
            await abort(c.session,q);
            assert.deepEqual(latestJournal(c),[]);
            for (const item of c.state(q).quest.questItems) assert.equal(await c.amount(item),0);
        }
        // Source cond stays 1 throughout these item-driven quests, regardless
        // of the more detailed persisted server phase. No save migration.
        c.id = 193228; c.session = await c.world.session(c.id);
        for (const [q,max] of [[213,14],[214,25],[218,18],[219,15],[221,6],[224,12],[225,22]]) {
            const state = Service.stateFor(c.session,quests.find(entry => entry.id === q));
            state.state = 'started';
            for (let cond = 1; cond <= max; cond++) {
                state.variables.cond = String(cond);
                const rows = journal(Response.questList(Service.active(c.session)));
                assert.equal(rows.find(r => r.id === q).condition,1,`Q${q}: C4 journal cond remains 1`);
                assert.equal(state.getInt('cond'),cond,'internal progress is preserved');
            }
            state.state = 'created';
        }
        // Magus drops travel through ReceivedHit -> Die -> NpcDied, not a
        // direct call to the quest. The third seed updates the journal to 5.
        await c.level(39); await c.click(228,'start',7629);
        await c.click(228,'handin',7391); assert.equal(latestJournal(c)[0].condition,2);
        await c.click(228,'handin',7612); assert.equal(latestJournal(c)[0].condition,3);
        assert.match(c.world.page(c.session),/Fellmere Lake.*Ivory Tower.*Giran/);
        await reloadActor(c); c.runtime.user.sessions = [c.session];
        const Npc = invoke('GameServer/Npc/Npc');
        for (const template of [5095,5096,5097]) {
            const data = DataCache.npcs.find(n => n.selfId === template);
            const npc = new Npc(c.runtime.npc.nextId++, {...utils.crushOb(data),locX:0,locY:0,locZ:0,head:0});
            c.runtime.npc.spawns.push(npc);
            await withRandom([0], async () => {
                invoke('GameServer/Npc/Generics/ReceivedHit')(c.session,c.session.actor,npc,npc.fetchHp()+1);
                await Dialogue.settle(c.session); await npc.soulCrystalReward;
            });
            assert(npc.isDead());
            assert.equal(await c.amount(template-2251),1);
            assert(received(c.session,template-2251));
        }
        assert.equal(c.cond(228),3); assert.equal(latestJournal(c)[0].condition,5);
        await c.click(228,'handin',7629); assert.equal(latestJournal(c)[0].condition,6);
        await c.click(228,'handin',7413); assert.equal(latestJournal(c)[0].condition,7);
        await c.reopen(); assert.equal(c.cond(228),4);
        assert.deepEqual(Service.active(c.session),[{id:228,condition:7}]);
        // Witchcraft's independent tools share one server phase. The journal
        // advances to the Evert phase only when both tools are present.
        const witch = Service.stateFor(c.session,quests.find(q => q.id === 229));
        witch.state = 'started';
        for (const [cond,expected] of [[1,1],[2,2],[3,4],[4,5],[5,6],[6,9],[7,10]]) {
            witch.variables.cond = String(cond);
            assert.equal(journal(Response.questList(Service.active(c.session))).find(q => q.id === 229).condition,expected);
        }
        witch.variables.cond = '5';
        for (const item of [3029,3331,3332]) await Service.giveItem(c.session,item,1);
        assert.equal(journal(Response.questList(Service.active(c.session))).find(q => q.id === 229).condition,8);
        console.log('All 23 profession trials: NPC acceptance, exact issued items and receipts, persisted state, abort cleanup, spawn/template coverage, C4 journal phases and real monster-death drops passed');
    } finally { await c.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
