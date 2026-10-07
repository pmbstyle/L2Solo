const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const directory = path.join(os.tmpdir(), `l2solo-own-board-look-${require('node:crypto').randomUUID()}`);
fs.mkdirSync(directory);
const config = path.join(directory, 'fixture.ini');
const defaultConfig = fs.readFileSync(path.resolve('config/default.ini'), 'utf8');
const remainingSections = defaultConfig.indexOf('[AuthServer]');
assert(remainingSections > 0);
fs.writeFileSync(config, `[Database]\npath = ${path.join(directory, 'world.sqlite')}\n`
    + `historyPath = ${path.join(directory, 'history.sqlite')}\n\n${defaultConfig.slice(remainingSections)}`);
process.env.L2NODE_CONFIG_FILE = config;
delete process.env.L2NODE_SHARED_CONFIG_FILE;
require('../src/Global');
const DB = invoke('Database');
const Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Config = invoke('GameServer/Bot/Population/PopulationConfig');
const World = invoke('GameServer/World/World');
const Actor = invoke('GameServer/Actor/Actor');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Counters = invoke('GameServer/Bot/Economy/MarketCounters');
const Pricing = invoke('GameServer/Bot/Economy/MarketPricing');
const Decision = invoke('GameServer/Bot/Economy/PriceDecision');
const Rolls = invoke('GameServer/Bot/AI/TendencyRoll');
const Hot = invoke('GameServer/Bot/Economy/HotBoardReviewService');
const Dispatch = invoke('GameServer/Bot/AI/HotAiDispatcher');
const loc = { locX: 83000, locY: 148000, locZ: -3400 };
const saved = { roll: Rolls.roll, ask: Decision.chooseAsk, knowledge: Config.knowledgeErrorsEnabled };
let session;
let jobs = 0;
async function turns() {
    for (let i = 0; i < 12; i++) await new Promise(resolve => Dispatch.enqueue(Symbol('own-look-turn'), resolve));
}
(async () => {
    try {
        assert.equal(path.resolve(options.default.Database.path), path.join(directory, 'world.sqlite'));
        assert.equal(path.resolve(options.default.Database.historyPath), path.join(directory, 'history.sqlite'));
        assert(!fs.existsSync(path.join(directory, 'world.sqlite')));
        DB.init(); assert(DB.isReady()); Data.init();
        Config.knowledgeErrorsEnabled = false;
        World.user = { sessions: [], revision: 0 };
        await Life.init(); await Afk.init();
        const account = 'bot_own_board_look';
        await DB.createAccount(account, 'pw');
        const id = Number((await DB.createCharacter(account, { name: 'OwnBoardLook', race: 0, classId: 0,
            sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 100, maxMp: 100, ...loc })).insertId);
        await DB.setItem(id, { selfId: 57, name: 'Adena', amount: 300000, equipped: false, enchant: 0, slot: 0 });
        await DB.setItem(id, { selfId: 1864, name: 'Stem', amount: 20, equipped: false, enchant: 0, slot: 0 });
        const items = await DB.fetchItems(id);
        const hotState = await Life.upsertState({ characterId: id, accountName: account, name: 'OwnBoardLook',
            phase: 'hot', activity: 'hunting', level: 40, adena: 300000, currentRegion: 'Giran', loc,
            inventory: Life.inventorySummaryFromItems(items), vitals: { hp: 100, maxHp: 100, mp: 100, maxMp: 100 },
            timing: { nextResolveAt: Date.now() + 3600000 }, stats: { generatedCold: true, classId: 0,
                money: [76797, 1, 0, 900000] } }, 'own_board_fixture');
        const row = (await DB.fetchCharacters(account))[0];
        const classInfo = Data.classTemplates.find(entry => Number(entry.classId) === Number(row.classId));
        session = { accountId: account, botSession: true, plan: 'hunting', currentRegion: 'Giran', coldLifeState: hotState,
            fetchAccountId() { return this.accountId; }, dataSendToMe() {}, dataSendToOthers() {}, dataSendToMeAndOthers() {} };
        session.actor = new Actor(session, { ...row, ...utils.crushOb(classInfo), level: 40, items,
            paperdoll: utils.tupleAlloc(16, {}), isOnline: false });
        World.insertUser(session); session.actor.setIsOnline(true); World.updateUserLocation(session);
        const pricing = { price: 200, seenCounter: 0, seenItem: 0, seenAt: Date.now() - 4 * 3600000,
            rival: 0, worth: 0, seenFills: 0 };
        const source = items.find(item => Number(item.selfId) === 1864);
        const shop = await Afk.publishBot(id, { kind: 'sell_ad', storeType: Afk.SELL, town: 'Giran',
            lines: [{ objectId: source.id, selfId: 1864, name: 'Stem', count: 10, price: 200,
                stackable: true, pricing }] });
        const original = (await DB.fetchAfkTradeShops(id))[0];
        assert.equal(original.lines[0].pricing.seenAt, pricing.seenAt, 'line time survives native storage');
        assert.throws(() => Hot.start(), /requires admission/);
        Hot.start({ admit: () => { jobs++; return {}; }, complete() {} });
        assert.equal(Hot.counterChanged, undefined);
        assert.equal(Hot.probeSafety, undefined);
        assert.equal(Hot.repairSafety, undefined);
        const board = Afk.boardIndex();
        for (let i = 0; i < 299; i++) board.put({ id: 100000 + i, ownerId: 900000 + i, botOwned: true,
            kind: 'sell_ad', storeType: Afk.SELL, town: 'Giran', revision: 1,
            lines: [{ lineId: 200000 + i, selfId: 1864, count: 10, price: 200, pricing }] });
        board.ownersForCounter = () => { throw new Error('deal fan-out is forbidden'); };
        Counters.deal(1864, 200, 1, Date.now(), 1, 'Giran', 2);
        await turns();
        assert.equal(jobs, 0, 'a deal with 300 owners queues nobody');
        assert.equal(Hot.events.ready.size, 0);
        assert.deepEqual((await DB.fetchAfkTradeShops(id))[0], original, 'deal makes no review write');
        Rolls.roll = () => 0;
        Decision.chooseAsk = (belief, market, trader, roll, price) => ({ price, npc: false });
        assert(Hot.naturalBreak(session, 1));
        assert(!Hot.naturalBreak(session, 1));
        await turns();
        assert.equal(jobs, 1, 'the first rest tick examines only its own lines once');
        assert.deepEqual((await DB.fetchAfkTradeShops(id))[0], original, 'same-price attention has no metadata row');
        Hot.naturalBreak(session, 0);
        Decision.chooseAsk = (belief, market, trader, roll, price) => ({ price: price + 10, npc: false });
        assert(Hot.naturalBreak(session, 2));
        assert(!Hot.naturalBreak(session, 2));
        await turns();
        const changed = (await DB.fetchAfkTradeShops(id))[0];
        assert.equal(changed.lines[0].price, 210);
        assert.equal(changed.lines[0].pricing.seenCounter, 1);
        assert(changed.lines[0].pricing.seenAt >= pricing.seenAt + 4 * 3600000);
        assert.equal(Life.hotRow(id).phase, 'hot');
        assert.equal(Hot.events.ready.size, 0, 'write acknowledgement cannot create a busy retry loop');
        assert.equal(invoke('GameServer/Bot/Population/PopulationMetrics').counters.boardReviewWakeups, 0);
        assert.equal(shop.ownerId, id);
        console.log('PASS 300-owner zero deal wakeups; first hot break, no-change zero writes and native reprice timestamp');
    } finally {
        Hot.stop(); Rolls.roll = saved.roll; Decision.chooseAsk = saved.ask;
        Config.knowledgeErrorsEnabled = saved.knowledge;
        Afk._resetForTests(); Dispatch.resetForTest();
        if (session) World.removeUser(session);
        await DB.close(); fs.rmSync(directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
