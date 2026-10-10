const assert = require('assert');

const isolatedFixture = require('./helpers/isolatedSocialDatabase')('f1-cold-purchase-failure-hot-bot');
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
            [77, "bot77", "Buyer77", 40, 0],
            [86, "bot86", "Buyer86", 40, 55],
            [78, "bot78", "Buyer78", 40, 0],
        ];
        for (const [id, account, name, level, classId] of declaredCharacters) {
            await fixtureDatabase.execute(['INSERT OR IGNORE INTO accounts(username,password) VALUES(?,?)',
                [account, 'fixture']]);
            await fixtureDatabase.execute([`INSERT INTO characters(id,username,name,classId,race,level,maxHp,maxMp,
                sex,face,hair,hairColor,locX,locY,locZ) VALUES(?,?,?,?,0,?,100,100,0,0,0,0,0,0,0)`,
                [id, account, name, classId, level]]);
        }

        // H10: a cold purchase job awaits the AFK trade; meanwhile the bot is activated
        // (its row turns hot and belongs to the actor in the world). The AFK sync then
        // returns no cold state, the job fails, and the failure path used to write the
        // pre-trade state back as a cold row: the wallet rolled back while the items
        // had moved, and the hot actor lost its row. The failure path leaves a hot row
        // alone; a cold bot's failure is written as before. A trade that committed
        // while the bot went hot is a purchase: the actor holds the item.
        const DataCache = invoke('GameServer/DataCache');
        const Database = invoke('Database');
        const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
        const ColdMarketService = invoke('GameServer/Bot/Economy/ColdMarketService');
        const BotLifeState = invoke('GameServer/Bot/Population/BotLifeState');
        const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
        const GoalState = invoke('GameServer/Bot/Goals/GoalState');

        DataCache.init();

        const originals = {
            execute: Database.execute,
            updateCharacterLocation: Database.updateCharacterLocation,
            updateCharacterExperience: Database.updateCharacterExperience,
            updateCharacterVitals: Database.updateCharacterVitals,
            reconcileBotClanMembership: Database.reconcileBotClanMembership,
            reconcileBotClanGoals: Database.reconcileBotClanGoals,
            buyFromShop: AfkTrade.buyFromShop,
            bestOffer: MarketOpportunity.bestOffer,
            reserve: MarketOpportunity.reserve,
            clearGoal: GoalState.clear
        };

        const bot = (characterId, extra = {}) => ({
            characterId, accountName: `bot${characterId}`, name: `Buyer${characterId}`, level: 40, adena: 1000,
            phase: 'cold', activity: 'shopping', currentRegion: 'Giran',
            inventory: {
                57: { selfId: 57, name: 'Adena', amount: 1000 },
                1: { selfId: 1, name: 'Short Sword', amount: 1, equipped: true, slot: 7, rank: 'none', kind: 'Weapon.Sword' }
            },
            stats: {
                equipment: [{ selfId: 1, slot: 7, rank: 'none', kind: 'Weapon.Sword' }],
                equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 2, name: 'Long Sword', slot: 7 } },
                marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' }
            },
            loc: { locX: 80000, locY: 150000, locZ: -3466 }, vitals: {}, timing: {},
            ...extra
        });
        const goal = { type: 'upgrade_gear', status: 'active', target: { itemId: 2, itemName: 'Long Sword', itemSlot: 7 },
            plan: { expectedBenefit: 'market_search_for_weapon', marketTown: 'Giran' } };
        const afkOffer = { selfId: 2, itemName: 'Long Sword', price: 1000, sourceType: 'afk_player_store', store: { id: 5, ownerId: 9001 } };

        async function run() {
            Database.execute = () => Promise.resolve([]);
            Database.updateCharacterLocation = async () => {};
            Database.updateCharacterExperience = async () => {};
            Database.updateCharacterVitals = async () => {};
            Database.reconcileBotClanMembership = async () => ({ repairedMembers: 0, repairedParties: 0 });
            Database.reconcileBotClanGoals = async () => ({ repairedMembers: 0, repairedParties: 0 });
            const goalClears = [];
            GoalState.clear = (characterId) => { goalClears.push(characterId); return Promise.resolve(null); };
            MarketOpportunity.bestOffer = () => ({ ...afkOffer });
            MarketOpportunity.reserve = () => true;
            // The trade finds the bot hot: the AFK sync returns no cold state (H1).
            // A committed native trade reports its units and price; a purchase counts its units (71143511).
            AfkTrade.buyFromShop = () => Promise.resolve({ ok: true, coldState: null, amount: 1, totalPrice: afkOffer.price });

            // The bot was activated while the job ran: its row is hot.
            const hot = bot(77);
            await BotLifeState.upsertState({ ...hot, phase: 'hot', adena: 0, inventory: { 2: { selfId: 2, name: 'Long Sword', amount: 1 } } }, 'hot_activation');
            assert.strictEqual(BotLifeState.snapshot(77).phase, 'hot', 'fixture: the row is hot');
            // The trade committed; the actor holds the sword. The purchase counts as
            // done, and the job writes nothing over the hot row.
            const bought = await ColdMarketService.tryPurchase(hot, goal);
            assert.strictEqual(bought.purchased, true, 'a trade committed with a bot that went hot is a purchase');
            assert.strictEqual(BotLifeState.snapshot(77).phase, 'hot', 'the purchase must not write a cold row over a hot bot');
            assert.strictEqual(BotLifeState.snapshot(77).adena, 0, 'the hot row keeps its wallet');
            assert.notStrictEqual(bought.state, BotLifeState.snapshot(77), 'the job goes on with its own state, not the actor\'s row');

            // The blocked path (an offer the bot must not buy) is guarded the same way.
            const hotBlocked = bot(86, { stats: { classId: 55, role: 'dps',
                equipment: [{ selfId: 93, slot: 14, rank: 'd', kind: 'Weapon.Pole' }],
                equipmentPlan: { status: 'active', strategy: 'market', target: { selfId: 626, name: 'Bronze Shield', slot: 8 } },
                marketReturn: { loc: { locX: 100, locY: 200, locZ: -10 }, regionName: 'Field', spotId: 'field' } },
            inventory: { 57: { selfId: 57, name: 'Adena', amount: 100000 },
                93: { selfId: 93, name: 'Winged Spear', amount: 1, equipped: true, equippedCount: 1, equippedSlots: [14], slot: 14, rank: 'd', kind: 'Weapon.Pole' } },
            adena: 100000 });
            await BotLifeState.upsertState({ ...hotBlocked, phase: 'hot' }, 'hot_activation');
            MarketOpportunity.bestOffer = () => ({ selfId: 626, price: 24090, sourceType: 'npc' });
            const blocked = await ColdMarketService.tryPurchase(hotBlocked, { type: 'upgrade_gear', status: 'active',
                target: { itemId: 626, itemName: 'Bronze Shield', itemSlot: 8 }, plan: { expectedBenefit: 'market_search_for_gear', marketTown: 'Giran' } });
            assert.strictEqual(blocked.reason, 'incompatible_loadout', 'fixture: the shield is blocked');
            assert.strictEqual(BotLifeState.snapshot(86).phase, 'hot', 'a blocked purchase must not write a cold row over a hot bot');
            assert(!goalClears.includes(86), 'the hot bot\'s goal is left to the cold side, as its plan is');
            assert(!bought.wanted, 'no trade-chat wish for a hot bot');

            // A cold bot's failed purchase is written as before: it returns to its field.
            MarketOpportunity.bestOffer = () => ({ ...afkOffer });
            const cold = bot(78);
            await BotLifeState.upsertState(cold, 'seed');
            const coldFailed = await ColdMarketService.tryPurchase(cold, goal);
            assert.strictEqual(coldFailed.reason, 'offer_changed');
            assert.strictEqual(BotLifeState.snapshot(78).phase, 'cold');
            assert.strictEqual(BotLifeState.snapshot(78).activity, 'traveling', 'a cold bot without its purchase returns to farming');
            assert.strictEqual(BotLifeState.snapshot(78).stats.lastReason, 'market_no_offer_return');

            console.log('Cold purchase failure with a hot bot checks passed');
        }

        await run().catch((error) => {
            console.error(error);
            process.exitCode = 1;
        }).finally(() => {
            Object.assign(Database, {
                execute: originals.execute, updateCharacterLocation: originals.updateCharacterLocation,
                updateCharacterExperience: originals.updateCharacterExperience, updateCharacterVitals: originals.updateCharacterVitals,
                reconcileBotClanMembership: originals.reconcileBotClanMembership, reconcileBotClanGoals: originals.reconcileBotClanGoals
            });
            AfkTrade.buyFromShop = originals.buyFromShop;
            MarketOpportunity.bestOffer = originals.bestOffer;
            MarketOpportunity.reserve = originals.reserve;
            GoalState.clear = originals.clearGoal;
            // The outer fixture closes the native connection before retaining this exit code.
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
