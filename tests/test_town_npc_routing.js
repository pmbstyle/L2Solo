const assert = require('assert');

require('../src/Global');

const DataCache = invoke('GameServer/DataCache');
const GeodataEngine = invoke('GameServer/Geodata/GeodataEngine');
const MarketOpportunity = invoke('GameServer/Bot/Economy/MarketOpportunity');
const NpcShopBuyLists = invoke('GameServer/World/Generics/NpcShopBuyLists');
const TownNpcCatalog = invoke('GameServer/Bot/Economy/TownNpcCatalog');
const TownServiceCatalog = invoke('GameServer/Bot/Economy/TownServiceCatalog');
const TownNpcApproach = invoke('GameServer/Bot/AI/TownNpcApproach');
const TownRespawn = invoke('GameServer/World/TownRespawn');

DataCache.init();

const rows = TownNpcCatalog.rows();
assert(Object.isFrozen(rows), 'the generated town NPC catalog must be immutable');
assert(rows.length >= 60, 'the datapack should expose the ordinary city shop network');
rows.forEach((row) => {
    const town = TownRespawn.getClosestTown(row.locX, row.locY, row.locZ);
    assert.strictEqual(row.town, town.name, `NPC ${row.npcSelfId} must use its spawn town`);
    assert(Math.hypot(row.locX - town.locX, row.locY - town.locY) <= TownNpcCatalog.MAX_TOWN_DISTANCE,
        `NPC ${row.npcSelfId} must be inside the bounded town catalog radius`);
    assert(NpcShopBuyLists.fetchForNpc(row.npcSelfId).length > 0,
        `NPC ${row.npcSelfId} must own a real buy list`);
    assert(Number.isFinite(row.head), `NPC ${row.npcSelfId} must retain its spawn heading for door-side routing`);
});

const warehouseRows = TownServiceCatalog.rows(TownServiceCatalog.ROLES.WAREHOUSE);
const gatekeeperRows = TownServiceCatalog.rows(TownServiceCatalog.ROLES.GATEKEEPER);
const genericMerchantRows = TownServiceCatalog.rows(TownServiceCatalog.ROLES.GENERIC_MERCHANT);
assert(warehouseRows.length >= 40, 'the shared service catalog must include the datapack warehouse network');
assert(gatekeeperRows.length >= 14, 'the shared service catalog must include the datapack gatekeeper network');
assert(genericMerchantRows.length >= 60,
    'ordinary town errands must retain broad generic merchant coverage');
genericMerchantRows.forEach((row) => {
    assert(TownServiceCatalog.GENERIC_MERCHANT_TITLES.has(row.title),
        `${row.name} must have an explicitly generic merchant title`);
    assert(row.roles.includes(TownServiceCatalog.ROLES.SELLER),
        `${row.name} must remain part of the complete item-specific seller catalog`);
});
warehouseRows.forEach((row) => {
    assert(/^Warehouse (Keeper|Chief|Freightman)$/i.test(row.title),
        `${row.name} must be classified as warehouse service from the real NPC title`);
    assert(row.roles.includes(TownServiceCatalog.ROLES.WAREHOUSE));
});
gatekeeperRows.forEach((row) => assert(row.roles.includes(TownServiceCatalog.ROLES.GATEKEEPER)));

const pano = TownServiceCatalog.rowsForTown('Floran Village', TownServiceCatalog.ROLES.SELLER)
    .find((row) => Number(row.npcSelfId) === 7078);
assert(pano, 'the Floran restart region must classify Pano as a local seller');
assert.strictEqual(pano.name, 'Pano');
assert(TownServiceCatalog.rowsForTown('Floran Village', TownServiceCatalog.ROLES.WAREHOUSE).length > 0,
    'the corrected Floran region must also expose its real warehouse keeper');

const cooper = TownServiceCatalog.rowsForTown('Giran', TownServiceCatalog.ROLES.SELLER)
    .find((row) => Number(row.npcSelfId) === 7829);
assert(cooper?.roles.includes(TownServiceCatalog.ROLES.SELLER),
    'Cooper must remain available for item-specific pet shop purchases');
assert(!cooper.roles.includes(TownServiceCatalog.ROLES.GENERIC_MERCHANT),
    'a Pet Manager must not be a generic sell-junk or restock destination');
assert(MarketOpportunity.npcOffers(2505, 'Giran').some((offer) => Number(offer.sourceId) === 7829),
    'excluding Pet Managers from generic errands must not remove their real item offers');
const nearestGenericToCooper = TownServiceCatalog.targetFor(
    TownServiceCatalog.ROLES.GENERIC_MERCHANT,
    'Giran',
    { from: cooper, worldSpawns: [] }
);
assert(nearestGenericToCooper && Number(nearestGenericToCooper.npcSelfId) !== 7829,
    'a generic errand beside Cooper must select an ordinary merchant instead');

const specializedPetManagers = rows.filter((row) => row.title === 'Pet Manager');
assert.strictEqual(specializedPetManagers.length, 7, 'the datapack pet shop network must remain visible');
specializedPetManagers.forEach((row) => assert(
    !row.roles.includes(TownServiceCatalog.ROLES.GENERIC_MERCHANT),
    `${row.name} must stay specialized`
));

const townsWithoutSellers = Object.values(TownRespawn.towns)
    .map((town) => town.name)
    .filter((town) => TownServiceCatalog.rowsForTown(town, TownServiceCatalog.ROLES.SELLER).length === 0);
assert.deepStrictEqual(townsWithoutSellers, ['Heine'],
    'missing local services must remain explicit datapack gaps instead of fabricated town-center NPCs');
const townsWithoutGenericMerchants = Object.values(TownRespawn.towns)
    .map((town) => town.name)
    .filter((town) => TownServiceCatalog.rowsForTown(town, TownServiceCatalog.ROLES.GENERIC_MERCHANT).length === 0);
assert.deepStrictEqual(townsWithoutGenericMerchants, ['Heine'],
    'specialization filtering must not create new town coverage gaps');

const expectedTown = new Map([
    [7315, 'Gludin'],
    [7060, 'Dion'],
    [7135, 'Dark Elven Village'],
    [7147, 'Elven Village'],
    [7831, "Hunter's Village"]
]);
expectedTown.forEach((town, npcSelfId) => {
    assert(rows.some((row) => row.npcSelfId === npcSelfId && row.town === town),
        `NPC ${npcSelfId} must resolve to ${town} from its actual spawn`);
});

const lectorOffer = MarketOpportunity.npcOffers(1, 'Talking Island')
    .find((offer) => Number(offer.sourceId) === 7001);
assert(lectorOffer, 'Talking Island must expose Lector as a real Short Sword source');
assert.strictEqual(lectorOffer.sourceName, 'Lector');
assert.deepStrictEqual(
    { locX: lectorOffer.locX, locY: lectorOffer.locY, locZ: lectorOffer.locZ },
    { locX: -86385, locY: 243267, locZ: -3717 },
    'NPC offers must carry the physical shop coordinates'
);

GeodataEngine.init();
const townCenter = TownRespawn.getClosestTown(-84108, 244604, -3729);
const townsByName = new Map(Object.values(TownRespawn.towns || {})
    .map((town) => [town.name, town]));
const routeKey = (seller) => `${seller.town}:${seller.npcSelfId}:${seller.locX}:${seller.locY}:${seller.locZ}`;
const reachable = new Map();
const frontReachable = new Map();
const unreachable = [];
for (const seller of rows) {
    const town = townsByName.get(seller.town);
    assert(town, `${seller.town} must have a town respawn origin for route validation`);
    const path = GeodataEngine.findPath(
        town.locX,
        town.locY,
        town.locZ,
        seller.locX,
        seller.locY,
        seller.locZ,
        120000,
        { debug: false, goalRadius: 240, goalZTolerance: 64 }
    );
    reachable.set(routeKey(seller), !!path?.length);

    const approach = TownNpcApproach.pointsFor(seller);
    assert(approach, `${seller.town} ${seller.name} must expose heading-derived approach points`);
    assert(
        GeodataEngine.hasLineOfSight(
            approach.interaction.locX,
            approach.interaction.locY,
            approach.interaction.locZ,
            seller.locX,
            seller.locY,
            seller.locZ
        ),
        `${seller.town} ${seller.name} interaction point must be on a visible side of the NPC`
    );
    const stagingPath = GeodataEngine.findPath(
        town.locX,
        town.locY,
        town.locZ,
        approach.staging.locX,
        approach.staging.locY,
        approach.staging.locZ,
        120000,
        { debug: false, goalRadius: TownNpcApproach.STAGING_ARRIVAL_RADIUS, goalZTolerance: 64 }
    );
    const interactionPath = stagingPath ? null : GeodataEngine.findPath(
        town.locX,
        town.locY,
        town.locZ,
        approach.interaction.locX,
        approach.interaction.locY,
        approach.interaction.locZ,
        120000,
        { debug: false, goalRadius: TownNpcApproach.INTERACTION_ARRIVAL_RADIUS, goalZTolerance: 64 }
    );
    frontReachable.set(routeKey(seller), !!stagingPath?.length || !!interactionPath?.length);
    if (!path?.length) {
        unreachable.push(seller);
        continue;
    }
    assert(frontReachable.get(routeKey(seller)),
        `${seller.town} ${seller.name} needs a reachable front-side waypoint whenever the NPC itself is reachable`);
    const arrived = path[path.length - 1];
    assert(Math.hypot(arrived.locX - seller.locX, arrived.locY - seller.locY) <= 240,
        `${seller.town} ${seller.name} route must stop inside the interaction radius`);
}

unreachable.forEach((seller) => {
    NpcShopBuyLists.fetchForNpc(seller.npcSelfId).forEach((item) => {
        const alternative = MarketOpportunity.npcOffers(item.selfId, seller.town)
            .filter((offer) => Number(offer.sourceId) !== Number(seller.npcSelfId))
            .some((offer) => reachable.get(routeKey({
                town: seller.town,
                npcSelfId: offer.sourceId,
                locX: offer.locX,
                locY: offer.locY,
                locZ: offer.locZ
            })) === true);
        assert(alternative,
            `${seller.town} item ${item.selfId} needs a reachable alternative to ${seller.name}`);
    });
});

const lectorPath = GeodataEngine.findPath(
    townCenter.locX,
    townCenter.locY,
    townCenter.locZ,
    lectorOffer.locX,
    lectorOffer.locY,
    lectorOffer.locZ,
    120000,
    { debug: false, goalRadius: 240, goalZTolerance: 64 }
);
assert.notDeepStrictEqual(lectorPath[lectorPath.length - 1], {
    locX: lectorOffer.locX,
    locY: lectorOffer.locY,
    locZ: lectorOffer.locZ
}, 'radius-aware smoothing must not overwrite the reachable approach point with the exact NPC cell');

console.log(`Town NPC catalog and routing checks passed (${rows.length - unreachable.length}/${rows.length} direct, ${unreachable.length} covered by alternatives)`);
