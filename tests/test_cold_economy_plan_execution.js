process.env.BOT_DEVELOPER_DIAGNOSTICS = 'true'; // This fixture asserts optional postcommit error counters.
const assert = require('node:assert/strict');
const { createWorld, Database, DataCache } = require('./helpers/c4QuestHarness');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
const Population = invoke('GameServer/Bot/Population/PopulationService');
const { ColdSimulationCoordinator } = require('../src/GameServer/Bot/Population/ColdSimulationCoordinator');
const { ColdSimulationKernel } = require('../src/GameServer/Bot/Population/ColdSimulationKernel');
const StateWire = require('../src/GameServer/Bot/Population/ColdStateWire');
const { fnv1a32 } = require('../src/GameServer/Bot/Fnv1a');
const id = 730061, restores = [];
function stub(object, key, value) { const previous = object[key]; restores.push(() => object[key] = previous); object[key] = value; }
(async () => {
    const world = await createWorld([{ id, classId: 0, level: 30 }], 'economy-plan-execution');
    try {
        await Life.init();
        await Database.createAccount('bot_plan_execution', 'fixture');
        await Database.execute(['UPDATE characters SET username=? WHERE id=?', ['bot_plan_execution', id]]);
        await Database.setItem(id, { selfId: 57, name: 'Adena', amount: 100000, slot: 0 });
        await Database.setItem(id, { selfId: 1867, name: 'Animal Skin', amount: 20, slot: 0 });
        let state = await Life.upsertState({ characterId: id, accountName: 'bot_plan_execution', name: 'PlanSeller',
            level: 30, exp: Number(DataCache.experience[29]), phase: 'cold', activity: 'hunting', adena: 100000,
            loc: { locX: 83396, locY: 147904, locZ: -3400 }, currentRegion: 'Giran',
            vitals: { hp: 187, maxHp: 187, mp: 74, maxMp: 74 },
            inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)), stats: { classId: 0 },
            timing: { lastResolvedAt: Date.now() - 10000, nextResolveAt: Date.now() + 60000 } }, 'plan_fixture');
        const record = await Database.openBoardRecords(id, 'sell_ad', [{ storeType: 1, town: 'Giran',
            lines: [{ selfId: 1867, name: 'Animal Skin', count: 10, price: 100, enchant: 0, stackable: true }] }]);
        for (const row of record.opened) Afk.refreshRecord(row);
        state = await Life.refreshInventory(state);
        const line = Afk.boardIndex().ownerLines(id)[0]; assert(line);
        const warnings = [], messages = [];
        stub(utils, 'infoWarn', (...args) => warnings.push(require('node:util').format(...args.slice(1))));
        const originalReprice = Database.repriceBoardLines;
        let boardMoves = true;
        stub(Database, 'repriceBoardLines', async (...args) => {
            if (boardMoves) await Database.execute(['UPDATE afk_trade_shops SET revision=revision+1 WHERE id=?', [line.recordId]]);
            return originalReprice.apply(Database, args);
        });
        stub(invoke('GameServer/Bot/Population/PopulationConfig'), 'developerDiagnostics', true);
        const coordinator = new ColdSimulationCoordinator();
        coordinator.worker = { postMessage: message => messages.push(message) }; coordinator.workerEpoch = 'plan:test';
        coordinator.tableChannel.flush = () => {};
        coordinator.reviewCommittedEconomy = async value => value;
        stub(invoke('GameServer/Bot/Goals/GoalService'), 'review', async () => null);
        stub(Life, 'enqueueEquipmentGoalAdvanceForState', () => {});
        stub(invoke('GameServer/Bot/Population/BotLifeEvents'), 'recordMany', async () => {});
        stub(invoke('GameServer/Bot/Population/BotGlobalChat'), 'maybeAnnounce', () => {});
        const proposal = { revision: 0,
            nextState: state, result: { events: [] }, economyEdges: 1,
            economyPlan: { sell: [], withdraw: [line.lineId], buyAds: [], travel: null } };
        const result = { ok: true, characterId: id, nextState: state, proposal };
        // The worker's side of a commit: it flushes the proposal, takes main's
        // commit ack and sends the review command the ack names; main answers it.
        const sent = [];
        const kernel = new ColdSimulationKernel({ resolveSolo: () => null,
            emit: (type, payload) => { sent.push({ type, payload }); return true; } });
        const fromMain = (type, from) => StateWire.unpackPayload(type, messages.slice(from).find(message => message.type === type).payload);
        let steps = 0;
        const commit = async (fields = {}) => {
            // Each commit is its own step: a distinct start, so a distinct proposal id.
            const startedAt = Date.now() + steps++;
            const flushed = { ...proposal, ...fields, proposalId: `${id}:${startedAt}`, characterId: id, priority: 'P1',
                enqueuedAt: Date.now() };
            kernel.upsert({ state: Life.cachedState(id) });
            kernel.inFlight.set(id, { state: Life.cachedState(id), startedAt });
            kernel.dirty.set(id, flushed);
            kernel.flush(null, true);
            const committed = { ...result, nextState: Life.cachedState(id),
                proposal: sent.findLast(message => message.type === 'proposal_batch').payload.proposals[0] };
            const from = messages.length, before = sent.length;
            await coordinator.afterCommit(committed);
            await coordinator.handleCommitResults([committed]);
            const ack = fromMain('commit_ack', from);
            kernel.onCommitAck(ack);
            return { ack: ack.results[0],
                review: sent.slice(before).find(message => message.type === 'command_request')?.payload.requests[0] || null };
        };
        const review = async request => {
            const from = messages.length;
            coordinator.handleCommandRequest({ msgId: `review:${from}`, payload: { requests: [request] } });
            await coordinator.commandTail;
            const answer = fromMain('command_ack', from).results[0];
            kernel.completeCommand(answer);
            return answer;
        };
        const onBoard = () => Afk.boardIndex().ownerLines(id).some(row => row.lineId === line.lineId);
        const stale = await commit();
        assert.equal(stale.ack.ok, true, 'a stale post-commit board step cannot reject an accepted resolve');
        assert(stale.review, 'a commit with a plan is followed by its review command');
        assert.equal((await review(stale.review)).ok, true, 'a failed plan step does not refuse the review');
        assert.equal(warnings.filter(line => line.includes('postcommit economyPlan failed')).length, 1);
        assert.equal((await Database.execute(['SELECT count FROM afk_trade_lines WHERE id=?', [line.lineId]]))[0].count, 10,
            'the changed record keeps its physical stock');
        // The board takes the record as the moved writes left it.
        boardMoves = false;
        for (const row of await Database.fetchAfkTradeShops(id)) Afk.refreshRecord(row);
        // A main write between the ack and the review moves the row: the review
        // is refused and its plan does not run on the moved row.
        const moved = await commit();
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
        Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
        // The step stamped the plan as sent (ColdSimulationWorker economyPlanHash).
        const sentHash = fnv1a32(JSON.stringify(proposal.economyPlan));
        Object.assign(kernel.states.get(id), { economyPending: 1, economyPlanHash: sentHash });
        coordinator.ready = true;
        const beforeRefused = messages.length;
        const refused = await review(moved.review);
        assert.equal(refused.ok, false);
        assert.equal(refused.reason, 'stale_command');
        assert.equal(onBoard(), true, 'a refused review withdraws nothing');
        // The refused plan is no longer the one sent: the worker's refresh that
        // reproduces it sends it again (ColdSimulationWorker publish), and main
        // asks for that refresh after the ack that made the worker forget it.
        assert.equal(kernel.states.get(id).economyPlanHash, null, 'the refused review forgets the plan as sent');
        assert.equal(kernel.states.get(id).economyPending, 1, 'the next state still asks for a refresh');
        const after = messages.slice(beforeRefused).map(message => message.type === 'snapshot_page'
            ? (message.payload.economyOwnerId === id && message.payload.reconcile === true ? 'refresh' : 'page') : message.type);
        assert(after.indexOf('refresh') > after.indexOf('command_ack') && after.indexOf('command_ack') >= 0,
            'main asks for the refresh after the refused ack');
        coordinator.ready = false;
        // The next step proposes the same plan again and its review runs it.
        const applied = await commit();
        assert.equal((await review(applied.review)).ok, true);
        assert.equal(onBoard(), false, 'the review command executes the committed plan');
        const heavy = coordinator.reviewCommittedEconomy;
        coordinator.reviewCommittedEconomy = () => { throw Error('ordinary_loot_main_pass'); };
        assert.equal((await commit({ economyPlan: undefined, economyEdges: 0 })).review, null,
            'an ordinary commit with nothing to review sends no review command');
        coordinator.reviewCommittedEconomy = heavy;
        assert.equal(Population.startLifecycleEconomyEvents, undefined);
        assert.equal(Population.runLifecycleEconomyEvent, undefined);
        assert.equal(Population.releaseWarehouseMaterials, undefined);
        state = await Life.upsertState({ ...(Life.cachedState(id) || state), stats: { ...state.stats,
            money: [10000, .0001, 100, 0, .001, 2000, 1867] } }, 'plan_funded_packet');
        const walletBefore = state.adena;
        const funded = await Market.executePlan(state, { sell: [], withdraw: [], buyAds: [[1867, 5, 110]], travel: null },
            { beforeWrite: () => {}, step: work => coordinator.step('economyPlan', id, work) });
        const boughtAd = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert(boughtAd, 'main publishes the worker quoted buy ad');
        assert.equal(boughtAd.lines[0].count, 5); assert.equal(boughtAd.lines[0].price, 110);
        assert.equal(funded.state.adena + boughtAd.escrowAdena, walletBefore, 'native writer conserves wallet plus escrow');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 1000, 90, 1, 76, 7, 0, 1, .001]], travel: null }, { step: work => work() });
        const resized = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        assert.equal(resized.id, boughtAd.id, 'quantity review retains the standing native record');
        assert.equal(resized.lines[0].price, 110, 'quantity review does not author a lower opening price');
        assert.equal(resized.lines[0].count, Math.floor((walletBefore - 100) / 110),
            'quantity fits the retained price after protecting the survival reserve');
        assert.deepEqual(resized.lines[0].pricing, boughtAd.lines[0].pricing,
            'quantity review preserves the native repricing cursors');
        assert.equal(JSON.parse(resized.lines[0].intentJson)[1], resized.lines[0].count,
            'the root certificate carries the actual advertised quantity');
        assert.equal(JSON.parse(resized.lines[0].intentJson)[2], 110);
        assert.equal(Life.cachedState(id).adena, walletBefore, 'resizing a conditional bid moves no money');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 1000, 90, 1, 76, 7, 0, 1, .001]], travel: null }, { step: work => work() });
        assert.deepEqual(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad'), resized,
            'the same bounded quantity is a native no-op on the next review');
        const packetBefore = Life.cachedState(id).stats.money;
        const priorityState = await Life.upsertState({ ...Life.cachedState(id), stats: { ...Life.cachedState(id).stats,
            money: [10000, .0001, 10000, 0, .002, 50000, 76, .001, 60000, 1867] } }, 'priority_bid_fixture');
        await Market.executePlan(priorityState, { sell: [], withdraw: [],
            buyAds: [[1867, 400, 90, 1, 76, 7, 0, 1, .001]], travel: null }, { step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad').lines[0].count,
            Math.floor((walletBefore - 10000 - 50000) / 110),
            'publication also protects higher-priority money when the desired quantity shrinks');
        await Life.upsertState({ ...Life.cachedState(id), stats: { ...Life.cachedState(id).stats,
            money: packetBefore } }, 'restore_bid_packet');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], buyAds: [[1867, 5, 100]],
            buyCaps: [105], travel: null }, { step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.kind === 'buy_ad').lines[0].price, 100,
            'a same-quantity standing bid cannot retain a price above the worker prepared purchase limit');
        await assert.rejects(Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [],
            buyAds: [[1867, 5, 110]], buyCaps: [105], travel: null }, { step: work => work() }),
        /economy_plan_bid_cap/, 'native publication rejects a quote above its prepared limit');
        const standing = Afk.ownerRecords(id).find(row => row.kind === 'buy_ad');
        const bid = standing.lines[0];
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], travel: null,
            bidLimits: [[bid.id, standing.id, standing.revision, bid.count, bid.price, 95]] },
        { reviewGoal: false, step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 95,
            'a native shopping decision corrects an old bid independently of the current buy watch');
        await Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], travel: null,
            bidLimits: [[bid.id, standing.id, standing.revision, bid.count, bid.price, 95]] },
        { reviewGoal: false, step: work => work() });
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 95,
            'a correction already applied by the postcommit review does not invalidate the remaining plan');
        await assert.rejects(Market.executePlan(Life.cachedState(id), { sell: [], withdraw: [], travel: null,
            bidLimits: [[bid.id, standing.id, standing.revision, bid.count, bid.price, 90]] },
        { reviewGoal: false, step: work => work() }), /afk_trade_shop_changed/,
        'an old quantity/price/revision cannot re-author a correction after the quote changed');
        stub(invoke('GameServer/Bot/Economy/MarketOpportunity'), 'npcOffersAll', selfId => selfId === 1867
            ? [{ sourceType: 'npc', town: standing.town, price: 80 }] : []);
        const Meeting = invoke('GameServer/AfkTrade/TradeMeetingService'), preparation = Meeting.hasPreparation;
        let nativeReview;
        try {
            Meeting.hasPreparation = () => true;
            nativeReview = await Market.reconcileBuyAds(Life.cachedState(id), null,
                [{ type: 'buy_craft_material', target: { itemId: 1867 },
                    plan: { expectedBenefit: 'market_buy_craft_material' } }]);
        } finally { Meeting.hasPreparation = preparation; }
        assert.equal(nativeReview.changed, true);
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 80,
            'an unaccepted meeting preparation cannot freeze an overpriced standing bid at a native visit');
        assert.equal(Life.cachedState(id).adena, walletBefore,
            'lowering a conditional standing bid does not invent escrow or move the wallet');
        let repriced = Afk.ownerRecords(id).find(row => row.id === standing.id);
        await Afk.repriceBot(id, repriced.lines[0].id, 95, repriced.revision);
        state = await Life.upsertState({ ...Life.cachedState(id), activity: 'resting' }, 'resting_bid_fixture');
        await coordinator.afterCommit({ ...result, nextState: state, proposal: { ...proposal,
            nextState: state, market: undefined, economyPlan: undefined, economyEdges: 0 } });
        assert.equal(Afk.ownerRecords(id).find(row => row.id === standing.id).lines[0].price, 80,
            'an ordinary resting commit corrects a standing bid even without a wish plan or new market event');
        assert.equal(Life.cachedState(id).adena, walletBefore);
        const prepared = Life.cachedState(id);
        await Database.execute(['UPDATE bot_life_state SET simulationRevision=simulationRevision+1 WHERE characterId=?', [id]]);
        const actual = Life.acceptLifecycleRow((await Database.execute(['SELECT * FROM bot_life_state WHERE characterId=?', [id]]))[0]);
        const preserved = await Database.fetchAfkTradeShops(id);
        const deferred = await Market.executePlan(actual, { sell: [], withdraw: [], buyAds: [], travel: null },
            { preparedState: prepared, step: work => work() });
        assert.equal(deferred.buyPending, true, 'a changed own native revision keeps the whole buy batch pending');
        assert.deepEqual(await Database.fetchAfkTradeShops(id), preserved,
            'stale complete-empty is not fresh consent to withdraw the old ads');
        const Commit = require('../src/GameServer/Bot/Economy/EconomyCommit');
        const expected = Object.fromEntries(preserved.filter(row => row.kind === 'buy_ad').map(row => [row.id, row.revision]));
        await assert.rejects(Database.replaceBoardRecords(id, 'buy_ad', [], {
            expected, expectedAuthority: Commit.authority(prepared)
        }), /economy_plan_need_changed/, 'the SQL transaction fences even an unchanged/stale main cache');
        assert.deepEqual(await Database.fetchAfkTradeShops(id), preserved);
        await Market.executePlan(actual, { sell: [], withdraw: [], buyAds: [], travel: null },
            { preparedState: actual, step: work => work() });
        assert.equal((await Database.fetchAfkTradeShops(id)).filter(row => row.kind === 'buy_ad').length, 0,
            'a freshly prepared complete-empty batch closes obsolete unaccepted ads');
        const Recipes = invoke('GameServer/Items/C4RecipeItems'), recipe = Recipes.resolveByRecipeId(457);
        const part = recipe.materials.find(row => Number(row.selfId) !== Number(recipe.recipeItemId));
        const Index = invoke('GameServer/Bot/Economy/PersonalWarehouseIndex');
        stub(Index, 'ready', () => true); stub(Index, 'inventory', () => ({}));
        stub(invoke('GameServer/Bot/AI/GearAcquisitionPlanner'), 'considerable', () => true);
        state = await Life.upsertState({ ...Life.cachedState(id), activity: 'hunting', stats: { ...Life.cachedState(id).stats,
            money: [10000, .0001, 0, 0, .001, 2000, part.selfId], equipmentPlan: {
                status: 'deferred', strategy: 'none', reason: 'wish_focus', recipeId: recipe.recipeId,
                target: { selfId: recipe.productId, slot: 14 }, heldInputs: {},
                craftProviders: { [recipe.recipeId]: { publicStation: true } }
            } } }, 'retained_craft_bid_fixture');
        await Market.executePlan(state, { sell: [], withdraw: [], buyAds: [[part.selfId, 2, 100]], travel: null },
            { step: work => work() });
        assert(Afk.ownerRecords(id).some(row => row.storeType === 3 && row.lines.some(line => line.selfId === part.selfId)),
            'the real board publishes the part bid');
        state = Life.cachedState(id);
        await Market.executePlan(state, { sell: [], withdraw: [], buyAds: [], travel: null },
            { preparedState: state, step: work => work() });
        assert(Afk.ownerRecords(id).some(row => row.storeType === 3 && row.lines.some(line => line.selfId === part.selfId)),
            'a current but incomplete worker batch cannot erase a still-funded retained craft bid');
        state = Life.cachedState(id);
        const Trade = invoke('GameServer/Bot/Economy/TradeIntent');
        const newNeed = Trade.encode({ itemId: 1864, amount: 1, price: 100, key: 'resale:1864', recipeId: 0,
            valueHours: .01, valueRate: .001 });
        await Market.executePlan(state, { sell: [], withdraw: [], buyAds: [newNeed], travel: null },
            { preparedState: state, step: work => work() });
        const both = Afk.ownerRecords(id).filter(row => row.storeType === 3).flatMap(row => row.lines.map(line => line.selfId));
        assert(both.includes(part.selfId) && both.includes(1864),
            'a new current bid is published alongside the still-needed retained bid');
        state = await Life.upsertState({ ...Life.cachedState(id), stats: { ...Life.cachedState(id).stats,
            equipmentPlan: { ...Life.cachedState(id).stats.equipmentPlan, reason: 'cancelled' } } }, 'cancel_retained_craft');
        await Market.executePlan(state, { sell: [], withdraw: [], buyAds: [], travel: null },
            { preparedState: state, step: work => work() });
        assert(!Afk.ownerRecords(id).some(row => row.storeType === 3 && row.lines.some(line => line.selfId === part.selfId)),
            'cancelling the project permits the old order to close');
        console.log('test_cold_economy_plan_execution: review command runs the committed plan; stale review refused; ack ok');
    } finally { for (const restore of restores.reverse()) restore(); await world.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
