const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
require('../src/Global');

const Database = invoke('Database');
const Generics = invoke(path.actor);
const Session = invoke('GameServer/Session');
const Status = invoke('GameServer/Actor/CharacterStatus');
const enterWorld = invoke('GameServer/Network/Request/EnterWorld');
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

async function restoredVitals() {
    const Data = invoke('GameServer/DataCache');
    Data.init();
    const classInfo = await invoke('GameServer/Network/Shared').fetchClassInformation(2);
    const Henna = invoke('GameServer/Henna/HennaService');
    const props = { ...utils.crushOb(classInfo), id: 990011, name: 'EntryVitals', classId: 2, level: 40,
        hp: 1, mp: 1, cp: 0, items: [], paperdoll: utils.tupleAlloc(16, {}), title: '', sex: 0, hair: 0, hairColor: 0, face: 0,
        locX: 0, locY: 0, locZ: 0 };
    const Death = invoke('GameServer/Progression/DeathExperience');
    const Recommendations = invoke('GameServer/Recommendations/Runtime');
    const Population = invoke('GameServer/Bot/Population/PopulationService');
    const original = { hennas: Database.fetchCharacterHennas, macros: Database.fetchMacros,
        shortcuts: Database.fetchShortcuts, quests: Database.fetchCharacterQuests,
        notifications: Database.fetchAfkTradeNotifications, death: Death.load,
        recommendations: Recommendations.refresh, scan: Population.requestPhaseScan };
    let releaseHennas;
    Database.fetchCharacterHennas = () => new Promise(resolve => { releaseHennas = resolve; });
    Database.fetchMacros = Database.fetchShortcuts = Database.fetchCharacterQuests = Database.fetchAfkTradeNotifications = async () => [];
    Death.load = Recommendations.refresh = async () => {};
    Population.requestPhaseScan = () => {};
    const session = Object.create(Session.prototype);
    Object.assign(session, { accountId: 'entry_vitals', populationStaging: true,
        dataSendToMe() {}, dataSendToOthers() {} });
    const dispose = () => {
        if (!session.actor) return;
        invoke('GameServer/Effects/EffectTicker').clearAll(session.actor);
        session.actor.automation.stopReplenish();
    };
    try {
        for (const [buff, cpRatio, symbols = []] of [['active', 0.35], ['expired', 0.35], ['active', 0], ['active', null], ['active', 0.35, [39]]]) {
            dispose();
            session.setActor({ ...props });
            session.actor.hennaStats = Henna.totals(symbols);
            Generics.calculateStats(session, session.actor);
            const base = { hp: session.actor.fetchMaxHp(), mp: session.actor.fetchMaxMp(), cp: session.actor.fetchMaxCp() };
            const savedCp = cpRatio === null ? null : base.cp * cpRatio;
            const saved = { hp: base.hp * 1.8, mp: base.mp * 1.8, cp: savedCp };
            const effects = [{ key: 'entry_vitals', id: 1045, level: 1, type: 'buff',
                stats: { maxHpMul: 2, maxMpMul: 2, maxCpMul: 2 },
                expiresAt: Date.now() + (buff === 'active' ? 60000 : -1000) }];
            session.setActor({ ...props, ...saved, effects: JSON.stringify(effects) });
            const actor = session.actor;
            actor.skillset.populateForActor = async (_actor, callback) => callback();
            const pending = enterWorld(session);
            await settle();
            releaseHennas(symbols.map((symbolId, i) => ({ slot: i + 1, symbolId })));
            await pending;
            await settle();
            assert.equal(session.worldEntryActor, actor, 'entry must finish successfully');
            assert.deepEqual(actor.hennaStats, Henna.totals(symbols), 'deferred calculation must still apply the loaded henna bonuses');
            const multiplier = buff === 'active' ? 2 : 1;
            assert.equal(actor.fetchMaxHp(), base.hp * multiplier);
            assert.equal(actor.fetchMaxMp(), base.mp * multiplier);
            assert.equal(actor.fetchMaxCp(), base.cp * multiplier);
            assert.deepEqual(Status.savedVitals(actor), {
                hp: Math.min(saved.hp, actor.fetchMaxHp()),
                mp: Math.min(saved.mp, actor.fetchMaxMp()),
                cp: savedCp === null ? actor.fetchMaxCp() : Math.min(savedCp, actor.fetchMaxCp())
            }, `${buff} effects, CP=${savedCp}: clamp saved vitals only against the restored caps`);
        }
    } finally {
        dispose();
        Database.fetchCharacterHennas = original.hennas;
        Database.fetchMacros = original.macros;
        Database.fetchShortcuts = original.shortcuts;
        Database.fetchCharacterQuests = original.quests;
        Database.fetchAfkTradeNotifications = original.notifications;
        Death.load = original.death;
        Recommendations.refresh = original.recommendations;
        Population.requestPhaseScan = original.scan;
    }
}

async function failedEntryCanRetry() {
    const module = { exports: {} };
    const source = fs.readFileSync(require.resolve('../src/GameServer/Network/Request/EnterWorld'), 'utf8');
    const warnings = [], packets = [], macroReads = [];
    const response = new Proxy({}, { get: (_target, name) => {
        if (name === 'macroList') return rows => rows.map(row => `macro:${row.id}`);
        if (name === 'abnormalStatusUpdate' || name === 'shortBuffStatusUpdate') return { fromActor: () => name };
        return () => name;
    } });
    const dependencies = {
        'GameServer/Network/Response': response,
        Database: { fetchMacros: () => new Promise(resolve => macroReads.push(resolve)), fetchShortcuts: async () => [] },
        'GameServer/Henna/HennaService': { restore: async () => {} },
        'GameServer/Clan/ClanService': { clanForActor: () => null },
        'GameServer/World/GameTime': { isNight: () => false },
        'GameServer/Quest/QuestService': { ensureLoaded: async () => {}, active: () => [] },
        'GameServer/Bot/Population/PopulationService': { requestPhaseScan() {} },
        'GameServer/AfkTrade/AfkTradeService': { deliverNotifications: async () => {} }
    };
    vm.runInNewContext(source, { module, invoke: name => dependencies[name], utils: { infoWarn: (...args) => warnings.push(args) } });
    const enter = module.exports;
    let attempts = 0, rejectFirst, finishSecond;
    const actor = { backpack: { fetchItems: () => [] }, fetchId: () => 1,
        enterWorld() {
            attempts++;
            return attempts === 1 ? new Promise((_resolve, reject) => { rejectFirst = reject; })
                : new Promise(resolve => { finishSecond = resolve; });
        } };
    const session = { actor, dataSendToMe: packet => packets.push(packet), dataSendToOthers() {} };
    const first = enter(session);
    await settle();
    await enter(session);
    assert.equal(attempts, 1, 'duplicate entry stays suppressed while the first attempt is pending');
    rejectFirst(new Error('temporary skill read failure'));
    await first;
    assert.equal(session.enterWorldReady, null, 'failed entry releases the pending-packet barrier');
    assert.equal(session.worldEntryActor, null, 'failed entry releases the actor gate');
    assert(warnings.some(args => args.includes('temporary skill read failure')));

    const retry = enter(session);
    await settle();
    assert.equal(attempts, 2, 'the same actor can retry after the dependency recovers');
    macroReads[0]([{ id: 'old' }]);
    await settle();
    assert(!packets.includes('macro:old'), 'a late read from the failed attempt cannot send packets during the retry');
    assert.equal(session.worldEntryActor, actor, 'old completion cannot release the new attempt gate');
    macroReads[1]([{ id: 'new' }]);
    finishSecond();
    await retry;
    await settle();
    assert(packets.includes('macro:new'));
    assert(packets.includes('shortcutInit'));
    assert.equal(session.enterWorldReady, null);
    assert.equal(session.worldEntryActor, actor);
    await enter(session);
    assert.equal(attempts, 2, 'successful entry continues suppressing duplicate initialization');

    // A replaced actor can finish failing while the connection is already
    // entering its next character. Its cleanup must not release that entry.
    let rejectOld, finishNew;
    const oldActor = { ...actor, enterWorld: () => new Promise((_resolve, reject) => { rejectOld = reject; }) };
    const nextActor = { ...actor, fetchId: () => 2, enterWorld: () => new Promise(resolve => { finishNew = resolve; }) };
    const switching = { ...session, actor: oldActor, worldEntryActor: null };
    const oldEntry = enter(switching);
    await settle();
    switching.actor = nextActor;
    switching.worldEntryActor = null;
    const nextEntry = enter(switching);
    await settle();
    const nextBarrier = switching.enterWorldReady;
    rejectOld(new Error('old character read failure'));
    await oldEntry;
    assert.equal(switching.worldEntryActor, nextActor);
    assert.equal(switching.enterWorldReady, nextBarrier, 'old failure must keep the new character packet barrier');
    macroReads[2]([]);
    macroReads[3]([]);
    finishNew();
    await nextEntry;
    await settle();
    assert.equal(switching.worldEntryActor, nextActor);
    assert.equal(switching.enterWorldReady, null);
}

(async () => {
    await restoredVitals();
    await failedEntryCanRetry();
    console.log('Character entry: saved vitals, restored/expired buffs and failure recovery passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
