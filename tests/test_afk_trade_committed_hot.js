const assert = require('assert');

const isolatedFixture = require('./helpers/isolatedSocialDatabase')('f1-afk-trade-committed-hot');
require('../src/Global');
isolatedFixture.assertConfigured(options.default);

const fixtureDatabase = invoke('Database');
const fixtureDatabaseMethods = { ...fixtureDatabase };

(async () => {
    try {
        // Lifecycle count/save readers use native queues outside Database.execute.
        // Initialize the complete disposable schema before installing unit facades.
        invoke('GameServer/DataCache').init();
        await new Promise(resolve => fixtureDatabase.init(resolve));

        const declaredCharacters = [
            [91, "bot91", "Seller91", 30, 0],
            [92, "bot91", "Seller9192", 30, 0],
            [93, "bot91", "Seller9193", 30, 0],
        ];
        for (const [id, account, name, level, classId] of declaredCharacters) {
            await fixtureDatabase.execute(['INSERT OR IGNORE INTO accounts(username,password) VALUES(?,?)',
                [account, 'fixture']]);
            await fixtureDatabase.execute([`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,
                sex,face,hair,hairColor,locX,locY,locZ) VALUES(?,?,?,?,0,?,100,100,0,0,0,0,0,0,0)`,
                [id, account, name, classId, level]]);
        }

        // H1 follow-up: an AFK trade commits, but the bot went hot while the cold job
        // awaited it, so no cold state is synced (the actor holds the result). The
        // job counts the trade as done, writes nothing for the bot and stops selling
        // from a bag that is the actor's now.
        const DataCache = invoke('GameServer/DataCache');
        const Database = invoke('Database');
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        const BuyStore = invoke('GameServer/Bot/Economy/ColdMarketBuyStoreService');
        const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const ListingPolicy = invoke('GameServer/Bot/Economy/MarketListingPolicy');

        DataCache.init();

        const seller = {
            characterId: 91, accountName: 'bot91', name: 'Seller91', level: 30, adena: 100, phase: 'cold', activity: 'shopping',
            currentRegion: 'Giran', inventory: { 57: { selfId: 57, name: 'Adena', amount: 100 },
                1864: { selfId: 1864, name: 'Stem', amount: 10 }, 1865: { selfId: 1865, name: 'Varnish', amount: 10 } },
            stats: {}, loc: { locX: 1, locY: 2, locZ: 3 }, vitals: {}, timing: {}
        };

        async function run() {
            Database.execute = () => Promise.resolve([]);
            Database.updateCharacterLocation = async () => {};
            Database.updateCharacterExperience = async () => {};
            Database.updateCharacterVitals = async () => {};
            Database.reconcileBotClanMembership = async () => ({ repairedMembers: 0, repairedParties: 0 });
            Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });
            // The bot chose to answer two buy ads in Giran (the side that acts travels).
            const line = (selfId) => ({ selfId, town: 'Giran', price: 60, count: 10 });
            ListingPolicy.evaluate = () => ({ answers: [
                { item: { selfId: 1864, name: 'Stem', count: 10, price: 50, kind: 'Other.Material' }, line: line(1864), count: 10 },
                { item: { selfId: 1865, name: 'Varnish', count: 10, price: 50, kind: 'Other.Material' }, line: line(1865), count: 10 }
            ] });
            AfkTrade.offerOf = (answered) => ({ selfId: answered.selfId, price: 60, count: 10, sourceType: 'afk_player_buy_store',
                store: { id: 7, ownerId: 9002 } });
            const sales = [];
            AfkTrade.sellToShop = (characterId, store, selfId) => {
                sales.push(selfId);
                return Promise.resolve({ ok: true, coldState: null });
            };

            await BotLifeState.upsertState({ ...seller, phase: 'hot' }, 'hot_activation');
            const result = await BuyStore.sellToBestBuyer(seller, 'Giran');
            assert.strictEqual(result.sold, true, 'a sale committed with a bot that went hot is a sale');
            assert.deepStrictEqual(sales, [1864], 'the job stops selling from the actor\'s bag');
            assert.strictEqual(BotLifeState.snapshot(91).phase, 'hot', 'nothing cold is written over the hot row');
            assert.strictEqual(result.state, seller, 'the job keeps its own state');

            // Activated after the sync's own hot check: the sync hands back a pending
            // cold state, the bot is hot all the same and the job stops.
            const lateHot = { ...seller, characterId: 93, name: 'Seller9193' };
            await BotLifeState.upsertState({ ...lateHot, phase: 'hot' }, 'hot_activation');
            assert.deepStrictEqual(AfkTrade.committedTrade({ coldState: { ...lateHot, phase: 'cold' } }, 93),
                { committed: true, hot: true, state: null }, 'a hot bot is hot even when a cold state came back');

            // A cold seller whose sync is lost is a failed sale, as before.
            await BotLifeState.upsertState({ ...seller, characterId: 92, phase: 'cold', name: 'Seller9192' }, 'seed');
            sales.length = 0;
            const lost = await BuyStore.sellToBestBuyer({ ...seller, characterId: 92, name: 'Seller9192' }, 'Giran');
            assert.strictEqual(lost.sold, false, 'a lost sync of a cold seller is no sale');
            assert.strictEqual(sales.length, 2);
            console.log('AFK trade committed with a hot bot checks passed');
        }

        await run().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
    } finally {
        Object.assign(fixtureDatabase, fixtureDatabaseMethods);
        await fixtureDatabase.close();
        require('node:fs').rmSync(isolatedFixture.directory, { recursive: true, force: true });
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
