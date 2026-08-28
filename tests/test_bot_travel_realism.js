const assert = require('assert');

require('../src/Global');

const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');
const GettingBuffedState = invoke('GameServer/Bot/AI/States/GettingBuffedState');
const CompanionNavigationRecovery = invoke('GameServer/Bot/AI/CompanionNavigationRecovery');
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
        fetchName: () => 'TravelBot',
        fetchLevel: () => loc.level ?? 21,
        fetchKarma: () => loc.karma ?? 0
    };
}

const originalSetTimeout = global.setTimeout;
const originalPlanForActor = ShotStock.planForActor;
const originalShotAmount = ShotStock.shotAmount;
const originalPurchaseActorRestock = ShotStock.purchaseActorRestock;
const originalApplyFullNewbieBlessing = BotBuffs.applyFullNewbieBlessing;
const originalNeedsNewbieRefresh = BotBuffs.needsNewbieRefresh;

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

    const edgeGuideBot = bot({ locX: -83828, locY: 243227, locZ: -3723 });
    const edgeGuideSession = {
        plan: 'getting_buffed',
        preBuffPlan: 'hunting',
        preBuffLocation: { locX: -83000, locY: 242000, locZ: -3700 }
    };
    GettingBuffedState.tick(edgeGuideSession, edgeGuideBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(edgeGuideSession.plan, 'hunting', 'a companion just beyond the old 250-unit boundary should still receive the guide buff');
    assert.strictEqual(edgeGuideBot.moves.length, 1, 'a companion inside the guide interaction tolerance should only request its return movement');
    assert.deepStrictEqual(edgeGuideBot.moves[0].to, { locX: -83000, locY: 242000, locZ: -3700 });

    const deathRecoveryBot = bot({ locX: 46976, locY: 51511, locZ: -2976, level: 21 });
    const deathRecoverySession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        followPlayerSession: { actor: companionLeader },
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps',
            conditionalNewbieBuff: true,
            returnMode: 'teleport'
        }
    };
    const recoveryTeleports = [];
    const recoveryGenerics = {
        teleportTo(_session, _actor, target) { recoveryTeleports.push(target); }
    };
    GettingBuffedState.tick(deathRecoverySession, deathRecoveryBot, recoveryGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryTeleports.length, 1, 'an overleveled companion should skip the Newbie Guide and teleport back');
    assert.strictEqual(deathRecoverySession.plan, 'getting_buffed', 'the recovery state should remain active until the return teleport settles');
    deathRecoverySession.resumeAfterBuff.returnTeleportStartedAt = Date.now() - 2000;
    GettingBuffedState.tick(deathRecoverySession, deathRecoveryBot, recoveryGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryTeleports.length, 1, 'settling the return must not schedule duplicate teleports');
    assert.strictEqual(deathRecoverySession.plan, 'following', 'the companion should resume following after the return teleport settles');
    assert.strictEqual(deathRecoverySession.partyCompanion, true, 'the full town-return flow must keep party membership');

    let recoveryNeedsBuff = true;
    let recoveryBuffsApplied = 0;
    BotBuffs.needsNewbieRefresh = () => recoveryNeedsBuff;
    BotBuffs.applyFullNewbieBlessing = () => {
        recoveryNeedsBuff = false;
        recoveryBuffsApplied += 1;
        return { buffs: ['windwalk', 'shield', 'haste'], expiresAt: Date.now() + 60000 };
    };
    const lowLevelRecoveryBot = bot({ locX: -84081, locY: 243227, locZ: -3723, level: 10 });
    const lowLevelRecoverySession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        followPlayerSession: { actor: companionLeader },
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps',
            conditionalNewbieBuff: true,
            returnMode: 'teleport'
        }
    };
    const lowLevelRecoveryTeleports = [];
    GettingBuffedState.tick(lowLevelRecoverySession, lowLevelRecoveryBot, {
        teleportTo(_session, _actor, target) { lowLevelRecoveryTeleports.push(target); }
    }, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say() {}
    });
    assert.strictEqual(recoveryBuffsApplied, 1, 'an eligible dead companion should refresh cleared Newbie Guide buffs before returning');
    assert.strictEqual(lowLevelRecoveryTeleports.length, 1, 'the rebuffed companion should teleport back instead of walking across the world');

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

    const unreachableGuideSession = {
        plan: 'getting_buffed',
        partyCompanion: true,
        resumeAfterBuff: {
            plan: 'following',
            followPlayerSession: { actor: companionLeader },
            partyCompanion: true,
            botStay: false,
            stayLocation: null,
            role: 'dps'
        },
        lastPathfinding: {
            requestedTo: { locX: -84081, locY: 243227, locZ: -3723 },
            routeUsable: false,
            at: Date.now()
        }
    };
    unreachableGuideSession.companionNavigationRecovery = {
        key: CompanionNavigationRecovery.targetKey('newbie_guide', unreachableGuideSession.lastPathfinding.requestedTo),
        failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1,
        lastFailureAt: 0,
        retryAt: 0
    };
    const unreachableGuideBot = bot({ locX: -83800, locY: 243227, locZ: -3723 });
    const unreachableGuideMessages = [];
    GettingBuffedState.tick(unreachableGuideSession, unreachableGuideBot, noTeleportGenerics, {
        getClosestNewbieGuide: () => ({ locX: -84081, locY: 243227, locZ: -3723 }),
        say(_session, text) { unreachableGuideMessages.push(text); }
    });
    assert.strictEqual(unreachableGuideSession.plan, 'following', 'an exhausted guide route should return the companion to follow instead of hanging');
    assert.strictEqual(unreachableGuideSession.roleDecision.reason, 'newbie_guide_route_unreachable');
    assert(unreachableGuideMessages.some((text) => text.includes('retry later')), 'an exhausted guide route should be visible to the party');

    const unreachableShopTarget = {
        actorId: null,
        name: 'Giran general shop',
        locX: 1000,
        locY: 1000,
        locZ: -100,
        town: 'Giran'
    };
    const unreachableShopSession = {
        plan: 'shopping',
        partyCompanion: true,
        followPlayerSession: { actor: shoppingLeader },
        companionShopping: { kind: 'restock_shots' },
        resumeAfterShopping: { plan: 'following', followPlayerSession: { actor: shoppingLeader } },
        shoppingTarget: unreachableShopTarget,
        lastPathfinding: {
            requestedTo: unreachableShopTarget,
            routeUsable: false,
            at: Date.now()
        }
    };
    unreachableShopSession.companionNavigationRecovery = {
        key: CompanionNavigationRecovery.targetKey('shopping', unreachableShopTarget),
        failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1,
        lastFailureAt: 0,
        retryAt: 0
    };
    const unreachableShopBot = bot({ locX: 0, locY: 0, locZ: -100 });
    const unreachableShopMessages = [];
    ShoppingState.tick(unreachableShopSession, unreachableShopBot, noTeleportGenerics, {
        say(_session, text) { unreachableShopMessages.push(text); },
        getClosestTown: () => ({ name: 'Dion', x: 1000, y: 1000, z: -100 })
    });
    assert.strictEqual(unreachableShopSession.plan, 'following', 'an exhausted shop route should return the companion to follow');
    assert.strictEqual(unreachableShopSession.companionShopping, undefined, 'an exhausted shop route should not leave a stale shopping plan');
    assert.strictEqual(unreachableShopSession.roleDecision.reason, 'shopping_route_unreachable');
    assert(unreachableShopMessages.some((text) => text.includes('retry later')), 'an exhausted shop route should be visible to the party');

    const buyerTarget = {
        actorId: 9001,
        name: 'BuyerBot',
        locX: 9000,
        locY: 9000,
        locZ: -100,
        town: 'Giran'
    };
    const buyerFallbackSession = {
        plan: 'shopping',
        partyCompanion: true,
        followPlayerSession: { actor: shoppingLeader },
        companionShopping: { kind: 'sell_resources' },
        resumeAfterShopping: { plan: 'following', followPlayerSession: { actor: shoppingLeader } },
        shoppingTarget: buyerTarget,
        lastPathfinding: {
            requestedTo: buyerTarget,
            routeUsable: false,
            at: Date.now()
        }
    };
    buyerFallbackSession.companionNavigationRecovery = {
        key: CompanionNavigationRecovery.targetKey('shopping', buyerTarget),
        failures: CompanionNavigationRecovery.MAX_ROUTE_FAILURES - 1,
        lastFailureAt: 0,
        retryAt: 0
    };
    const buyerFallbackBot = bot({ locX: 0, locY: 0, locZ: -100 });
    ShoppingState.tick(buyerFallbackSession, buyerFallbackBot, noTeleportGenerics, {
        say() {},
        getClosestTown: () => ({ name: 'Giran', x: 1000, y: 1000, z: -100 })
    });
    assert.strictEqual(buyerFallbackSession.plan, 'shopping', 'an unreachable player buyer should fall back to the town shop');
    assert.strictEqual(buyerFallbackSession.shoppingTarget.actorId, null, 'buyer fallback should clear the unreachable player-store target');
    assert.strictEqual(buyerFallbackSession.shoppingTarget.name, 'Giran general shop');

    console.log('Bot travel realism checks passed');
} finally {
    global.setTimeout = originalSetTimeout;
    ShotStock.planForActor = originalPlanForActor;
    ShotStock.shotAmount = originalShotAmount;
    ShotStock.purchaseActorRestock = originalPurchaseActorRestock;
    BotBuffs.applyFullNewbieBlessing = originalApplyFullNewbieBlessing;
    BotBuffs.needsNewbieRefresh = originalNeedsNewbieRefresh;
}
