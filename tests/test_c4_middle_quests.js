// 导入的 20-30 级任务运行时测试: 298/326/327/328/330/333/369/370/380.
// 声明式 298/326/328/369/370/380 与模块 327/330/333 的真实交易流程.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
require('../src/Global');
const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Backpack = invoke('GameServer/Actor/Backpack');
const Service = invoke('GameServer/Quest/QuestService');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-c4-middle-'));
options.default.Database.path = path.join(directory, 'test.sqlite');
process.env.L2NODE_PROGRESSION_RATE = 'x1';
Object.assign(options.default.General, { questExpRate: 1, questSpRate: 1, questAdenaRate: 1 });

async function sessionFor(id) {
    const [row] = await Database.execute(['SELECT * FROM characters WHERE id = ?', [id]]);
    const actor = { ...row, fetchId: () => id, fetchName: () => `Quest${id}`, fetchClanId: () => 0,
        fetchLevel() { return this.level; }, fetchRace() { return this.race; }, fetchClassId() { return this.classId; },
        fetchExp() { return this.exp; }, fetchSp() { return this.sp; }, setExpSp(exp, sp) { this.exp = exp; this.sp = sp; },
        backpack: new Backpack({ items: await Database.fetchItems(id), paperdoll: {} }) };
    const session = { actor, dataSendToMe() {} };
    await Service.ensureLoaded(session);
    return session;
}
const amount = async (id, item) => (await Database.fetchItems(id)).filter(i => i.selfId === item).reduce((sum, i) => sum + i.amount, 0);
async function give(id, item, count) {
    const s = await sessionFor(id);
    await Service.giveItem(s, item, count);
    return s;
}

async function main() {
    DataCache.init();
    const seed = new DatabaseSync(options.default.Database.path);
    seed.exec(fs.readFileSync(path.resolve(__dirname, '../database/sql/sqlite.sql'), 'utf8'));
    seed.exec("INSERT INTO accounts(username,password) VALUES ('quests','test')");
    const ids = [298, 326, 327, 328, 330, 333, 369, 370, 380];
    for (const id of ids) seed.prepare(`INSERT INTO characters(id,username,name,classId,race,level,exp,sp,maxHp,maxMp,hp,mp,sex,face,hair,hairColor,locX,locY,locZ)
        VALUES (?, 'quests', ?, 0, 0, 30, ?, 0, 187, 74, 187, 74, 0, 0, 0, 0, 0, 0, 0)`).run(id, `Quest${id}`, DataCache.experience[29]);
    seed.close();
    Database.init();
    const random = Math.random;
    const rig = (roll) => { Math.random = () => roll; };

    // ---- 298 蜥蜴人阴谋: 报告交付, 双 50 收集, 42000 经验值奖励 ----
    {
        let s = await sessionFor(298);
        s.activeNpcTalk = { selfId: 7333, objectId: 1 };
        await Service.onEvent(s, { questId: 298, name: 'start' });
        assert.equal((await sessionFor(298)).questStates.get(298).getInt('cond'), 1);
        assert.equal(await amount(298, 7182), 1);
        s = await sessionFor(298);
        const quest = Service.quests().find(q => q.id === 298);
        s.activeNpcTalk = { selfId: 7344, objectId: 1 };
        await quest.onTalk(s.questStates.get(298), { fetchSelfId: () => 7344 });
        assert.equal((await sessionFor(298)).questStates.get(298).getInt('cond'), 2, 'report delivered at Magister Valiel');
        let state = (await sessionFor(298)).questStates.get(298);
        rig(0.5);
        for (let n = 0; n < 50; n++) await quest.onKill(state, { fetchSelfId: () => 922 });
        assert.equal((await sessionFor(298)).questStates.get(298).getInt('cond'), 2, 'one half is not enough');
        for (let n = 0; n < 50; n++) await quest.onKill(state, { fetchSelfId: () => 925 });
        assert.equal((await sessionFor(298)).questStates.get(298).getInt('cond'), 3, 'both gems complete the hunt');
        await quest.onTalk(state, { fetchSelfId: () => 7344 });
        state = (await sessionFor(298)).questStates.get(298);
        assert.equal(state.state, 'completed');
        assert.equal((await sessionFor(298)).actor.sp, 42000, 'the completion pays 42000 sp');
        assert.equal(await amount(298, 7183), 0);
        assert.equal(await amount(298, 7184), 0);
    }

    // ---- 326 消灭残余: talk 付款 + 100 枚黑狮标记 ----
    {
        let s = await sessionFor(326);
        s.activeNpcTalk = { selfId: 7435, objectId: 1 };
        await Service.onEvent(s, { questId: 326, name: 'start' });
        s = await sessionFor(326);
        const quest = Service.quests().find(q => q.id === 326);
        const state = s.questStates.get(326);
        rig(0.1);
        await quest.onKill(state, { fetchSelfId: () => 53 });
        assert.equal(await amount(326, 1359), 1, 'Carrion Worker drops red badges');
        rig(0.999);
        await quest.onKill(state, { fetchSelfId: () => 66 });
        assert.equal(await amount(326, 1361), 0, 'the 25% roll misses');
        s = await give(326, 1359, 99);
        const adena0 = await amount(326, 57);
        await quest.onTalk((await sessionFor(326)).questStates.get(326), { fetchSelfId: () => 7435 });
        assert.equal(await amount(326, 57) - adena0, 6000, '100 red badges at 60');
        assert.equal(await amount(326, 1359), 0);
        assert.equal(await amount(326, 1369), 1, 'a hundred sold badges earns the black lion mark');
    }

    // ---- 328 商业嗅觉: 眼球/水虱/砂囊 以 talk 付款 ----
    {
        let s = await sessionFor(328);
        s.activeNpcTalk = { selfId: 7436, objectId: 1 };
        await Service.onEvent(s, { questId: 328, name: 'start' });
        s = await sessionFor(328);
        const quest = Service.quests().find(q => q.id === 328);
        const state = s.questStates.get(328);
        rig(0.505);
        await quest.onKill(state, { fetchSelfId: () => 55 });
        assert.equal(await amount(328, 1366), 1, 'the 50..51% band yields a shining eye');
        await quest.onTalk(state, { fetchSelfId: () => 7436 });
        assert.equal(await amount(328, 57), 2000, 'the ferryman pays two thousand per eye');
        assert.equal(await amount(328, 1366), 0);
    }

    // ---- 327 收复失地: 击杀令牌, talk 付款, 组装与出售 ----
    {
        let s = await sessionFor(327);
        s.activeNpcTalk = { selfId: 7597, objectId: 1 };
        const quest = Service.quests().find(q => q.id === 327);
        const fresh = await sessionFor(327);
        const page = await quest.onTalk(Service.stateFor(fresh, quest), { fetchSelfId: () => 7597 });
        assert(page.includes('accept'), 'Peter advertises the hire');
        await Service.onEvent(s, { questId: 327, name: 'accept' });
        s = await sessionFor(327);
        const state = s.questStates.get(327);
        assert.equal(state.getInt('cond'), 1);
        rig(0.05);
        await quest.onKill(state, { fetchSelfId: () => 500 });
        assert.equal(await amount(327, 1846), 1, 'the token always falls');
        assert([1848, 1849, 1850, 1851].some(id => state.session.actor.backpack.fetchItems().some(i => i.fetchSelfId() === id)),
            'a fragment accompanies the token on a good roll');
        await give(327, 1846, 3);
        s = await sessionFor(327);
        s.activeNpcTalk = { selfId: 7597, objectId: 1 };
        const adena0 = await amount(327, 57);
        await Service.onEvent(s, { questId: 327, name: 'sellTokens' });
        assert.equal(await amount(327, 57) - adena0, 160, '40 per dogtag');
        await give(327, 1848, 4);
        s = await sessionFor(327);
        s.activeNpcTalk = { selfId: 7313, objectId: 1 };
        rig(0.79);
        await Service.onEvent(s, { questId: 327, name: 'assembleUrn' });
        assert.equal(await amount(327, 1852), 1, 'five urn fragments assemble at 80%');
        await give(327, 1852, 1);
        s = await sessionFor(327);
        s.activeNpcTalk = { selfId: 7034, objectId: 1 };
        const exp0 = s.actor.exp;
        await Service.onEvent(s, { questId: 327, name: 'sellRelics' });
        assert(s.actor.exp > exp0, 'Iris pays experience for relics');
        assert.equal(await amount(327, 1852), 0);
    }

    // ---- 330 味觉大师: 五 ingredients, 等级, 菜式评级 ----
    {
        let s = await sessionFor(330);
        s.activeNpcTalk = { selfId: 7469, objectId: 1 };
        await Service.onEvent(s, { questId: 330, name: 'start' });
        assert.equal(await amount(330, 1420), 1, 'the ingredient list opens the job');
        s = await sessionFor(330);
        const quest = Service.quests().find(q => q.id === 330);
        const state = s.questStates.get(330);
        s.activeNpcTalk = { selfId: 7062, objectId: 1 };
        await quest.onTalk(state, { fetchSelfId: () => 7062 });
        assert.equal(await amount(330, 1421), 1, 'Sonia hands out her botany book');
        s.activeNpcTalk = { selfId: 204, objectId: 1 };
        rig(0.1);
        await quest.onKill(state, { fetchSelfId: () => 204 });
        assert.equal(await amount(330, 1427), 0, 'nectar waits for the insect book');
        await give(330, 1422, 40);
        s = await sessionFor(330);
        s.activeNpcTalk = { selfId: 7062, objectId: 1 };
        await Service.onEvent(s, { questId: 330, name: 'sonia' });
        assert.equal(await amount(330, 1424), 1, 'forty red roots press into red sap');
        for (const id of [1429, 1433, 1437, 1441]) await give(330, id, 1);
        s = await sessionFor(330);
        s.activeNpcTalk = { selfId: 7469, objectId: 1 };
        rig(0.5);
        await quest.onTalk(s.questStates.get(330), { fetchSelfId: () => 7469 });
        assert.equal(await amount(330, 1442), 1, 'no specials cooks the plain dish');
        assert.equal(await amount(330, 1420), 0, 'the list is spent at the stove');
        s = await sessionFor(330);
        await quest.onTalk(s.questStates.get(330), { fetchSelfId: () => 7461 });
        assert.equal(await amount(330, 1447), 1, 'Jonas trades the dish for a review');
        s.activeNpcTalk = { selfId: 7469, objectId: 1 };
        const adena0 = await amount(330, 57);
        await quest.onTalk(s.questStates.get(330), { fetchSelfId: () => 7469 });
        assert.equal(await amount(330, 57) - adena0, 7500, 'the first review pays 7500');
        assert.equal((await sessionFor(330)).questStates.get(330).state, 'created', 'the review closes the quest');
    }

    // ---- 333 黑狮狩猎: 标记, 任务, 战利, 爪子/眼睛, 开箱, 雕像与石板 ----
    {
        await give(333, 1369, 1);
        await give(333, 57, 200000);
        let s = await sessionFor(333);
        s.activeNpcTalk = { selfId: 7735, objectId: 1 };
        const quest = Service.quests().find(q => q.id === 333);
        await quest.onTalk(Service.stateFor(s, quest), { fetchSelfId: () => 7735 });
        await Service.onEvent(s, { questId: 333, name: 'start' });
        s = await sessionFor(333);
        assert.equal(s.questStates.get(333).state, 'started');
        s.activeNpcTalk = { selfId: 7735, objectId: 1 };
        await Service.onEvent(s, { questId: 333, name: 'p1t' });
        // part is an in-session marker until the first proof transaction writes it
        assert.equal(s.questStates.get(333).getInt('part'), 1);
        assert.equal(await amount(333, 3671), 1, 'the mission letter is issued');
        const state = s.questStates.get(333);
        rig(0.1);
        const mob = { fetchSelfId: () => 160, fetchLevel: () => 22 };
        for (let n = 0; n < 20; n++) await quest.onKill(state, mob);
        assert.equal(await amount(333, 3848), 20, 'ashes fall for the Execution Ground');
        assert.equal(await amount(333, 3440), 20, 'cargo boxes fall with the proofs');
        s.activeNpcTalk = { selfId: 7735, objectId: 1 };
        const adena0 = await amount(333, 57);
        await quest.onTalk(state, { fetchSelfId: () => 7735 });
        assert.equal(await amount(333, 57) - adena0, 35 * 20, 'the proofs pay 35 apiece');
        assert.equal(await amount(333, 3675), 1, 'twenty proofs earn a lion claw');
        await give(333, 3675, 9);
        s = await sessionFor(333);
        s.activeNpcTalk = { selfId: 7735, objectId: 1 };
        await Service.onEvent(s, { questId: 333, name: 'continue' });
        assert.equal(await amount(333, 3676), 1, 'ten claws make a lion eye');
        assert.equal(await amount(333, 735), 3, 'the eye exchange hands out supplies');
        s.activeNpcTalk = { selfId: 7736, objectId: 1 };
        rig(0.01);
        await Service.onEvent(s, { questId: 333, name: 'openBox' });
        assert.equal(await amount(333, 3444), 1, 'the first band opens into Gludio apples');
        assert(await amount(333, 57) < 200000 + 700, 'the box opening charges its 650');
        for (const id of [3457, 3458, 3459, 3460]) await give(333, id, 1);
        s = await sessionFor(333);
        s.activeNpcTalk = { selfId: 7471, objectId: 1 };
        rig(0.6);
        await Service.onEvent(s, { questId: 333, name: 'assembleStatue' });
        assert.equal(await amount(333, 3461), 1, 'the statue restores on a lucky roll');
        s.activeNpcTalk = { selfId: 7130, objectId: 1 };
        const adena1 = await amount(333, 57);
        await Service.onEvent(s, { questId: 333, name: 'giveStatue' });
        assert.equal(await amount(333, 57) - adena1, 30000, 'Undrias pays 30000 for the statue');
        s.activeNpcTalk = { selfId: 7737, objectId: 1 };
        await Service.onEvent(s, { questId: 333, name: 'giveBox' });
        assert.equal(await amount(333, 3677), 1, 'Morgan pays a guild coin per box');
        s.activeNpcTalk = { selfId: 7735, objectId: 1 };
        await Service.onEvent(s, { questId: 333, name: 'exit' });
        assert.equal((await sessionFor(333)).questStates.get(333).state, 'created');
        assert.equal(await amount(333, 1369), 0, 'the mark is surrendered on exit');
    }

    // ---- 369 珠宝收集者: 两种碎片, 第一阶段结算 ----
    {
        let s = await sessionFor(369);
        s.activeNpcTalk = { selfId: 7376, objectId: 1 };
        await Service.onEvent(s, { questId: 369, name: 'start' });
        s = await sessionFor(369);
        const quest = Service.quests().find(q => q.id === 369);
        const state = s.questStates.get(369);
        rig(0.5);
        await quest.onKill(state, { fetchSelfId: () => 747 });
        await quest.onKill(state, { fetchSelfId: () => 749 });
        assert.equal(await amount(369, 5883), 1, 'Roxide drops a freezing shard');
        assert.equal(await amount(369, 5882), 1, 'Death Fire drops a flare shard');
        await give(369, 5883, 49);
        await give(369, 5882, 49);
        s = await sessionFor(369);
        await quest.onTalk(s.questStates.get(369), { fetchSelfId: () => 7376 });
        assert.equal((await sessionFor(369)).questStates.get(369).getInt('cond'), 2, 'a full set of 50 opens the sale');
        s = await sessionFor(369);
        s.activeNpcTalk = { selfId: 7376, objectId: 1 };
        const adena0 = await amount(369, 57);
        await Service.onEvent(s, { questId: 369, name: 'sell_shards' });
        assert.equal(await amount(369, 57) - adena0, 12500, 'the first crate pays 12500');
        assert.equal((await sessionFor(369)).questStates.get(369).getInt('cond'), 3, 'Nell expects two hundred again');
    }

    // ---- 370 智者播种: 每园只出一册, 交付一次 ----
    {
        let s = await sessionFor(370);
        s.activeNpcTalk = { selfId: 7612, objectId: 1 };
        await Service.onEvent(s, { questId: 370, name: 'start' });
        s = await sessionFor(370);
        const quest = Service.quests().find(q => q.id === 370);
        const state = s.questStates.get(370);
        // The four chapters share one 0..99 roll in four 14% windows, so the
        // declarative cascade pays [.00,.14) fire, [.14,.28) water, [.28,.42) wind,
        // [.42,.56) earth, and nothing above .56.
        rig(0.1);
        await quest.onKill(state, { fetchSelfId: () => 82 });
        assert.equal(await amount(370, 5917), 1, 'fire chapter from the first window');
        await quest.onKill(state, { fetchSelfId: () => 84 });
        assert.equal(await amount(370, 5917), 1, 'one chapter per kind, the cap holds');
        rig(0.9);
        await quest.onKill(state, { fetchSelfId: () => 89 });
        assert.equal(await amount(370, 5917), 1, 'a roll past every window drops nothing');
        rig(0.2);
        await quest.onKill(state, { fetchSelfId: () => 86 });
        assert.equal(await amount(370, 5918), 1, 'water chapter from the second window');
        rig(0.35);
        await quest.onKill(state, { fetchSelfId: () => 90 });
        assert.equal(await amount(370, 5919), 1, 'wind chapter from the third window');
        rig(0.5);
        await quest.onKill(state, { fetchSelfId: () => 82 });
        assert.equal(await amount(370, 5920), 1, 'earth chapter from the fourth window');
        await quest.onTalk(state, { fetchSelfId: () => 7612 });
        assert.equal(await amount(370, 57), 3600, 'Vamanes pays for the four chapters');
        assert.equal(await amount(370, 5917), 0);
    }

    // ---- 380 带来食材的风味: 三次采集, 厨房, 配方几率 ----
    {
        let s = await sessionFor(380);
        s.activeNpcTalk = { selfId: 7069, objectId: 1 };
        const quest = Service.quests().find(q => q.id === 380);
        await quest.onTalk(Service.stateFor(s, quest), { fetchSelfId: () => 7069 });
        await Service.onEvent(s, { questId: 380, name: 'start' });
        s = await sessionFor(380);
        let state = s.questStates.get(380);
        rig(0.05);
        for (let n = 0; n < 4; n++) await quest.onKill(state, { fetchSelfId: () => 205 });
        rig(0.3);
        for (let n = 0; n < 20; n++) await quest.onKill(state, { fetchSelfId: () => 206 });
        for (let n = 0; n < 10; n++) await quest.onKill(state, { fetchSelfId: () => 225 });
        assert.equal((await sessionFor(380)).questStates.get(380).getInt('cond'), 2, 'full larders move the cook');
        await give(380, 1831, 2);
        s = await sessionFor(380);
        state = s.questStates.get(380);
        s.activeNpcTalk = { selfId: 7069, objectId: 1 };
        await quest.onTalk(state, { fetchSelfId: () => 7069 });
        assert.equal((await sessionFor(380)).questStates.get(380).getInt('cond'), 3, 'the antidotes open the plan');
        await quest.onTalk(state, { fetchSelfId: () => 7069 });
        await quest.onTalk(state, { fetchSelfId: () => 7069 });
        assert.equal((await sessionFor(380)).questStates.get(380).getInt('cond'), 5);
        await quest.onTalk(state, { fetchSelfId: () => 7069 });
        assert.equal(await amount(380, 5960), 1, 'the ritron jelly is rendered');
        await quest.onTalk(state, { fetchSelfId: () => 7069 });
        assert.equal((await sessionFor(380)).questStates.get(380).state, 'completed');
        assert.equal(await amount(380, 5959), 1, 'the roll of 0.5 falls inside the 55% recipe chance');
    }

    Math.random = random;
    console.log('nine imported 20-30 quests (298/326/327/328/330/333/369/370/380): start, kills, cash-out, assembly, reviews, exits and rewards passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await Database.close();
    fs.rmSync(directory, { recursive: true, force: true });
});
