'use strict';
// One table of the places where a private store may stand, per town (U19).
//
// Each row is a trading square captured in-game. Places are the points of a
// square grid, SPACING apart, inside the square and at least `margin` from its
// edge (and `clearance` from a hole such as Giran's central column). A town's
// table is built once, on its first use: the height of every place comes from
// geodata, and a place a hot bot cannot stand on is left out.
//
// Free places are kept in a min-heap of place numbers. Places are numbered from
// the fill centre outward (Giran: the centre of its column; any other square:
// the area centroid of its outline; ties by Y, then X), so the market grows as
// one tight cluster around the centre. Taking or freeing a place is O(log n).
//
// Everything that stands on a square blocks the places closer than SPACING:
// static merchants (at build), AFK shops (AfkTradeService projections), and the
// stores and craft shops of bot life states (LifeStateCache writes). An owner
// key holds at most one place; occupying again moves it.

const SPACING = 40;

function rect(minX, maxX, minY, maxY) {
    return Object.freeze([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]);
}

const PLAZAS = Object.freeze({
    // Captured in-game from the Giran trading square. The column is walkable
    // around, but a private store cannot sit there. The whole square also has a
    // raised north-east terrace with the static merchants; stores stay west of it.
    Giran: Object.freeze({
        boundary: rect(80911, 82947, 147662, 149550),
        margin: 60,
        holes: Object.freeze([Object.freeze({ minX: 81667, maxX: 82174, minY: 148354, maxY: 148857, clearance: 80 })]),
        square: Object.freeze({ minX: 80911, maxX: 83750, minY: 147662, maxY: 149550 }),
        locZ: -3466
    }),
    // Captured from the Gludio D-grade trading square: its north, level ground;
    // the south edge changes elevation and stays clear for the fixed traders.
    Gludio: Object.freeze({
        boundary: rect(-14710, -14200, 122620, 123820),
        margin: 60,
        locZ: -3117
    }),
    Dion: Object.freeze({
        boundary: Object.freeze([
            [15575, 143050], [16665, 144618], [17082, 145399], [18101, 146231],
            [18564, 145810], [17813, 145422], [17129, 144877], [16364, 142984]
        ]),
        margin: 55,
        locZ: -2900
    }),
    // The starter villages also keep the captured plaza centre that market
    // travel goes to (MarketTownPolicy).
    'Talking Island': Object.freeze({
        boundary: Object.freeze([
            [-84242, 245018], [-83965, 244591], [-84553, 243951],
            [-84801, 244105], [-85256, 243540], [-85494, 243762]
        ]),
        margin: 55,
        locZ: -3730,
        travelCenter: Object.freeze({ locX: -84700, locY: 244200 })
    }),
    'Elven Village': Object.freeze({
        boundary: Object.freeze([
            [46644, 50600], [47041, 49427], [46867, 48783],
            [46384, 49055], [46230, 50247]
        ]),
        margin: 55,
        locZ: -3060,
        travelCenter: Object.freeze({ locX: 46600, locY: 49700 })
    }),
    'Dark Elven Village': Object.freeze({
        boundary: Object.freeze([
            [12112, 16364], [13160, 16121], [13286, 16756], [12230, 17001]
        ]),
        margin: 55,
        locZ: -4585,
        travelCenter: Object.freeze({ locX: 12700, locY: 16600 })
    }),
    'Orc Village': Object.freeze({
        boundary: Object.freeze([
            [-45219, -112854], [-45219, -111851], [-44647, -111993], [-43825, -112855]
        ]),
        margin: 55,
        locZ: -240,
        travelCenter: Object.freeze({ locX: -44600, locY: -112400, locZ: -240 })
    }),
    // Floran, the town where a PK trades (design 5.8). The author's square
    // captured in-game, data as is (FLORAN_MARKET_PLAZA, commit e77e0540):
    // outline including the central inset, corner heights, stall padding.
    'Floran Village': Object.freeze({
        boundary: Object.freeze([
            [16933, 169872], [16777, 170253], [17382, 170559],
            [18255, 170501], [18309, 170202], [17899, 170030],
            [17672, 170355], [17402, 170300], [17518, 169837]
        ]),
        boundaryHeights: Object.freeze([-3495, -3498, -3502, -3499, -3496, -3499, -3508, -3507, -3501]),
        margin: 55,
        locZ: -3501
    }),
    'Dwarven Village': Object.freeze({
        boundary: Object.freeze([
            [115570, -178085], [115871, -179190], [115235, -179361], [115099, -177873]
        ]),
        margin: 55,
        locZ: -920,
        travelCenter: Object.freeze({ locX: 115440, locY: -178580, locZ: -920 })
    }),
    // The author's five squares captured in-game (commit 2fa4508b), data as
    // is: outline, stall padding, captured centre and ground level. He
    // recorded them for later market routing; bots do not open shops here yet
    // (botShops: false, SHOP_TOWNS), the places only take part in occupancy.
    // Oren: the concave inset stays outside the trading area.
    Oren: Object.freeze({
        boundary: Object.freeze([
            [82942, 53245], [82946, 54161], [82181, 54163],
            [82175, 53746], [81669, 53745], [81665, 53287]
        ]),
        margin: 55,
        locZ: -1496,
        botShops: false
    }),
    // Hunter's Village: heights vary across the square.
    "Hunter's Village": Object.freeze({
        boundary: Object.freeze([
            [117437, 76275], [116628, 75417], [116157, 75751],
            [115910, 76188], [116395, 76915]
        ]),
        margin: 55,
        center: Object.freeze({ locX: 116505, locY: 76109, locZ: -2717 }),
        locZ: -2717,
        botShops: false
    }),
    // Aden: the lower trading square, not the higher respawn terrace.
    Aden: Object.freeze({
        boundary: Object.freeze([
            [146732, 26595], [146738, 27305], [148167, 27309], [148173, 26594]
        ]),
        margin: 55,
        center: Object.freeze({ locX: 147453, locY: 26951, locZ: -2205 }),
        locZ: -2205,
        botShops: false
    }),
    // Rune: the slanted edges of the measured footprint.
    Rune: Object.freeze({
        boundary: Object.freeze([
            [43248, -47812], [43329, -48311], [44978, -48312], [45006, -47721]
        ]),
        margin: 55,
        center: Object.freeze({ locX: 44140, locY: -48039, locZ: -797 }),
        locZ: -797,
        botShops: false
    }),
    // Goddard, including the concave upper edge.
    Goddard: Object.freeze({
        boundary: Object.freeze([
            [148750, -55483], [148257, -55709], [147976, -56081],
            [147411, -56052], [147174, -55712], [146704, -55743],
            [146855, -56198], [147622, -56624], [147789, -56569], [148642, -56101]
        ]),
        margin: 55,
        locZ: -2781,
        botShops: false
    })
});

// The towns where a bot may open its shop (MarketTownPolicy.shopTown).
const SHOP_TOWNS = Object.freeze(Object.keys(PLAZAS).filter((town) => PLAZAS[town].botShops !== false));

function boundsOf(boundary) {
    let minX = Infinity; let maxX = -Infinity; let minY = Infinity; let maxY = -Infinity;
    for (const [x, y] of boundary) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
    }
    return { minX, maxX, minY, maxY };
}

function insidePolygon(x, y, boundary) {
    let inside = false;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
        const [xi, yi] = boundary[i];
        const [xj, yj] = boundary[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi) / (yj - yi)) + xi) inside = !inside;
    }
    return inside;
}

function edgeDistance(x, y, boundary) {
    let best = Infinity;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
        const [ax, ay] = boundary[j];
        const [bx, by] = boundary[i];
        const dx = bx - ax;
        const dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
    return best;
}

function inHole(x, y, hole) {
    return x >= hole.minX - hole.clearance && x <= hole.maxX + hole.clearance
        && y >= hole.minY - hole.clearance && y <= hole.maxY + hole.clearance;
}

function hasPlaza(town) {
    return Object.prototype.hasOwnProperty.call(PLAZAS, String(town || ''));
}

// Whether a point is on the square at all (Giran: including its terrace).
function isOnSquare(town, loc = {}) {
    if (!hasPlaza(town)) return false;
    const row = PLAZAS[town];
    const x = Number(loc.locX);
    const y = Number(loc.locY);
    if (row.square) return x >= row.square.minX && x <= row.square.maxX && y >= row.square.minY && y <= row.square.maxY;
    return insidePolygon(x, y, row.boundary);
}

// Whether a store may stand on this point: inside the outline, at least the
// margin from every edge, and clear of the holes.
function isStallArea(town, loc = {}) {
    if (!hasPlaza(town)) return false;
    const row = PLAZAS[town];
    const x = Number(loc.locX);
    const y = Number(loc.locY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!insidePolygon(x, y, row.boundary) || edgeDistance(x, y, row.boundary) < row.margin) return false;
    return !(row.holes || []).some((hole) => inHole(x, y, hole));
}

// The bounding box of the stall area (the outline's box less the margin).
function stallBounds(town) {
    const box = boundsOf(PLAZAS[town].boundary);
    const margin = PLAZAS[town].margin;
    return { minX: box.minX + margin, maxX: box.maxX - margin, minY: box.minY + margin, maxY: box.maxY - margin };
}

function centroid(boundary) {
    let area = 0; let cx = 0; let cy = 0;
    for (let i = 0, j = boundary.length - 1; i < boundary.length; j = i++) {
        const [x0, y0] = boundary[j];
        const [x1, y1] = boundary[i];
        const cross = x0 * y1 - x1 * y0;
        area += cross;
        cx += (x0 + x1) * cross;
        cy += (y0 + y1) * cross;
    }
    return { locX: cx / (3 * area), locY: cy / (3 * area) };
}

function fillCenter(town) {
    const hole = (PLAZAS[town].holes || [])[0];
    if (hole) return { locX: (hole.minX + hole.maxX) / 2, locY: (hole.minY + hole.maxY) / 2 };
    return centroid(PLAZAS[town].boundary);
}

// owner key -> { town, locX, locY, places: [place numbers it blocks] }
const occupants = new Map();
let towns = null;

function buildTown(town) {
    const Geo = invoke('GameServer/Geodata/GeodataEngine');
    const Placement = invoke('GameServer/Bot/Population/ActivationPlacement');
    const row = PLAZAS[town];
    const bounds = stallBounds(town);
    const center = fillCenter(town);
    const candidates = [];
    for (let locX = bounds.minX; locX <= bounds.maxX; locX += SPACING) {
        for (let locY = bounds.minY; locY <= bounds.maxY; locY += SPACING) {
            if (!isStallArea(town, { locX, locY })) continue;
            const locZ = Geo.getHeight(locX, locY, row.locZ);
            const loc = { locX, locY, locZ };
            // Without geodata files (a bare checkout) the stored height stands.
            if (Geo.hasGeo(locX, locY) && !Placement.resolve({ loc }, { keepStoreLocation: true, storeLoc: loc })) continue;
            candidates.push({ ...loc, distance: Math.hypot(locX - center.locX, locY - center.locY) });
        }
    }
    candidates.sort((a, b) => a.distance - b.distance || a.locY - b.locY || a.locX - b.locX);
    const count = candidates.length;
    const cols = Math.floor((bounds.maxX - bounds.minX) / SPACING) + 1;
    const rows = Math.floor((bounds.maxY - bounds.minY) / SPACING) + 1;
    const data = {
        originX: bounds.minX,
        originY: bounds.minY,
        cols,
        rows,
        cellPlace: new Int32Array(cols * rows).fill(-1),
        xs: new Int32Array(count),
        ys: new Int32Array(count),
        zs: new Int32Array(count),
        blockers: new Uint16Array(count),
        inHeap: new Uint8Array(count),
        // Place numbers ascend from the centre, so 0..n-1 is already a min-heap.
        heap: Array.from({ length: count }, (_, index) => index)
    };
    candidates.forEach((loc, index) => {
        data.xs[index] = loc.locX;
        data.ys[index] = loc.locY;
        data.zs[index] = loc.locZ;
        data.inHeap[index] = 1;
        const col = (loc.locX - bounds.minX) / SPACING;
        const line = (loc.locY - bounds.minY) / SPACING;
        data.cellPlace[line * cols + col] = index;
    });
    return data;
}

function heapPush(heap, value) {
    heap.push(value);
    let index = heap.length - 1;
    while (index > 0) {
        const parent = (index - 1) >> 1;
        if (heap[parent] <= value) break;
        heap[index] = heap[parent];
        index = parent;
    }
    heap[index] = value;
}

function heapPop(heap) {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
        let index = 0;
        for (;;) {
            const left = index * 2 + 1;
            if (left >= heap.length) break;
            const right = left + 1;
            const child = right < heap.length && heap[right] < heap[left] ? right : left;
            if (heap[child] >= last) break;
            heap[index] = heap[child];
            index = child;
        }
        heap[index] = last;
    }
    return top;
}

// The places closer than SPACING to a point: at most a 3 x 3 block of cells.
function placesNear(data, x, y) {
    const found = [];
    const fromCol = Math.max(0, Math.ceil((x - data.originX - SPACING) / SPACING));
    const toCol = Math.min(data.cols - 1, Math.floor((x - data.originX + SPACING) / SPACING));
    const fromRow = Math.max(0, Math.ceil((y - data.originY - SPACING) / SPACING));
    const toRow = Math.min(data.rows - 1, Math.floor((y - data.originY + SPACING) / SPACING));
    for (let line = fromRow; line <= toRow; line++) {
        for (let col = fromCol; col <= toCol; col++) {
            const place = data.cellPlace[line * data.cols + col];
            if (place < 0) continue;
            const dx = data.xs[place] - x;
            const dy = data.ys[place] - y;
            if (dx * dx + dy * dy < SPACING * SPACING) found.push(place);
        }
    }
    return found;
}

function block(record) {
    const data = towns?.get(record.town);
    if (!data) return;
    record.places = placesNear(data, record.locX, record.locY);
    for (const place of record.places) data.blockers[place]++;
}

function unblock(record) {
    const data = towns?.get(record.town);
    if (!data) return;
    for (const place of record.places) {
        data.blockers[place]--;
        if (data.blockers[place] === 0 && !data.inHeap[place]) {
            data.inHeap[place] = 1;
            heapPush(data.heap, place);
        }
    }
    record.places = [];
}

function release(owner) {
    const record = occupants.get(owner);
    if (!record) return;
    unblock(record);
    occupants.delete(owner);
}

function occupy(owner, town, loc = {}) {
    release(owner);
    const locX = Number(loc.locX);
    const locY = Number(loc.locY);
    if (!hasPlaza(town) || !Number.isFinite(locX) || !Number.isFinite(locY)) return;
    const record = { town, locX, locY, places: [] };
    occupants.set(owner, record);
    block(record);
}

function staticMerchants() {
    const configs = invoke('GameServer/Bot/MerchantStoreConfigs');
    return Object.entries(configs).filter(([, store]) => store && hasPlaza(store.town));
}

// A town's table, built on its first use: a town nobody places a store in
// costs nothing.
function ensureBuilt(town) {
    if (!towns) towns = new Map();
    if (towns.has(town)) return towns.get(town);
    const data = buildTown(town);
    towns.set(town, data);
    // Owners recorded before the build (life states, AFK shops) block now.
    for (const record of occupants.values()) if (record.town === town) block(record);
    for (const [name, store] of staticMerchants()) if (store.town === town) occupy(`static:${name}`, store.town, store);
    return data;
}

// The free place nearest the fill centre, now held by `owner`, or null when
// the town has no captured square or its square is full.
function take(town, owner) {
    if (!hasPlaza(town)) return null;
    const data = ensureBuilt(town);
    release(owner);
    while (data.heap.length) {
        const place = heapPop(data.heap);
        data.inHeap[place] = 0;
        if (data.blockers[place] !== 0) continue;
        const loc = { locX: data.xs[place], locY: data.ys[place], locZ: data.zs[place] };
        occupy(owner, town, loc);
        return loc;
    }
    return null;
}

// Every place of a town in fill order (inspection and tests).
function places(town) {
    if (!hasPlaza(town)) return [];
    const data = ensureBuilt(town);
    return Array.from(data.xs, (locX, index) => ({ locX, locY: data.ys[index], locZ: data.zs[index] }));
}

function freeCount(town) {
    if (!hasPlaza(town)) return 0;
    const data = ensureBuilt(town);
    let free = 0;
    for (let place = 0; place < data.blockers.length; place++) if (data.blockers[place] === 0) free++;
    return free;
}

const stateOwner = (characterId) => `state:${Number(characterId)}`;
const afkOwner = (ownerId) => `afk:${Number(ownerId)}`;

// Where a bot life state's store stands: a crafting bot's craft shop, in any
// town (the bots' sale stalls went with the board, step 3.3).
function placeOfState(state = {}) {
    const stats = state.stats || {};
    if (state.activity === 'crafting' && stats.craftShop?.town) {
        return { town: stats.craftShop.town, loc: stats.craftShop.loc || state.loc };
    }
    return null;
}

// Called on every life-state cache write: O(1) unless the store moved.
function syncState(characterId, state) {
    const owner = stateOwner(characterId);
    const place = placeOfState(state);
    const record = occupants.get(owner);
    if (!place) {
        if (record) release(owner);
        return;
    }
    if (record && record.town === place.town && record.locX === Number(place.loc?.locX)
        && record.locY === Number(place.loc?.locY)) return;
    occupy(owner, place.town, place.loc);
}

function releaseStates() {
    for (const owner of [...occupants.keys()]) if (owner.startsWith('state:')) release(owner);
}

function fullReason(town) {
    return `plaza_full:${town}`;
}

function _resetForTests() {
    occupants.clear();
    towns = null;
}

module.exports = {
    SPACING,
    PLAZAS,
    SHOP_TOWNS,
    afkOwner,
    fillCenter,
    freeCount,
    fullReason,
    hasPlaza,
    isOnSquare,
    isStallArea,
    occupy,
    places,
    release,
    releaseStates,
    stallBounds,
    stateOwner,
    syncState,
    take,
    _resetForTests
};
