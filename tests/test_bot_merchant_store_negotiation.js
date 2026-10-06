const assert = require('assert');
require('../src/Global');

const BotAgentTools = invoke('GameServer/Bot/AI/BotAgentTools');
const BotNegotiationService = invoke('GameServer/Bot/Economy/BotNegotiationService');
const BotMerchantStoreService = invoke('GameServer/Bot/Economy/BotMerchantStoreService');
const BotSocialMemory = invoke('GameServer/Bot/AI/BotSocialMemory');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
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
    const originalSnapshot = BotSocialMemory.getSnapshot;
    const responseNames = ['actionFailed', 'sitAndStand', 'charInfo', 'privateStoreMsg'];
    const originalResponses = Object.fromEntries(responseNames.map((name) => [name, ServerResponse[name]]));
    const savedStates = [];
    try {
        World.user = { sessions: [player, viewer, bot] };
        LifeState.upsertState = async (state, reason) => {
            savedStates.push({ state, reason });
            return state;
        };
        BotSocialMemory.getSnapshot = () => ({ trust: 0, familiarity: 0 });
        responseNames.forEach((name) => {
            ServerResponse[name] = () => {
                return [name];
            };
        });

        // A merchant's live store that is not a board shop has fixed prices:
        // the bots' stalls that haggled went with the board (step 3.3); a
        // board shop haggles through its projection (test_bot_afk_sell_reprice).
        assert.strictEqual(BotNegotiationService.storeContext(bot, player), null);
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
        assert.notStrictEqual(quoted.applied, true, 'a fixed-price store does not negotiate');
        assert.strictEqual(actor.fetchPrivateStore().revision, 7);
        assert.strictEqual(savedStates.length, 0);

        // An invited merchant leaves its store for the party, once its sale
        // in progress settled, and gets it back when the attach fails.
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
        assert.strictEqual(withdrawal.withdrawn, true, 'an invited merchant must leave its store');
        assert.strictEqual(actor.fetchPrivateStoreType(), 0, 'party transition must clear the client private-store flag');
        assert.strictEqual(actor.fetchPrivateStore(), null, 'party transition must remove the stale store object too');
        assert.strictEqual(actor.state.fetchSeated(), false, 'the bot must stand before joining its player');
        assert.strictEqual(bot.plan, 'hunting');
        assert.strictEqual((bot.coldLifeState?.stats || bot.decisionStats).decisionSeq, 1,
            'closing the own store raises one town decision');
        assert.strictEqual((bot.coldLifeState?.stats || bot.decisionStats).activityLeaf, 0);
        assert.strictEqual(viewer.activeMerchantTrade, null, 'old client purchase windows are invalidated');
        assert.strictEqual(savedStates.length, 0, 'a live store has nothing persisted to withdraw');

        const restored = await BotMerchantStoreService.restoreAfterPartyFailure(bot, withdrawal);
        assert.strictEqual(restored.ok, true);
        assert.strictEqual(bot.plan, 'merchant', 'a failed attach must restore the previous merchant plan');
        assert.strictEqual(actor.fetchPrivateStore(), withdrawal.rollback.store, 'the same settled live store must be reopened');
        assert.strictEqual(actor.fetchPrivateStore().repricing, false);
        assert.strictEqual(actor.fetchPrivateStoreType(), 1);
        assert.strictEqual(actor.state.fetchSeated(), true);
    } finally {
        World.user = originalWorldUser;
        LifeState.upsertState = originalUpsert;
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
