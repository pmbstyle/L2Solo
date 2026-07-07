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

    console.log('Bot travel realism checks passed');
} finally {
    global.setTimeout = originalSetTimeout;
    ShotStock.planForActor = originalPlanForActor;
    ShotStock.shotAmount = originalShotAmount;
    ShotStock.purchaseActorRestock = originalPurchaseActorRestock;
    BotBuffs.applyFullNewbieBlessing = originalApplyFullNewbieBlessing;
}
