'use strict';
const assert = require('node:assert/strict');
const { useRate } = require('./helpers/progressionRate');
require('./helpers/databaseIsolation');
const fixture = require('./helpers/isolatedSocialDatabase')('c-grade-shot-lifecycle');
require('../src/Global');
fixture.assertConfigured(options.default);
useRate('x50');
const Database = invoke('Database'), Data = invoke('GameServer/DataCache');
const Life = invoke('GameServer/Bot/Population/BotLifeState');
const Afk = invoke('GameServer/AfkTrade/AfkTradeService');
const Shots = invoke('GameServer/Bot/Economy/ColdShotEconomyService');
const Policy = invoke('GameServer/Bot/Economy/ShotCraftPolicy');
const Workshop = invoke('GameServer/Bot/Economy/CraftWorkshopService');
const Economy = invoke('GameServer/Bot/Economy/EconomyContext');
const Recipes = invoke('GameServer/Items/C4RecipeItems');
const fs = require('node:fs');
const GIRAN = { locX: 83396, locY: 147904, locZ: -3400 };
const GLUDIO = { locX: -12740, locY: 122771, locZ: -3100 };
const held = (items, id) => items.filter(item => Number(item.selfId) === id).reduce((sum, item) => sum + Number(item.amount), 0);
const cash = amount => ({ selfId: 57, name: 'Adena', amount });
let serial = 0;
async function seed(items, { classId = 0, level = 30, name = 'Fixture', town = 'Giran', loc = GIRAN } = {}) {
    const account = `bot_cold_shots_${++serial}`;
    await Database.createAccount(account, 'fixture');
    const race = Number(Data.classTemplates.find(row => Number(row.classId) === classId)?.template?.race || 0);
    const exp = Number(Data.experience[level - 1]);
    const id = Number((await Database.createCharacter(account, { name: `${name}${serial}`, classId, race,
        sex: 0, face: 0, hair: 0, hairColor: 0, maxHp: 1000, maxMp: 1000, ...loc })).insertId);
    await Database.execute(['UPDATE characters SET level=?, exp=?, hp=1000, mp=1000 WHERE id=?', [level, exp, id]]);
    for (const item of items) await Database.setItem(id, { equipped: false, slot: 0, enchant: 0, ...item });
    if ([56, 57, 118].includes(classId)) await Database.setSkill({ selfId: 172, name: 'Create Item',
        level: invoke('GameServer/Bot/Economy/CraftShopService').craftLevelFor({ level, stats: { classId } }), passive: false }, id);
    return Life.upsertState({ characterId: id, accountName: account, name: `${name}${serial}`, level, exp,
        phase: 'cold', activity: 'shopping', adena: held(items, 57), currentRegion: town, loc: { ...loc },
        inventory: Life.inventorySummaryFromItems(await Database.fetchItems(id)),
        vitals: { hp: 1000, maxHp: 1000, mp: 1000, maxMp: 1000 }, stats: { classId, generatedCold: true }, timing: {} }, 'cold_shot_fixture');
}
function preparedRoutes(state) {
    const steps = require('../src/GameServer/Bot/Economy/EconomicTrip').prepare(state);
    let next; do next = steps.next(); while (!next.done);
    return next.value;
}
async function sell(state, id, price, count = 1) {
    // These production cases require executable backed supply, not future WTS interest.
    const previous = Afk.ownerRecords(state.characterId).find(row => row.kind === 'shop');
    const lines = new Map((previous?.lines || []).map(line => [line.selfId, { ...line }]));
    if (previous) await Afk.closeBotRecord(state.characterId, previous.id);
    const item = (await Database.fetchItems(state.characterId)).find(row => Number(row.selfId) === id);
    const template = Data.items.find(row => Number(row.selfId) === Number(id));
    lines.set(id, { objectId: item.id, selfId: id, name: item.name, count, price,
        enchant: 0, stackable: template?.etc?.stackable === true, slot: Number(item.slot || 0) });
    const bag = await Database.fetchItems(state.characterId);
    const offered = [...lines.values()].map(line => ({ ...line, objectId: bag.find(item => item.selfId === line.selfId && !item.equipped).id }));
    await Afk.publishBot(state.characterId, { kind: 'shop', storeType: Afk.SELL, town: 'Giran',
        title: 'Physical craft inputs', lines: offered });
}

(async () => {
    try {
        fixture.assertConfigured(options.default);
        await Database.init(); Data.init(); await Life.init(); await Afk.init(); Workshop.init();
        const Persona = invoke('GameServer/Bot/AI/BotPersona');
        const Market = invoke('GameServer/Bot/Economy/MarketCounters');
        const BotMarket = invoke('GameServer/Bot/Economy/BotAfkMarketService');
        const Wealth = require('../src/GameServer/Bot/Economy/WealthCraftDecision');
        const probe = require('./helpers/workerEconomyDecision');
        const { rowOf } = require('../src/GameServer/AfkTrade/BoardIndex');
        const Codec = require('../src/GameServer/Bot/Economy/RecipeBookCodec');
        let withdrawnStep;
        for (const recipeId of [21, 318, 324]) {
            Market.reset();
            const recipe = Recipes.resolveByRecipeId(recipeId), now = Date.now(), owners = [];
            const ore = recipe.materials.find(m => m.selfId !== 1459), itemId = recipe.productId;
            const recipeCost = { 21: 168409, 318: 150000, 324: 128052 }[recipeId], gearCost = 336127;
            const orePrice = { 1785: 742, 3031: 1188 }[ore.selfId];
            const bidPrice = { 21: 300, 318: 1000, 324: 1300 }[recipeId];
            const supplier = await seed([cash(1000000), { selfId: recipe.recipeItemId, amount: 1 },
                { selfId: 2495, amount: 1 }, { selfId: ore.selfId, amount: 1000 }], { name: 'CInputs' });
            owners.push(supplier.characterId);
            if (recipeId !== 21) await sell(supplier, recipe.recipeItemId, recipeCost);
            await sell(Life.cachedState(supplier.characterId), 2495, gearCost);
            await sell(Life.cachedState(supplier.characterId), ore.selfId, orePrice, 1000);
            const buyers = [];
            for (let i = 0; i < 12; i++) {
                let buyer = await seed([cash(10000000)], { name: 'CConsumer' });
                owners.push(buyer.characterId);
                buyer = await Life.upsertState({ ...buyer, stats: { ...buyer.stats,
                    money: [1000, .001, 0, 0, .002, 10000000, itemId] } }, 'c_shot_buyer');
                await Afk.publishBot(buyer.characterId, { kind: 'buy_ad', storeType: Afk.BUY, town: 'Giran',
                    lines: [{ selfId: itemId, count: 1000, price: bidPrice, stackable: true }] });
                buyers.push(buyer);
            }
            const remote = recipeId === 324;
            let state = await seed([cash(3000000)], { classId: 57, level: 40, name: 'CProducer',
                ...(remote ? { town: 'Gludio', loc: GLUDIO } : {}) });
            owners.push(state.characterId);
            await Persona.ensure(state);
            await Database.setSkill({ selfId: 248, name: 'Crystallize', level: 2, passive: false }, state.characterId);
            const fund = s => Life.upsertState({ ...s, vitals: { ...s.vitals, mp: 424, maxMp: 424 },
                stats: { ...s.stats, money: [500000, .000002, 0, 0] } }, 'c_shot_funding');
            state = await fund(state);
            if (remote) state = await Life.upsertState({ ...state, activity: 'hunting' }, 'remote_recipe_start');
            const investment = Shots.recipeTarget(state, Shots.marketSnapshot(now), [], recipeId);
            assert(investment, `recipe ${recipeId}: finite public interest funds the scroll and inputs`);
            assert.equal(investment.route.exit.type, 'listing');
            assert.equal(Wealth.recipePaths(state, recipe, { route: investment.route,
                acquisition: { available: true, price: recipeCost }, context: investment.route.context }).best.kind, 'hold',
            'ordinary craft funding still rejects this smaller finite return');
            const boardRows = () => owners.flatMap(id => Afk.ownerRecords(id)).map(r => [r.id, rowOf(r)]);
            const plan = (known, rows = boardRows()) => probe({ ...state, persona: Persona.of(state) }, {
                timestamp: now, recipeEarning: true, recipes: { recipeBook: Codec.pack(known), knownShotRecipes: known },
                boardRows: rows });
            let learning = Policy.unpackStep(Policy.packStep((await plan([])).selected));
            assert.equal(learning?.recipeTarget, recipeId, 'the actual worker selects the scroll');
            if (recipeId === 21) {
                const before = held(await Database.fetchItems(state.characterId), 57);
                const beforeSeek = structuredClone(state);
                state = await Shots.execute(state, learning, now);
                assert.equal(held(await Database.fetchItems(state.characterId), 57), before,
                    'seeking a missing recipe spends no money on an invented seller');
                assert.equal(state.stats.shotRecipeDemand?.itemId, recipe.recipeItemId);
                assert(state.stats.shotRecipeDemand.maxSpend > 0 && Number.isFinite(state.stats.shotRecipeDemand.maxSpend));
                assert(state.stats.shotRecipeDemand.inputCash >= 0 && Number.isFinite(state.stats.shotRecipeDemand.inputCash),
                    'recipe procurement carries the executable series capital into public pricing');
                assert(!(await Database.fetchCharacterRecipes(state.characterId)).some(row => row.recipeId === recipeId));
                const procurement = await probe({ ...state, persona: Persona.of(state) }, { timestamp: now,
                    marketPlan: true, marketWarm: beforeSeek, recipes: { recipeBook: Codec.pack([]), knownShotRecipes: [] },
                    tables: [{ name: 'board', from: null, to: 0, full: true, removed: [], rows: boardRows() },
                        ...['personal_warehouse', 'clan_supplies'].map(name => ({ name, from: null, to: 0, full: true,
                            removed: [], rows: [] }))] });
                assert(procurement.economyPlan.buyAds?.some(row => row[0] === recipe.recipeItemId),
                    `the real worker prepares a public recipe request: ${JSON.stringify(procurement.economyPlan)}`);
                assert.equal(procurement.economyPlan.shot, undefined,
                    'the funded recipe bid owns procurement without a second seek changing its revision');
                state = await Life.upsertState({ ...state, stats: { ...state.stats,
                    ...procurement.statsPacket } }, 'shot_recipe_publication_fixture');
                const published = await BotMarket.executePlan(state, procurement.economyPlan, { reviewGoal: false });
                state = published.state;
                assert(Afk.boardIndex().ownerLines(state.characterId).some(line => line.storeType === Afk.BUY
                    && line.selfId === recipe.recipeItemId && line.count === 1),
                'the native writer publishes the missing recipe bid before any seller exists');
                // Release this publication case before the independent
                // direct-seller acquisition/craft/sale path below.
                for (const record of Afk.ownerRecords(state.characterId).filter(record => record.storeType === Afk.BUY))
                    await Afk.closeBotRecord(state.characterId, record.id);
                state = Life.cachedState(state.characterId);
                await sell(Life.cachedState(supplier.characterId), recipe.recipeItemId, recipeCost);
                learning = Policy.unpackStep(Policy.packStep((await plan([])).selected));
                assert.equal(learning?.recipeTarget, recipeId, 'real supply completes the accepted procurement target');
            }
            state = await Shots.execute(state, learning, now);
            if (remote) {
                // A crafter buys its scroll in the town it stands in, never on an errand: in the
                // field it keeps its want and buys nothing; in the seller's town it buys and learns.
                assert.equal(state.stats.marketErrand ?? null, null, 'no crafter errand for a remote scroll');
                assert(!(await Database.fetchCharacterRecipes(state.characterId)).some(r => r.recipeId === recipeId));
                state = await Life.upsertState({ ...state, activity: 'shopping', currentRegion: 'Giran', loc: GIRAN,
                    stats: { ...state.stats, travel: null }, timing: {} }, 'remote_recipe_arrived');
                state = await Shots.execute(state, learning, now);
                assert.equal(state.stats.shotRecipeDemand ?? null, null, 'learning closes the paid recipe demand');
                assert(!Afk.ownerRecords(state.characterId).some(record => record.storeType === Afk.SELL
                    && record.lines.some(line => line.selfId === recipe.recipeItemId && line.count > 0)),
                'the paid learning target is not republished as surplus');
            }
            assert((await Database.fetchCharacterRecipes(state.characterId)).some(r => r.recipeId === recipeId));
            assert.equal(held(await Database.fetchItems(state.characterId), recipe.recipeItemId), 0);
            state = await fund(state);
            const craftStep = Policy.unpackStep(Policy.packStep((await plan([recipeId])).selected));
            assert.equal(craftStep?.craft?.recipeId, recipeId, 'the worker selects the learned C recipe');
            const lot = Shots.recheck(state, craftStep.craft);
            assert(lot, 'the native executor admits the same physical quantity and price');
            assert(lot.expectedSold <= 12000, 'public quote depth bounds expected sales');
            const absent = await plan([recipeId], Afk.ownerRecords(supplier.characterId).map(r => [r.id, rowOf(r)]));
            assert.equal(absent.selected, null, 'no shot production without demand');
            assert.equal(Shots.recheck({ ...state, adena: lot.basket.cashCost - 1 }, craftStep.craft), null,
                'full physical input funding remains required');
            assert.equal(Shots.recheck({ ...state, inventory: { ...state.inventory,
                [itemId]: { selfId: itemId, amount: 1000000 } } }, craftStep.craft), null,
            'unsold output prevents more production');
            const cashBefore = held(await Database.fetchItems(state.characterId), 57);
            state = await Shots.execute(state, craftStep, now + 1);
            const made = await Database.fetchItems(state.characterId), units = lot.batches * recipe.productCount;
            const inputCost = gearCost + lot.batches * ore.amount * orePrice;
            assert.equal(held(made, itemId), units);
            assert.equal(held(made, 1459), 53 - lot.batches * recipe.materials.find(m => m.selfId === 1459).amount);
            assert.equal(held(made, 2495), 0); assert.equal(held(made, ore.selfId), 0);
            assert.equal(held(made, 57), cashBefore - inputCost);
            assert.equal(state.vitals.mp, 424 - lot.batches * recipe.mpCost);
            const timestamp = Date.now();
            const economy = Economy.forState(state, { timestamp, routeRows: preparedRoutes(state) });
            // Fix this visit's tendency roll while native market facts still
            // price and bound the lot.
            const sale = BotMarket.saleDecision(state, { economy, now: timestamp, decisionPoint: 'c-grade-output' });
            assert(sale.listings.some(l => l.selfId === itemId), 'market policy admits the output to the board');
            const publication = await BotMarket.listOnBoard(state, { decided: sale, now: timestamp });
            assert(publication.listed > 0);
            const offer = Afk.offers(itemId, Afk.SELL).find(o => o.sourceId === state.characterId);
            assert(offer); assert.equal(offer.count, units);
            const purchased = Math.min(100, units), buyer = Life.cachedState(buyers[0].characterId);
            await Afk.buyFromShop(buyer.characterId, offer.store, itemId, purchased,
                { lineId: offer.lineId, expectedPrice: offer.price, expectedRevision: offer.expectedRevision, coldState: buyer });
            assert.equal(held(await Database.fetchItems(buyer.characterId), itemId), purchased);
            // A cold seller's proceeds wait on the board until its own step commit takes them.
            const [owed] = await Database.execute(['SELECT COALESCE(SUM(amount), 0) AS amount FROM board_settlements WHERE ownerId = ? AND selfId = 57', [state.characterId]]);
            assert.equal(held(await Database.fetchItems(state.characterId), 57) + Number(owed.amount),
                cashBefore - inputCost + purchased * offer.price, 'the seller is paid the full price of the sold shots');
            assert.equal(Afk.offers(itemId, Afk.SELL).find(o => o.sourceId === state.characterId).count, units - purchased);
            if (recipeId === 21) withdrawnStep = learning;
            console.log('PASS C shot lifecycle', JSON.stringify({ recipeId, itemId, batches: lot.batches, units,
                price: offer.price, purchased, profit: lot.profit, cash: lot.basket.cashCost }));
            for (const id of owners) for (const record of Afk.ownerRecords(id)) {
                if (record.status === 'active') await Afk.closeBotRecord(id, record.id);
            }
        }
        let waiting = await seed([cash(3000000)], { classId: 57, level: 40, name: 'WithdrawnRecipeRoute' });
        waiting = await Life.upsertState({ ...waiting, stats: { ...waiting.stats, money: [500000,.000002,0,0],
            shotRecipeDemand: { recipeId:21, itemId:1805, amount:1, batches:10, maxSpend:168409 } } },
        'withdrawn_recipe_target');
        const unchanged = held(await Database.fetchItems(waiting.characterId), 57);
        const refused = await Shots.execute(waiting, withdrawnStep, Date.now());
        assert.equal(refused.stats.shotRecipeDemand, null, 'a withdrawn physical route closes its recipe demand');
        assert.equal(held(await Database.fetchItems(waiting.characterId), 57), unchanged);

        Market.reset();
        const recipe = Recipes.resolveByRecipeId(21), now = Date.now();
        const supplier = await seed([cash(1000000),{selfId:2495,amount:1}],{name:'SeriesCrystalGear'});
        await sell(supplier,2495,379500);
        const buyer = await seed([cash(10000000)],{name:'SeriesConsumer'});
        const order = await Afk.publishBot(buyer.characterId,{kind:'shop',storeType:Afk.BUY,town:'Giran',
            lines:[{selfId:1464,count:47600,price:100,stackable:true}]});
        let investor = await seed([cash(10000000),{selfId:1785,amount:100000},
            {selfId:1805,amount:1}],{classId:57,level:49,name:'SeriesInvestor'});
        await Persona.ensure(investor);
        await Database.setSkill({selfId:248,name:'Crystallize',level:2,passive:false},investor.characterId);
        investor = await Life.upsertState({...investor,vitals:{...investor.vitals,mp:80,maxMp:500},
            stats:{...investor.stats,money:[1000000,.000001,0,0]}},'series_investment_fixture');
        const rows = () => [supplier.characterId,buyer.characterId].flatMap(id=>Afk.ownerRecords(id))
            .map(row=>[row.id,rowOf(row)]);
        const ask = async known => Policy.unpackStep(Policy.packStep((await probe({...investor,persona:Persona.of(investor)},
            {timestamp:now,recipeEarning:true,recipes:{recipeBook:Codec.pack(known),knownShotRecipes:known},
                boardRows:rows()})).selected));
        const learn = await ask([]);
        assert.equal(learn?.recipeTarget,21,'a profitable series funds learning despite the first-command loss');
        investor = await Shots.execute(investor,learn,now);
        assert((await Database.fetchCharacterRecipes(investor.characterId)).some(row=>row.recipeId===21));
        const action = await ask([21]);
        assert.equal(action?.craft?.recipeId,21);
        assert.equal(action.craft.batches,1,'the investment executes only the actual MP command');
        assert(action.craft.horizonBatches>action.craft.batches);
        assert.equal(Shots.recheck(investor,action.craft),null,'the first command does not stand as an isolated profitable purchase');
        const physical = Shots.recheck(investor,action.craft,{physicalOnly:true});
        assert(physical && physical.valueHours<0);
        const series = Shots.recheckSeries(investor,physical,action.craft);
        assert(series && series.valueHours>0 && series.horizon.readyHours<=.5);
        const beforeCash = held(await Database.fetchItems(investor.characterId),57);
        investor = await Shots.execute(investor,action,now+1);
        const bag = await Database.fetchItems(investor.characterId);
        assert.equal(held(bag,1464),recipe.productCount,'native craft never executes the future MP batches');
        assert.equal(held(bag,1459),52,'the one gear purchase keeps crystals for subsequent commands');
        assert.equal(held(bag,57),beforeCash-379500);
        assert.equal(investor.vitals.mp,10);
        const Disposition = invoke('GameServer/Bot/Economy/ItemDisposition');
        const remaining = action.craft.horizonBatches-1;
        assert.equal(Disposition.productionInputAmounts(investor)[1459],remaining,
            'only the crystals for the remaining accepted series survive market cleanup');
        const crystalBuyer = await seed([cash(1000000)],{name:'SurplusCrystalConsumer'});
        await Afk.publishBot(crystalBuyer.characterId,{kind:'shop',storeType:Afk.BUY,town:'Giran',
            lines:[{selfId:1459,count:52,price:1500,stackable:true}]});
        const saleCount = Disposition.saleCandidates(investor,{unlimited:true})
            .find(row=>row.selfId===1459)?.count || 0;
        assert(saleCount<=52-remaining,'public crystal demand cannot liquidate inputs promised to the shot series');
        const sale = BotMarket.saleDecision(investor,{now:Date.now(),
            economy:Economy.forState(investor,{routeRows:preparedRoutes(investor)}),decisionPoint:'series-crystal-retention'});
        assert((sale.listings.find(row=>row.selfId===1459)?.count || 0)<=52-remaining,
            'native listing retains future shot inputs and can list only the surplus');
        assert.equal(Disposition.productionInputAmounts(investor,now+31*60000)[1459],undefined,
            'a series cannot reserve materials beyond its finite planning window');
        await Afk.closeBotRecord(buyer.characterId,order.id);
        assert.equal(Disposition.productionInputAmounts(investor)[1459],undefined,
            'withdrawn shot demand releases the future crystal stock immediately');
        assert.equal(Shots.recheckSeries(investor,physical,action.craft),null,
            'withdrawn series demand cannot authorize another purchase');
        investor = await Shots.execute(investor,action,now+2);
        assert.equal(investor.stats.shotCraft.series,null,'the rejected continuation clears its saved series');
        console.log('PASS native shot investment: negative first command, funded series, real MP, retained inputs, expiry and demand withdrawal');

        // A crafter buys its craft's inputs only in the town it stands in (no errand): the
        // shield it bought to crystallize for a shot craft is its kit's (ItemDisposition.kitGear)
        // until the kit goes. It is not worn, nor offered for sale, also when another copy is
        // already worn; once the kit no longer holds it (expired or dropped), it is gear again.
        for (const alreadyWorn of [false,true]) {
            const stamp = Date.now(), wornId = alreadyWorn ? 2495 : 18;
            let smith = await seed([cash(3000000),{selfId:wornId,amount:1,equipped:true,slot:8},{selfId:2495,amount:1}],
                {classId:57,level:40,name:'KitShieldSmith'});
            const kit = when => ({...smith,stats:{...smith.stats,shotCraft:{preparing:{recipeId:324,
                productId:Recipes.resolveByRecipeId(324).productId,batches:1,gearTarget:0,gearInputs:{},
                crystalGear:2495,at:when}}}});
            const holding = Life.reconcileEquipmentInventory(kit(stamp));
            assert.equal(holding.inventory[2495].equippedCount,alreadyWorn?1:0,
                'a bought crystal input never replaces the wearable shield');
            assert.equal(holding.inventory[2495].amount,alreadyWorn?2:1,'the kept copy stays in the bag');
            assert.equal(Disposition.productionInputAmounts(kit(stamp))[2495],1,'the kit holds the shield from sale');
            assert(Life.reconcileEquipmentInventory(kit(stamp-31*60000)).inventory[2495].equippedCount>0,
                'gear an expired kit no longer holds becomes available to the ordinary equipment optimizer');
            const dropped = kit(stamp);
            delete dropped.stats.shotCraft.preparing.crystalGear;
            assert(Life.reconcileEquipmentInventory(dropped).inventory[2495].equippedCount>0,
                'gear abandoned by production becomes available to the ordinary equipment optimizer');
            console.log('PASS crystal gear held by the shot kit',JSON.stringify({alreadyWorn}));
        }
    } finally {
        await Database.close(); fs.rmSync(fixture.directory, { recursive: true, force: true });
    }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
