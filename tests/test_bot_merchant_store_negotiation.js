const assert = require('assert');
require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotNegotiationService = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotMerchantStoreService = invoke('GameServer/Bot/Economy/BotMerchantStoreService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const ListingService = invoke('GameServer/Bot/Economy/ColdMarketListingService');
const ServerResponse = invoke('GameServer/Network/Response');
const World = invoke('GameServer/World/World');
const Item = invoke('GameServer/Item/Item');

function backpack(items) {
    return {
        items,
        fetchItems() { return this.items; },
        fetchItemRaw(id) { return this.items.find((item) => Number(item.fetchId()) === Number(id)); },
        fetchItemFromSelfId(id) { return this.items.find((item) => Number(item.fetchSelfId()) === Number(id)); }
    };
}

function playerActor(id, name) {
    return {
        fetchId: () => id,
        fetchName: () => name,
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchIsOnline: () => true
    };
}

function merchantActor(id, bag, initialStore) {
    let store = initialStore;
    let storeType = 1;
    let seated = true;
    return {
        backpack: bag,
        fetchId: () => id,
        fetchName: () => 'StorekeeperTest',
        fetchLocX: () => 0,
        fetchLocY: () => 0,
        fetchLocZ: () => 0,
        fetchDestId: () => 0,
        isDead: () => false,
        fetchPrivateStore: () => store,
        setPrivateStore: (next) => { store = next; },
        fetchPrivateStoreType: () => storeType,
        setPrivateStoreType: (next) => { storeType = next; },
        state: {
            fetchSeated: () => seated,
            setSeated: (next) => { seated = !!next; }
        }
    };
}

function decision(action, turnId, extra = {}) {
    return { action, confidence: 0.99, reason: 'merchant negotiation test', turnId, ...extra };
}

async function main() {
    const shieldSelfId = 500001;
    const shield = new Item(71001, {
        selfId: shieldSelfId,
        name: 'Test Bone Shield',
        kind: 'Armor.Shield',
        price: 100000,
        amount: 3,
        stackable: false,
        equipped: false,
        slot: 8
    });
    const objectIdCollision = new Item(shieldSelfId, {
        selfId: 500099,
        name: 'Unrelated Collision Item',
        kind: 'Other.Material',
        price: 10,
        amount: 1,
        stackable: true,
        equipped: false,
        slot: 0
    });
    const initialStore = {
        storeType: 1,
        revision: 7,
        title: 'Test Bone Shield x3 +2',
        town: 'Giran',
        items: [
            { objectId: 81001, selfId: shieldSelfId, name: 'Test Bone Shield', count: 3, price: 522450 },
            { objectId: 81002, selfId: 500002, name: 'Test Trident Edge', count: 16, price: 367350 }
        ]
    };
    const actor = merchantActor(72001, backpack([objectIdCollision, shield]), initialStore);
    const bot = {
        accountId: 'bot_storekeeper_test',
        plan: 'merchant',
        actor,
        persona: {
            primaryDrive: 'wealth',
            traits: { caution: 0.8, ambition: 0.6, assertiveness: 0.7 }
        },
        coldMarketState: {
            characterId: 72001,
            name: 'StorekeeperTest',
            phase: 'hot',
            activity: 'merchant',
            stats: {
                marketStore: {
                    id: 'store-72001',
                    storeType: 1,
                    revision: 7,
                    title: initialStore.title,
                    town: 'Giran',
                    items: initialStore.items.map((line) => ({ ...line }))
                }
            }
        },
        dataSendToOthers() {}
    };
    const player = { accountId: 'merchant_test_player', actor: playerActor(73001, 'BuyerTest') };
    const viewerPackets = [];
    const viewer = {
        accountId: 'viewer_test_player',
        actor: playerActor(73002, 'ViewerTest'),
        activeMerchantTrade: { merchant: actor, store: initialStore, revision: 7 },
        viewedPrivateStoreSeller: actor,
        dataSendToMe(packet) { viewerPackets.push(packet); }
    };

    const originalWorldUser = World.user;
    const originalUpsert = LifeState.upsertState;
    const originalRestoreAfterPartyFailure = ListingService.restoreAfterPartyFailure;
    const originalSnapshot = BotSocialMemory.getSnapshot;
    const responseNames = ['actionFailed', 'sitAndStand', 'charInfo', 'privateStoreMsg'];
    const originalResponses = Object.fromEntries(responseNames.map((name) => [name, ServerResponse[name]]));
    const savedStates = [];
    let failSave = false;
    let holdSave = false;
    let releaseSave = null;
    let failOpenBroadcast = false;
    try {
        World.user = { sessions: [player, viewer, bot] };
        LifeState.upsertState = async (state, reason) => {
            savedStates.push({ state, reason });
            if (holdSave) await new Promise((resolve) => { releaseSave = resolve; });
            return failSave ? null : state;
        };
        BotSocialMemory.getSnapshot = () => ({ trust: 0, familiarity: 0 });
        responseNames.forEach((name) => {
            ServerResponse[name] = () => {
                if (name === 'privateStoreMsg' && failOpenBroadcast) throw new Error('synthetic store broadcast failure');
                return [name];
            };
        });

        const context = BotNegotiationService.storeContext(bot, player);
        assert.strictEqual(context.id, 'store-72001');
        assert.strictEqual(context.revision, 7);
        assert.deepStrictEqual(context.lines.map((line) => ({
            selfId: line.selfId,
            count: line.count,
            unitPrice: line.unitPrice
        })), [{ selfId: shieldSelfId, count: 3, unitPrice: 522450 }]);
        assert(context.lines[0].minimumUnitPrice < context.lines[0].unitPrice);
        assert(context.lines[0].preferredUnitPrice >= context.lines[0].minimumUnitPrice);

        const actions = BotAgentTools.availableActions(bot);
        assert(actions.includes('quote_item'));
        assert(actions.includes('accept_price'));
        assert(!actions.includes('open_negotiated_trade'), 'merchant sales must not use native trade');

        const quoted = BotAgentTools.execute(
            bot,
            decision('quote_item', 'merchant-quote', {
                negotiationItemId: shieldSelfId,
                negotiationAmount: 1,
                negotiationPrice: 400000
            }),
            [],
            { playerSession: player, conversationTurn: { turnId: 'merchant-quote' } }
        );
        assert.strictEqual(quoted.applied, true);
        assert.strictEqual(quoted.negotiation.state, 'countered');
        assert.strictEqual(quoted.negotiation.itemObjectId, shield.fetchId(), 'listed selfId must not collide with another item objectId');
        assert.strictEqual(quoted.negotiation.itemSelfId, shieldSelfId);
        assert(quoted.negotiation.currentUnitPrice > 400000, 'server must counter an offer below its floor');
        assert.strictEqual(bot.botNegotiationReservations.size, 0, 'public merchant stock is never reserved for one buyer');

        const acceptedTotal = quoted.negotiation.minimumUnitPrice;
        assert.notStrictEqual(acceptedTotal, quoted.negotiation.currentTotalPrice, 'test must exercise accepting a new player offer');
        holdSave = true;
        failOpenBroadcast = true;
        const preparedWorldRevision = BotAgentTools.worldRevision(bot);
        const acceptContext = {
            playerSession: player,
            conversationTurn: { turnId: 'merchant-accept' },
            preparedWorldRevision
        };
        const acceptedPromise = BotAgentTools.execute(
            bot,
            decision('accept_price', 'merchant-accept', {
                negotiationPrice: acceptedTotal
            }),
            [],
            acceptContext
        );
        const replayPromise = BotAgentTools.execute(
            bot,
            decision('accept_price', 'merchant-accept', {
                negotiationPrice: acceptedTotal
            }),
            [],
            acceptContext
        );
        assert.strictEqual(typeof releaseSave, 'function', 'first async mutation must reach persistence before replay');
        holdSave = false;
        releaseSave();
        const [accepted, replayed] = await Promise.all([acceptedPromise, replayPromise]);
        assert.strictEqual(accepted.applied, true);
        assert.strictEqual(replayed.applied, true, 'same pending turn must replay instead of failing freshness');
        assert.strictEqual(replayed.reason, 'store_reopened');
        assert.strictEqual(accepted.reason, 'store_reopened');
        assert.strictEqual(accepted.negotiation.state, 'completed');
        assert.strictEqual(accepted.store.revision, 8);
        assert.deepStrictEqual(accepted.store.item, {
            selfId: shieldSelfId,
            name: 'Test Bone Shield',
            count: 1,
            unitPrice: acceptedTotal
        });
        assert.strictEqual(actor.fetchPrivateStoreType(), 1);
        assert.strictEqual(actor.state.fetchSeated(), true);
        assert.strictEqual(actor.fetchPrivateStore().revision, 8, 'broadcast failure must not roll back a committed store');
        assert.strictEqual(bot.coldMarketState.stats.marketStore.revision, 8);
        assert.strictEqual(actor.fetchPrivateStore().items.length, 2, 'unrelated store lines remain published');
        assert.strictEqual(actor.fetchPrivateStore().items[1].count, 16);
        assert.strictEqual(savedStates.length, 1);
        assert.strictEqual(savedStates[0].reason, 'merchant_negotiated_reprice');
        assert.strictEqual(savedStates[0].state.stats.marketStore.revision, 8);
        assert.strictEqual(savedStates[0].state.stats.marketStore.items[0].count, 1);
        assert.strictEqual(savedStates[0].state.stats.marketStore.items[0].price, acceptedTotal);
        assert.strictEqual(viewer.activeMerchantTrade, null, 'old client purchase windows are invalidated');
        assert.strictEqual(viewer.viewedPrivateStoreSeller, null);
        assert.strictEqual(viewerPackets.length, 1);
        assert.strictEqual(BotNegotiationService.activeSummary(bot), null);
        failOpenBroadcast = false;

        const stale = await BotMerchantStoreService.republish(bot, {
            storeId: 'store-72001',
            storeRevision: 7,
            itemSelfId: shieldSelfId,
            quantity: 1,
            unitPrice: 450000
        });
        assert.strictEqual(stale.ok, false);
        assert.strictEqual(stale.reason, 'store_changed');
        assert.strictEqual(actor.fetchPrivateStore().revision, 8);

        actor.fetchPrivateStore().activePurchases = 1;
        const busy = await BotMerchantStoreService.republish(bot, {
            storeId: 'store-72001',
            storeRevision: 8,
            itemSelfId: shieldSelfId,
            quantity: 1,
            unitPrice: 450000
        });
        assert.strictEqual(busy.ok, false);
        assert.strictEqual(busy.reason, 'store_busy');
        assert.strictEqual(actor.fetchPrivateStore().repricing, false);
        actor.fetchPrivateStore().activePurchases = 0;

        failSave = true;
        const failedSave = await BotMerchantStoreService.republish(bot, {
            storeId: 'store-72001',
            storeRevision: 8,
            itemSelfId: shieldSelfId,
            quantity: 1,
            unitPrice: 450000
        });
        assert.strictEqual(failedSave.ok, false);
        assert.strictEqual(failedSave.reason, 'store_persist_failed');
        assert.strictEqual(actor.fetchPrivateStore().revision, 8, 'failed persistence restores the published listing');
        assert.strictEqual(actor.fetchPrivateStoreType(), 1);
        assert.strictEqual(actor.state.fetchSeated(), true);

        failSave = false;
        actor.fetchPrivateStore().activePurchases = 1;
        let withdrawalResolved = false;
        const withdrawalPromise = BotMerchantStoreService.withdrawForParty(bot).then((result) => {
            withdrawalResolved = true;
            return result;
        });
        await new Promise((resolve) => setTimeout(resolve, 15));
        assert.strictEqual(withdrawalResolved, false, 'party withdrawal must wait for an active store transaction');
        actor.fetchPrivateStore().activePurchases = 0;
        const withdrawal = await withdrawalPromise;
        assert.strictEqual(withdrawal.ok, true);
        assert.strictEqual(withdrawal.withdrawn, true, 'an invited dynamic merchant must leave its market shift');
        assert.strictEqual(actor.fetchPrivateStoreType(), 0, 'party transition must clear the client private-store flag');
        assert.strictEqual(actor.fetchPrivateStore(), null, 'party transition must remove the stale store object too');
        assert.strictEqual(actor.state.fetchSeated(), false, 'the bot must stand before joining its player');
        assert.strictEqual(bot.plan, 'hunting');
        assert.strictEqual(bot.coldMarketState, null, 'party bot must no longer be maintained as a hot market store');
        assert.strictEqual(bot.coldLifeState.stats.marketStore, null, 'persisted market discovery must no longer expose the store');
        assert.strictEqual(savedStates.at(-1).reason, 'party_market_withdrawal');

        const restored = await BotMerchantStoreService.restoreAfterPartyFailure(bot, withdrawal);
        assert.strictEqual(restored.ok, true);
        assert.strictEqual(bot.plan, 'merchant', 'a failed attach must restore the previous merchant plan');
        assert.strictEqual(bot.coldMarketState.stats.marketStore.id, 'store-72001');
        assert.strictEqual(actor.fetchPrivateStore(), withdrawal.rollback.store, 'the same settled live store must be reopened');
        assert.strictEqual(actor.fetchPrivateStore().repricing, false);
        assert.strictEqual(actor.fetchPrivateStoreType(), 1);
        assert.strictEqual(actor.state.fetchSeated(), true);
        assert.strictEqual(savedStates.at(-1).reason, 'party_market_withdrawal_rollback');

        ListingService.restoreAfterPartyFailure = () => Promise.reject(new Error('forced rollback persistence failure'));
        bot.plan = 'hunting';
        bot.coldMarketState = null;
        actor.setPrivateStore(null);
        actor.setPrivateStoreType(0);
        actor.state.setSeated(false);
        const fallbackRestore = await BotMerchantStoreService.restoreAfterPartyFailure(bot, withdrawal);
        assert.strictEqual(fallbackRestore.ok, true, 'live merchant state must still be restored when rollback persistence rejects');
        assert.match(fallbackRestore.restoreWarning, /forced rollback persistence failure/);
        assert.strictEqual(bot.plan, 'merchant');
        assert.strictEqual(actor.fetchPrivateStore(), withdrawal.rollback.store);
        assert.strictEqual(actor.fetchPrivateStoreType(), 1);
        assert.strictEqual(actor.state.fetchSeated(), true);
    } finally {
        World.user = originalWorldUser;
        LifeState.upsertState = originalUpsert;
        ListingService.restoreAfterPartyFailure = originalRestoreAfterPartyFailure;
        BotSocialMemory.getSnapshot = originalSnapshot;
        responseNames.forEach((name) => { ServerResponse[name] = originalResponses[name]; });
        BotNegotiationService.reset();
    }

    console.log('Bot merchant store negotiation checks passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
