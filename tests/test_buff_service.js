const assert = require('assert');
const fs = require('fs');
const path = require('path');

require('../src/Global');

const Database = invoke('Database');
const DataCache = invoke('GameServer/DataCache');
const Policy = invoke('GameServer/Bot/Economy/BuffServicePolicy');
const Cold = invoke('GameServer/Bot/Economy/ColdBuffService');
const Hot = invoke('GameServer/Bot/Economy/BuffService');
const Chat = invoke('GameServer/Bot/Economy/BuffServiceChat');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Coordinator = invoke('GameServer/Bot/Population/ColdSimulationCoordinator');

DataCache.init();
const databasePath = path.join(process.cwd(), 'tmp', 'test-buff-service.sqlite');
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.rmSync(databasePath, { force: true });
options.default.Database.path = path.relative(process.cwd(), databasePath);
Database.init();

function state(characterId, classId, spotId = 'test-spot') {
    return {
        characterId, name: `BuffTest${characterId}`, level: 55, phase: 'cold', activity: 'hunting',
        spotId, adena: 20000, party: { partyId: null },
        stats: { classId, money: [6000, 0, 0, 0], coldCombat: { skills: invoke('GameServer/Bot/Population/ColdCombatProfile').skillRecordsFromTree(classId, 55), effects: [] } },
        vitals: { hp: 100, maxHp: 100, mp: 2000, maxMp: 2000 },
        inventory: { 57: { selfId: 57, name: 'Adena', amount: 20000 } },
        simulation: { ownerId: 'legacy_main', revision: 0, leaseId: null, leaseUntil: 0 }
    };
}

async function character(account, name) {
    await Database.createAccount(account, 'secret');
    await Database.createCharacter(account, { name, race: 0, classId: 0, maxHp: 100, maxMp: 2000,
        sex: 0, face: 0, hair: 0, hairColor: 0, locX: 0, locY: 0, locZ: 0 });
    const id = Number((await Database.fetchCharacterName(name))[0].id);
    await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 20000, equipped: false, slot: 0 });
    return id;
}
async function persistState(current) {
    await Database.execute([
        `INSERT INTO bot_life_state (characterId, accountName, characterName, level, activity, phase,
            spotId, hp, maxHp, mp, maxMp, adena, statsJson, inventorySummary, updatedAt)
            VALUES (?, ?, ?, 55, 'hunting', 'cold', ?, 100, 100, 2000, 2000, 20000, ?, ?, ?)`,
        [current.characterId, `buff_service_${current.characterId}`, current.name, current.spotId,
            JSON.stringify(current.stats), JSON.stringify(current.inventory), Date.now()]
    ]);
}

(async () => {
    const providerId = await character('buff_service_seller', 'BuffSeller');
    const buyerId = await character('buff_service_buyer', 'BuffBuyer');
    const provider = state(providerId, 17);
    const buyer = state(buyerId, 9);
    assert(Policy.serviceClass(provider));
    assert(!Policy.serviceClass(state(999, 51)), 'orc party buffs are not sold');
    assert(!Policy.serviceClass(state(998, 21)), 'songs are not sold');
    assert(!Cold.coldOffer(provider, { ...buyer, spotId: 'another-spot' }), 'cold sale must stay on one spot');
    assert(!Cold.coldOffer(provider, { ...buyer, stats: { ...buyer.stats, pvpEncounter: {} } }),
        'cold bots do not buy during PvP');
    const offer = Cold.coldOffer(provider, buyer);
    assert(offer && offer.effects.length > 0 && offer.mpCost > 0 && offer.price > 0);
    const pricedSkills = offer.effects.map(effect => ({
        fetchConsumedMp: () => Cold.skillAdapter({ selfId: effect.id, level: effect.level }).fetchConsumedMp()
    }));
    const neutralPrice = Policy.priceFor({ provider, recipient: buyer, skills: pricedSkills, town: false });
    assert(Policy.priceFor({ provider, recipient: buyer, skills: pricedSkills, town: false, trust: 9 }) < neutralPrice,
        'trusted buyers get a discount');
    assert(offer.effects.every(effect => !/^song_|^dance_|^chant_|paagrio/.test(effect.key)));
    for (const current of [provider, buyer]) await persistState(current);
    const paid = await Database.purchaseColdBuffs({ payerId: buyerId, providerId, spotId: 'test-spot',
        payerRevision: 0, providerRevision: 0, price: offer.price, mpCost: offer.mpCost,
        effects: offer.effects, timestamp: offer.timestamp });
    assert.strictEqual(paid.ok, true);
    assert.strictEqual(paid.buyerAdena + paid.sellerAdena, 40000, 'payment only moves Adena');
    assert.strictEqual(paid.nextMp, 2000 - offer.mpCost);
    assert.strictEqual(paid.buyerStats.coldCombat.effects.length, offer.effects.length);
    assert.strictEqual((await Database.fetchItems(buyerId)).find(item => item.selfId === 57).amount, paid.buyerAdena);
    const replay = await Database.purchaseColdBuffs({ payerId: buyerId, providerId, spotId: 'test-spot',
        payerRevision: 0, providerRevision: 0, price: offer.price, mpCost: offer.mpCost,
        effects: offer.effects, timestamp: offer.timestamp });
    assert.strictEqual(replay.reason, 'stale_snapshot', 'a stale worker snapshot cannot buy twice');
    const wrongSpot = await Database.transferBuffServiceAdena({ payerId: buyerId, providerId,
        amount: 100, expectedSpotId: 'another-spot' });
    assert.strictEqual(wrongSpot.reason, 'spot_or_activity_changed');

    const tickProviderId = await character('buff_service_tick_seller', 'TickBuffSeller');
    const tickBuyerId = await character('buff_service_tick_buyer', 'TickBuffBuyer');
    const tickProvider = state(tickProviderId, 17);
    const tickBuyer = state(tickBuyerId, 9);
    await persistState(tickProvider);
    await persistState(tickBuyer);
    const originalCachedState = LifeState.cachedState;
    const originalAccept = LifeState.acceptSimulationOwnership;
    const originalMarkDirty = Coordinator.markDirty;
    const dirtyReasons = [];
    try {
        LifeState.cachedState = id => [tickProvider, tickBuyer].find(state => state.characterId === Number(id)) || null;
        LifeState.acceptSimulationOwnership = (_id, _revision, committed) => committed;
        Coordinator.markDirty = (_state, options) => { dirtyReasons.push(options.reason); return { ok: true }; };
        const packet = invoke('GameServer/Bot/Economy/ColdBuffOffer').project(tickProvider, [tickProvider, tickBuyer], Date.now());
        const result = await Cold.applyOffer(packet);
        assert.strictEqual(result.ok, true, 'the provider proposal settles a same-spot purchase');
        assert.deepStrictEqual(dirtyReasons.sort(), ['buff_service_purchase', 'buff_service_sale']);
        const buyerRow = await Database.execute(['SELECT statsJson, adena FROM bot_life_state WHERE characterId = ?', [tickBuyerId]]);
        const sellerRow = await Database.execute(['SELECT adena, mp FROM bot_life_state WHERE characterId = ?', [tickProviderId]]);
        assert(JSON.parse(buyerRow[0].statsJson).coldCombat.effects.length > 0);
        assert.strictEqual(Number(buyerRow[0].adena) + Number(sellerRow[0].adena), 40000);
        assert(Number(sellerRow[0].mp) < 2000);
    } finally {
        LifeState.cachedState = originalCachedState;
        LifeState.acceptSimulationOwnership = originalAccept;
        Coordinator.markDirty = originalMarkDirty;
    }

    const hotProviderId = await character('buff_service_hot_seller', 'HotBuffSeller');
    const playerId = await character('buff_service_hot_buyer', 'HotBuffBuyer');
    const skill = {
        fetchSelfId: () => 1040, fetchLevel: () => 3, fetchName: () => 'Shield',
        fetchConsumedMp: () => 20, fetchSpell: () => true,
        fetchDistance: () => 400, fetchCalculatedHitTime: () => 1,
        fetchSemantic: () => ({ effectType: 'buff', target: 'friendly', effect: 'shield' }),
        fetchTargetKind: () => 'friendly'
    };
    function hotActor(id, name) {
        const adena = { fetchSelfId: () => 57, fetchAmount() { return this.amount; }, setAmount(amount) { this.amount = amount; }, amount: 20000 };
        const backpack = { items: [adena], fetchItemFromSelfId: () => backpack.items.find(item => item.fetchSelfId() === 57),
            fetchItems: () => backpack.items, insertItem: (_id, _selfId, data) => backpack.items.push({ ...adena, amount: data.amount }) };
        return { backpack, fetchId: () => id, fetchName: () => name, fetchLevel: () => 55,
            fetchClanId: () => 0, fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
            isDead: () => false, state: { fetchCombats: () => false },
            fetchMaxMp: () => 2000, mp: 2000, fetchMp() { return this.mp; }, setMp(mp) { this.mp = mp; },
            statusUpdateVitals: () => {} };
    }
    const hotProvider = hotActor(hotProviderId, 'HotBuffSeller');
    hotProvider.skillset = { fetchSkill: () => skill };
    const hotPlayer = hotActor(playerId, 'HotBuffBuyer');
    let inventoryPackets = 0;
    const providerSession = { actor: hotProvider, dataSendToMeAndOthers: () => {}, dataSendToMe: () => { inventoryPackets += 1; } };
    const playerSession = { actor: hotPlayer, dataSendToMe: () => { inventoryPackets += 1; } };
    const Planner = invoke('GameServer/Bot/AI/BotSupportPlanner');
    const Effects = invoke('GameServer/Skills/C4SkillEffects');
    const Manager = invoke('GameServer/Bot/BotManager');
    const NativeTrade = invoke('GameServer/Bot/BotTradeService');
    const Response = invoke('GameServer/Network/Response');
    const originals = { skills: Policy.hotSkills, serviceClass: Policy.serviceClass,
        sessions: Manager.sessions, needs: Planner.needsSkill, plan: Planner.canPlanSupportAction,
        execute: Effects.execute, find: Manager.findSessionById, tell: Manager.botTell,
        started: Response.skillStarted, itemsList: Response.itemsList,
        startBuffTrade: NativeTrade.startBuffTrade };
    try {
        Policy.hotSkills = () => [skill];
        Planner.needsSkill = () => true;
        Planner.canPlanSupportAction = () => true;
        Effects.execute = () => ({ effect: { key: 'shield' } });
        Manager.findSessionById = id => id === hotProviderId ? providerSession : null;
        Manager.botTell = () => true;
        Response.skillStarted = () => ({});
        Response.itemsList = () => ({});
        NativeTrade.startBuffTrade = () => ({ ok: true });
        const quote = Hot.quote(playerSession, providerSession);
        assert(quote.ok && quote.price > 0);
        const result = await Hot.buy(playerSession, { wait: async () => {} });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.applied, 1);
        assert.strictEqual(result.paid, quote.price);
        assert.strictEqual(hotProvider.fetchMp(), 1980);
        assert.strictEqual(hotPlayer.backpack.fetchItemFromSelfId(57).fetchAmount(), 20000 - quote.price);
        assert.strictEqual((await Database.fetchItems(hotProviderId)).find(item => item.selfId === 57).amount, 20000 + quote.price);
        assert.strictEqual(inventoryPackets, 2, 'both inventories refresh after payment');
        Effects.execute = () => ({ effect: null });
        const failedQuote = Hot.quote(playerSession, providerSession);
        const failed = await Hot.buy(playerSession, { wait: async () => {} });
        assert(failedQuote.ok);
        assert.strictEqual(failed.applied, 0);
        assert.strictEqual(failed.paid, 0, 'a rejected effect is refunded');
        assert.strictEqual(hotPlayer.backpack.fetchItemFromSelfId(57).fetchAmount(), 20000 - quote.price);
        assert.strictEqual((await Database.fetchItems(hotProviderId)).find(item => item.selfId === 57).amount, 20000 + quote.price);
        assert.strictEqual(inventoryPackets, 6, 'payment and refund both refresh inventories');
        hotPlayer.fetchLocX = () => 500;
        const distantQuote = Hot.buildQuote(playerSession, providerSession);
        assert.strictEqual(distantQuote.ok, false, 'sale respects native skill range');
        assert.match(distantQuote.reason, /within 400/, 'range error tells the buyer how close to stand');
        assert.strictEqual(Hot.buildQuote({ actor: { ...hotPlayer, fetchClanId: () => 77 } },
            { actor: { ...hotProvider, fetchClanId: () => 77 } }).ok, false);
        hotPlayer.fetchLocX = () => 0;
        assert.strictEqual(Hot.buildQuote({ actor: { ...hotPlayer, fetchClanId: () => 77 } },
            { actor: { ...hotProvider, fetchClanId: () => 77 } }).price, 0, 'same clan is free');
        hotPlayer.backpack.fetchItemFromSelfId(57).setAmount(0);
        Hot.quote(playerSession, providerSession);
        const unaffordable = await Hot.buy(playerSession);
        assert.strictEqual(unaffordable.ok, false);
        assert.match(unaffordable.reason, /need .* Adena/);
        assert.strictEqual((await Database.fetchItems(hotProviderId)).find(item => item.selfId === 57).amount, 20000 + quote.price);
        // The E1 native hour can price this package above a quarter of the old 20k fixture wallet.
        await Database.execute(['UPDATE items SET amount=50000 WHERE characterId=? AND selfId=57', [playerId]]);
        hotPlayer.backpack.fetchItemFromSelfId(57).setAmount(50000);
        Effects.execute = () => ({ effect: { key: 'shield' } });
        Policy.serviceClass = actor => actor === hotProvider;
        Manager.sessions = [providerSession, playerSession];
        const sellerBeforeAuto = (await Database.fetchItems(hotProviderId)).find(item => item.selfId === 57).amount;
        assert.strictEqual(Hot.maybeAutoBuy(playerSession), true, 'a nearby solo bot requests a useful buff');
        for (let attempt = 0; playerSession.buffServicePending && attempt < 100; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.strictEqual(playerSession.buffServicePending, false);
        assert((await Database.fetchItems(hotProviderId)).find(item => item.selfId === 57).amount > sellerBeforeAuto);
    } finally {
        Policy.hotSkills = originals.skills; Policy.serviceClass = originals.serviceClass;
        Manager.sessions = originals.sessions; Planner.needsSkill = originals.needs;
        Planner.canPlanSupportAction = originals.plan; Effects.execute = originals.execute;
        Manager.findSessionById = originals.find; Manager.botTell = originals.tell;
        Response.skillStarted = originals.started; Response.itemsList = originals.itemsList;
        NativeTrade.startBuffTrade = originals.startBuffTrade;
    }
    const TradeChat = invoke('GameServer/Bot/Economy/BotTradeChat');
    const originalDeliver = TradeChat.deliver;
    const originalSupportSkills = Planner.supportSkills;
    const originalServiceClass = Policy.serviceClass;
    try {
        const serviceActor = { ...hotProvider,
            fetchLocX: () => -12736, fetchLocY: () => 122816, fetchLocZ: () => -3114,
            automation: { abortAll: () => { serviceActor.stopped = true; } } };
        const serviceSession = { actor: serviceActor, plan: 'hunting' };
        Policy.serviceClass = actor => actor === serviceActor;
        Planner.supportSkills = () => [skill, skill];
        TradeChat.deliver = () => true;
        const startedAt = Date.now();
        assert.strictEqual(Chat.onDuty(serviceSession, startedAt), true);
        assert.strictEqual(serviceActor.stopped, true, 'city service stops hunting movement');
        assert.strictEqual(Chat.onDuty(serviceSession, startedAt + 9 * 60000), true);
        assert.strictEqual(Chat.onDuty(serviceSession, startedAt + 10 * 60000), false, 'city service ends after ten minutes');
        assert.strictEqual(Chat.onDuty(serviceSession, startedAt + 11 * 60000), false, 'city service has a cooldown');
    } finally {
        TradeChat.deliver = originalDeliver;
        Planner.supportSkills = originalSupportSkills;
        Policy.serviceClass = originalServiceClass;
    }
    const nativeProviderId = await character('buff_service_native_seller', 'NativeBuffSeller');
    const nativePlayerId = await character('buff_service_native_buyer', 'NativeBuffBuyer');
    await Database.execute(['UPDATE items SET amount = 100000 WHERE characterId = ? AND selfId = 57', [nativePlayerId]]);
    const Item = invoke('GameServer/Item/Item');
    function nativeBag(row) {
        const adena = new Item(Number(row.id), { selfId: 57, name: 'Adena', kind: 'Other.Money',
            amount: Number(row.amount), stackable: true, equipped: false, slot: 0 });
        return { items: [adena], fetchItems() { return this.items; },
            fetchItemRaw(objectId) { return this.items.find(entry => entry.fetchId() === Number(objectId)); },
            fetchItemFromSelfId(selfId) { return this.items.find(entry => entry.fetchSelfId() === Number(selfId)); },
            insertItem(objectId, selfId, data) { this.items.push(new Item(objectId,
                { selfId, ...data, kind: 'Other.Money', stackable: true })); } };
    }
    function nativeActor(actorId, actorName, bag) {
        return { backpack: bag, fetchId: () => actorId, fetchName: () => actorName,
            fetchLevel: () => 55, fetchClanId: () => 0, fetchIsOnline: () => true,
            fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0,
            isDead: () => false, state: { fetchCombats: () => false },
            fetchMaxMp: () => 2000, mp: 2000, fetchMp() { return this.mp; },
            setMp(mp) { this.mp = mp; }, statusUpdateVitals() {} };
    }
    const nativeProviderRow = (await Database.fetchItems(nativeProviderId)).find(entry => entry.selfId === 57);
    const nativePlayerRow = (await Database.fetchItems(nativePlayerId)).find(entry => entry.selfId === 57);
    const nativeProvider = { accountId: 'bot_native_buff', actor: nativeActor(nativeProviderId,
        'NativeBuffSeller', nativeBag(nativeProviderRow)), dataSendToMeAndOthers() {}, dataSendToMe() {} };
    nativeProvider.actor.skillset = { fetchSkill: () => skill };
    const nativePackets = [], nativeTells = [];
    const nativePlayer = { accountId: 'native_buff_player', actor: nativeActor(nativePlayerId,
        'NativeBuffBuyer', nativeBag(nativePlayerRow)), dataSendToMe(packet) { nativePackets.push(packet); } };
    const tradeDone = invoke('GameServer/Network/Request/TradeDone');
    const addTradeItem = invoke('GameServer/Network/Request/AddTradeItem');
    const originalNative = { skills: Policy.hotSkills, price: Policy.priceFor,
        needs: Planner.needsSkill, plan: Planner.canPlanSupportAction,
        execute: Effects.execute, tell: Manager.botTell, started: Response.skillStarted };
    try {
        Policy.hotSkills = () => [skill];
        Policy.priceFor = () => 15000;
        Planner.needsSkill = () => true;
        Planner.canPlanSupportAction = () => true;
        let nativeEffectCalls = 0;
        Effects.execute = () => {
            nativeEffectCalls += 1;
            return { effect: { key: 'shield' } };
        };
        Manager.botTell = (_seller, _buyer, message) => { nativeTells.push(message); return true; };
        Response.skillStarted = () => ({});
        const offer = Hot.quote(nativePlayer, nativeProvider);
        assert.strictEqual(offer.price, 15000);
        assert(nativePlayer.activeTrade?.buffService, 'one quote opens the native trade');
        assert(nativePackets.some(packet => packet[0] === 0x1e), 'client receives the trade window');
        function offerAdena(amount) {
            const packet = Buffer.alloc(13);
            packet[0] = 0x16;
            packet.writeUInt32LE(Number(nativePlayerRow.id), 5);
            packet.writeUInt32LE(amount, 9);
            addTradeItem(nativePlayer, packet);
        }
        offerAdena(15000);
        assert.strictEqual([...nativePlayer.activeTrade.playerItems.values()][0].count, 15000,
            'buff payment may exceed the ordinary 10000 item cap');
        const firstTrade = nativePlayer.activeTrade;
        await tradeDone(nativePlayer, Buffer.from([0x17, 1, 0, 0, 0]));
        assert(firstTrade.buffServiceCompletion, 'the paid cast continues after the trade closes');
        assert.strictEqual(nativeEffectCalls, 0, 'the buff has not landed when the trade window closes');
        await firstTrade.buffServiceCompletion;
        assert.strictEqual(nativeEffectCalls, 1);
        assert.strictEqual(nativeProvider.actor.fetchMp(), 1980);
        assert.strictEqual((await Database.fetchItems(nativePlayerId)).find(entry => entry.selfId === 57).amount, 85000);
        assert.strictEqual((await Database.fetchItems(nativeProviderId)).find(entry => entry.selfId === 57).amount, 35000);
        assert(nativeTells.some(message => /Done: 1 buff for 15000 Adena/.test(message)));

        Effects.execute = () => ({ effect: null });
        Hot.quote(nativePlayer, nativeProvider);
        offerAdena(15000);
        const failedTrade = nativePlayer.activeTrade;
        await tradeDone(nativePlayer, Buffer.from([0x17, 1, 0, 0, 0]));
        await failedTrade.buffServiceCompletion;
        assert.strictEqual((await Database.fetchItems(nativePlayerId)).find(entry => entry.selfId === 57).amount, 85000,
            'failed buff returns the full native trade payment');
        assert.strictEqual((await Database.fetchItems(nativeProviderId)).find(entry => entry.selfId === 57).amount, 35000);

        Hot.quote(nativePlayer, nativeProvider);
        offerAdena(10000);
        await tradeDone(nativePlayer, Buffer.from([0x17, 1, 0, 0, 0]));
        assert.strictEqual((await Database.fetchItems(nativePlayerId)).find(entry => entry.selfId === 57).amount, 85000,
            'an incomplete offer is rejected before payment');
    } finally {
        Policy.hotSkills = originalNative.skills; Policy.priceFor = originalNative.price;
        Planner.needsSkill = originalNative.needs; Planner.canPlanSupportAction = originalNative.plan;
        Effects.execute = originalNative.execute; Manager.botTell = originalNative.tell;
        Response.skillStarted = originalNative.started;
    }
    const SkillModel = invoke('GameServer/Model/Skill');
    const EffectStore = invoke('GameServer/Effects/EffectStore');
    const prophetLevels = new Map([[1036, 2], [1040, 3], [1044, 3], [1045, 4], [1062, 2],
        [1068, 3], [1077, 3], [1086, 2], [1204, 2], [1240, 3], [1242, 3]]);
    const prophetSkills = [...prophetLevels].map(([skillId, level]) => {
        const definition = DataCache.skills.find(entry => Number(entry.selfId) === skillId);
        const learned = definition.levels.find(entry => Number(entry.level) === level);
        return new SkillModel({ ...utils.crushOb(definition), ...learned });
    });
    const fullProvider = hotActor(9001, 'FullProphet');
    fullProvider.fetchClassId = () => 17;
    fullProvider.skillset = { fetchSkills: () => prophetSkills,
        fetchSkill: skillId => prophetSkills.find(entry => entry.fetchSelfId() === skillId) };
    const fullPlayer = hotActor(9002, 'FullArcher');
    fullPlayer.fetchClassId = () => 24;
    fullPlayer.effects = {};
    const fullProviderSession = { actor: fullProvider, dataSendToMeAndOthers() {} };
    const fullPlayerSession = { actor: fullPlayer };
    const fullSkills = Policy.hotSkills(fullProvider, fullPlayer);
    assert.strictEqual(fullSkills.length, 11, 'Prophet quotes the complete useful archer package');
    const originalExecute = Effects.execute, originalTell = Manager.botTell;
    const originalStarted = Response.skillStarted;
    try {
        Effects.execute = (_session, _provider, target, cast) => {
            const semantic = cast.fetchSemantic();
            return { effect: EffectStore.apply(target, {
                key: semantic.effect, id: cast.fetchSelfId(), level: cast.fetchLevel(),
                type: 'buff', stats: semantic.stats, stackFamily: semantic.stackFamily,
                stackOrder: semantic.stackOrder, durationMs: 20 * 60 * 1000
            }) };
        };
        Manager.botTell = () => true;
        Response.skillStarted = () => ({});
        const completed = await Hot.completeNativeTrade({
            playerSession: fullPlayerSession, botSession: fullProviderSession,
            buffService: { playerId: 9002, providerId: 9001,
                price: 11000, skills: fullSkills.map(entry => entry.fetchSelfId()) }
        }, { wait: async () => {} });
        assert.strictEqual(completed.applied, 11, 'shared stat modifiers must not stop the paid buff package');
        assert.strictEqual(EffectStore.list(fullPlayer).length, 11);
        assert(EffectStore.list(fullPlayer).some(entry => entry.key === 'berserker_spirit'));

        const stagedPlayer = hotActor(9003, 'StagedArcher');
        stagedPlayer.fetchClassId = () => 24;
        stagedPlayer.effects = {};
        const starts = [], castWaits = [];
        fullProviderSession.dataSendToMeAndOthers = packet => {
            if (packet?.kind === 'start') starts.push(packet.skillId);
        };
        Response.skillStarted = (_actor, _target, cast) => ({ kind: 'start', skillId: cast.fetchSelfId() });
        const stagedTrade = Hot.completeNativeTrade({
            playerSession: { actor: stagedPlayer }, botSession: fullProviderSession,
            buffService: { playerId: 9003, providerId: 9001,
                price: 2000, skills: [1036, 1040] }
        }, { wait: () => new Promise(resolve => castWaits.push(resolve)) });
        assert.deepStrictEqual(starts, [1036], 'only the first cast starts before it lands');
        assert.strictEqual(EffectStore.list(stagedPlayer).length, 0, 'buff is absent during the cast');
        castWaits.shift()();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepStrictEqual(starts, [1036, 1040], 'the second cast starts after the first effect lands');
        assert.strictEqual(EffectStore.list(stagedPlayer).length, 1);
        castWaits.shift()();
        const stagedResult = await stagedTrade;
        assert.strictEqual(stagedResult.applied, 2);
        assert.strictEqual(EffectStore.list(stagedPlayer).length, 2);
    } finally {
        Effects.execute = originalExecute; Manager.botTell = originalTell;
        Response.skillStarted = originalStarted;
    }
    console.log('Buff service policy, native trade, full package, and cold settlement checks passed');
    await Database.close();
})().catch(error => { console.error(error); process.exitCode = 1; });
