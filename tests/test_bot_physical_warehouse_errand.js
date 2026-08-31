const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const World = invoke('GameServer/World/World');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const ShoppingState = invoke('GameServer/Bot/AI/States/ShoppingState');

DataCache.init();

const originals = {
    npc: World.npc,
    plan: TownNpcApproach.plan,
    reset: TownNpcApproach.reset,
    depositAtWarehouse: ShoppingState.depositAtWarehouse
};

function materialItem() {
    return {
        fetchId: () => 501,
        fetchSelfId: () => 1870,
        fetchName: () => 'Animal Bone',
        fetchAmount: () => 20,
        fetchKind: () => 'Other.Material',
        fetchRank: () => 'none',
        fetchEquipped: () => false,
        fetchStackable: () => true,
        fetchEnchantLevel: () => 0
    };
}

function npcFrom(row, index = 0) {
    return {
        fetchId: () => 910001 + index,
        fetchSelfId: () => row.npcSelfId,
        fetchName: () => row.name,
        fetchTitle: () => row.title,
        fetchLocX: () => row.locX,
        fetchLocY: () => row.locY,
        fetchLocZ: () => row.locZ,
        fetchHead: () => row.head
    };
}

try {
    const warehouseRows = TownServiceCatalog.rowsForTown('Giran', TownServiceCatalog.ROLES.WAREHOUSE);
    const warehouseRow = warehouseRows[0];
    const sellerRow = TownServiceCatalog.rowsForTown('Giran', TownServiceCatalog.ROLES.GENERIC_MERCHANT)[0];
    assert(warehouseRow && sellerRow, 'Giran must expose both real service roles');

    const warehouseNpcs = warehouseRows.map(npcFrom);
    World.npc = { spawns: warehouseNpcs };
    const moves = [];
    const bot = {
        fetchId: () => 920001,
        fetchName: () => 'WarehouseRouteProbe',
        fetchLocX: () => 83396,
        fetchLocY: () => 147904,
        fetchLocZ: () => -3400,
        backpack: {
            items: [materialItem()],
            fetchItems() { return this.items; }
        },
        state: {
            inMotion: () => false,
            fetchTowards: () => false,
            fetchCasts: () => false
        },
        moveTo: (request) => moves.push(request)
    };
    const sellerTarget = TownServiceCatalog.targetFromRow(
        sellerRow,
        TownServiceCatalog.ROLES.GENERIC_MERCHANT,
        { worldSpawns: [] }
    );
    const session = {
        actor: bot,
        plan: 'shopping',
        coldLifeState: { characterId: bot.fetchId(), inventory: {}, stats: {} },
        shoppingTarget: sellerTarget
    };
    const BotAI = {
        getClosestTown: () => ({ name: 'Giran', locX: 83396, locY: 147904, locZ: -3400 }),
        say() {}
    };

    TownNpcApproach.plan = (_session, _bot, target) => ({
        ready: false,
        phase: 'interaction',
        destination: target,
        arrivalRadius: 16
    });
    TownNpcApproach.reset = () => {};
    ShoppingState.tick(session, bot, null, BotAI);

    assert.strictEqual(session.shoppingServicePhase, 'warehouse',
        'a normal hot shopping trip with protected items must start with the warehouse phase');
    assert.strictEqual(session.shoppingTarget.serviceRole, TownServiceCatalog.ROLES.WAREHOUSE);
    const selectedWarehouseNpc = warehouseNpcs.find((npc) => (
        Number(npc.fetchSelfId()) === Number(session.shoppingTarget.npcSelfId)
    ));
    assert.strictEqual(session.shoppingTarget.actorId, selectedWarehouseNpc.fetchId(),
        'the warehouse phase must target the exact live keeper actor');
    assert.strictEqual(session.shoppingAfterWarehouseTarget, sellerTarget,
        'the selected merchant must wait until the physical warehouse visit finishes');
    assert.strictEqual(moves.length, 1, 'the hot bot must request movement to the warehouse keeper');

    let depositedAt = null;
    TownNpcApproach.plan = () => ({ ready: true, phase: 'interaction' });
    ShoppingState.depositAtWarehouse = (_session, _bot, _generics, _ai, target) => {
        depositedAt = target;
    };
    session.shoppingDoneAnnounced = false;
    ShoppingState.tick(session, bot, null, BotAI);
    assert.strictEqual(depositedAt, session.shoppingTarget,
        'reaching the warehouse phase must invoke deposit against that keeper, not the later seller');

    const heinePoint = { locX: 111386, locY: 219413, locZ: -3544 };
    assert.strictEqual(
        TownServiceCatalog.rowsForTown('Heine', TownServiceCatalog.ROLES.SELLER).length,
        0,
        'the test fixture must retain Heine as a real local-service datapack gap'
    );
    const nearestRealSeller = TownServiceCatalog.targetNear(
        TownServiceCatalog.ROLES.SELLER,
        heinePoint,
        { maxDistance: Infinity, worldSpawns: [] }
    );
    assert(nearestRealSeller?.npcSelfId,
        'a town without a local seller must resolve another real NPC instead of a fabricated town-center shop');
    assert.notStrictEqual(nearestRealSeller.town, 'Heine');

    console.log('Physical warehouse errand checks passed');
} finally {
    World.npc = originals.npc;
    TownNpcApproach.plan = originals.plan;
    TownNpcApproach.reset = originals.reset;
    ShoppingState.depositAtWarehouse = originals.depositAtWarehouse;
}
