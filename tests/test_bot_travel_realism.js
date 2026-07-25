const assert = require('assert');

require('../src/Global');

const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const GettingBuffedState = invoke('GameServer/Bot/AI/States/GettingBuffedState');
const ShotStock = invoke('GameServer/Inventory/ShotStock');
const BotBuffs = invoke('GameServer/Bot/AI/BotBuffs');

function bot(loc = {}) {
    return {
        locX: loc.locX ?? 0,
        locY: loc.locY ?? 0,
        locZ: loc.locZ ?? 0,
        moves: [],
        unselected: false,
        fetchLocX() { return this.locX; },
        fetchLocY() { return this.locY; },
        fetchLocZ() { return this.locZ; },
        moveTo(data) { this.moves.push(data); },
        unselect() { this.unselected = true; },
        state: {
            inMotion: () => false
        },
        fetchId: () => 2000099,
        fetchName: () => 'TravelBot'
    };
}

const originalSetTimeout = global.setTimeout;
const originalPlanForActor = ShotStock.planForActor;
const originalShotAmount = ShotStock.shotAmount;
const originalPurchaseActorRestock = ShotStock.purchaseActorRestock;
const originalApplyFullNewbieBlessing = BotBuffs.applyFullNewbieBlessing;

try {
    global.setTimeout = (fn) => {
        fn();
        return 0;
    };

    ShotStock.planForActor = () => ({ selfId: 1835, price: 1, kind: 'soulshot', rank: 'none', name: 'Soulshot: No Grade' });
    ShotStock.shotAmount = () => 0;
    ShotStock.purchaseActorRestock = () => Promise.resolve({ ok: true, delta: 10, cost: 10 });

    const shopper = bot({ locX: 1000, locY: 1000, locZ: -100 });
    const shoppingSession = {
        preShopLocation: { locX: 2000, locY: 2100, locZ: -120 },
        partyCompanion: false,
        dataSendToOthers() {}
    };
    const noTeleportGenerics = {
        teleportTo() {
            throw new Error('shopping return should move instead of teleporting');
        }
    };

    ShoppingState.scheduleRestock(shoppingSession, shopper, noTeleportGenerics, { say() {} });
    assert.strictEqual(shopper.moves.length, 1, 'shopping return should issue a normal movement');
    assert.deepStrictEqual(shopper.moves[0].to, { locX: 2000, locY: 2100, locZ: -120 });
    assert.strictEqual(shoppingSession.preShopLocation, undefined);

    BotBuffs.applyFullNewbieBlessing = () => ({ buffs: [], expiresAt: Date.now() + 60000 });

    const buffBot = bot({ locX: -84081, locY: 243227, locZ: -3723 });
    const buffSession = {
        plan: 'getting_buffed',
        preBuffPlan: 'hunting',
        preBuffLocation: { locX: -83000, locY: 242000, locZ: -3700 }
    };
    GettingBuffedState.tick(buffSession, buffBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });

    assert.strictEqual(buffBot.unselected, true, 'buff return should clear the old target');
    assert.strictEqual(buffBot.moves.length, 1, 'buff return should issue a normal movement');
    assert.deepStrictEqual(buffBot.moves[0].to, { locX: -83000, locY: 242000, locZ: -3700 });
    assert.strictEqual(buffSession.plan, 'hunting');

    const companionLeader = {
        fetchIsOnline: () => true,
        fetchLocX: () => -84150,
        fetchLocY: () => 243180,
        fetchLocZ: () => -3723
    };
    const companionBot = bot({ locX: -84081, locY: 243227, locZ: -3723 });
    const companionSession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps'
        }
    };
    GettingBuffedState.tick(companionSession, companionBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });

    assert.strictEqual(companionSession.plan, 'following', 'companion should resume following after the Newbie Guide buffs it');
    assert.strictEqual(companionBot.moves.length, 1, 'buffed companion should move back to the player');
    assert(Math.abs(companionBot.moves[0].to.locX - companionLeader.fetchLocX()) <= 60, 'companion return should target the player vicinity');
    assert(Math.abs(companionBot.moves[0].to.locY - companionLeader.fetchLocY()) <= 60, 'companion return should target the player vicinity');
    assert.strictEqual(companionBot.moves[0].to.locZ, companionLeader.fetchLocZ());

    const shoppingLeader = {
        fetchIsOnline: () => true,
        fetchLocX: () => -84020,
        fetchLocY: () => 243150,
        fetchLocZ: () => -3723
    };
    const shoppingBot = bot({ locX: -84081, locY: 243227, locZ: -3723 });
    const shoppingCompanionSession = {
        plan: 'shopping',
        partyCompanion: true,
        followPlayerSession: { actor: shoppingLeader },
        companionShopping: { kind: 'restock_shots' },
        resumeAfterShopping: { plan: 'following', followPlayerSession: { actor: shoppingLeader } },
        dataSendToOthers() {}
    };
    ShoppingState.scheduleRestock(shoppingCompanionSession, shoppingBot, noTeleportGenerics, { say() {} });

    assert.strictEqual(shoppingCompanionSession.plan, 'following', 'companion should resume following after its town errand');
    assert.strictEqual(shoppingCompanionSession.companionShopping, undefined, 'completed town errand should not leave a shopping state behind');
    assert.strictEqual(shoppingBot.moves.length, 1, 'companion should walk back to the player after its town errand');
    assert.deepStrictEqual(shoppingBot.moves[0].to, {
        locX: shoppingLeader.fetchLocX(), locY: shoppingLeader.fetchLocY(), locZ: shoppingLeader.fetchLocZ()
    });

    console.log('Bot travel realism checks passed');
} finally {
    global.setTimeout = originalSetTimeout;
    ShotStock.planForActor = originalPlanForActor;
    ShotStock.shotAmount = originalShotAmount;
    ShotStock.purchaseActorRestock = originalPurchaseActorRestock;
    BotBuffs.applyFullNewbieBlessing = originalApplyFullNewbieBlessing;
}
