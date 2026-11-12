const path = require('path');
const { isMainThread } = require('worker_threads');
const SharedGeodata = require('./SharedGeodata');
const GardenOfEvaBarriers = require('./GardenOfEvaBarriers');
const VirtualObstacles = invoke('GameServer/Geodata/VirtualObstacles/index');

const REGION_OFFSET_X = 20;
const REGION_OFFSET_Y = 18;
const MAX_LAYER_STEP = 64;
// A layer count is one byte in the L2J block format.
const MAX_CELL_LAYERS = 256;
// Sight (Lisvus GeoData MAX_SEE_OVER_HEIGHT, ELEVATED_SEE_OVER_DISTANCE): a
// floor up to this far over the line of sight does not hide, and over the
// first cells of the line the margin is taken over the start floor.
const SEE_OVER_HEIGHT = 64;
const SEE_OVER_NEAR_POINTS = 2;
// The sides a body may leave a geodata cell by (its NSWE flags).
const EAST = 1, WEST = 2, SOUTH = 4, NORTH = 8;
const NEIGHBOURS = Object.freeze([{ dx: 0, dy: -1, exit: NORTH }, { dx: 0, dy: 1, exit: SOUTH },
    { dx: 1, dy: 0, exit: EAST }, { dx: -1, dy: 0, exit: WEST }]);
// Where the latest straightMoveEnd walk stopped: scratch of that one call,
// read before it returns and never kept (no allocation on the sight path).
const walkStop = { cx: 0, cy: 0, cz: 0 };
// Scratch of one getHeight or getCellData read, overwritten by the next.
const heightCell = newCellSlot();
// The region lookup of a readCell call without a caller's memo: reset on
// every such read, so nothing is kept between calls.
const readCellRegion = { key: -1, str: '', buffer: null, index: null };
// Scratch of one hasLineOfSight call: the two ends, the cell left and the
// cell entered, the two corners of a diagonal step, and the call's region
// lookup (reset at the start of each call).
const sightEndA = newCellSlot(), sightEndB = newCellSlot();
const sightPrev = newCellSlot(), sightCur = newCellSlot();
const sightCornerNs = newCellSlot(), sightCornerEw = newCellSlot();
const sightRegion = { key: -1, str: '', buffer: null, index: null };
let sharedGeodata = null;

function getSharedGeodata(directory) {
    if (!sharedGeodata) {
        if (!isMainThread) throw new Error('Worker geodata requires a shared descriptor before use');
        sharedGeodata = SharedGeodata.create(directory);
    }
    return sharedGeodata;
}

class BinaryMinHeap {
    constructor(compare) {
        this.items = [];
        this.compare = compare;
    }

    get length() {
        return this.items.length;
    }

    push(value) {
        const items = this.items;
        let index = items.length;
        items.push(value);
        while (index > 0) {
            const parent = (index - 1) >> 1;
            if (this.compare(items[parent], value) <= 0) break;
            items[index] = items[parent];
            index = parent;
        }
        items[index] = value;
    }

    shift() {
        const items = this.items;
        if (!items.length) return null;
        const first = items[0];
        const last = items.pop();
        if (!items.length) return first;

        let index = 0;
        while (index * 2 + 1 < items.length) {
            const left = index * 2 + 1;
            const right = left + 1;
            const child = right < items.length && this.compare(items[right], items[left]) < 0 ? right : left;
            if (this.compare(items[child], last) >= 0) break;
            items[index] = items[child];
            index = child;
        }
        items[index] = last;
        return first;
    }
}

function getRegionX(x) {
    return (x >> 15) + REGION_OFFSET_X;
}

function getRegionY(y) {
    return (y >> 15) + REGION_OFFSET_Y;
}

function getLocalX(x, regionX) {
    return x - ((regionX - REGION_OFFSET_X) << 15);
}

function getLocalY(y, regionY) {
    return y - ((regionY - REGION_OFFSET_Y) << 15);
}

// The layers of a geodata cell, filled into a caller's slot { n, z, nswe }
// (an Int16Array and a Uint8Array of MAX_CELL_LAYERS): n layers, each its
// floor and its NSWE sides. The one decoder of the L2J block format (Lisvus
// FlatBlock, ComplexBlock, MultilayerBlock): a flat block is one layer open on
// every side, a complex block one layer with its own sides, a multilayer block
// the cell's layers (none for an empty cell, as for an unknown block type).
function decodeCell(buffer, blockOffset, cellX, cellY, slot) {
    const type = buffer.readUInt8(blockOffset);
    if (type === 0) {
        slot.n = 1;
        slot.z[0] = buffer.readInt16LE(blockOffset + 1);
        slot.nswe[0] = 15;
        return slot;
    }
    if (type === 1) {
        const value = buffer.readInt16LE(blockOffset + 1 + (((cellX * 8) + cellY) * 2));
        slot.n = 1;
        slot.z[0] = ((value & 0xFFF0) << 16) >> 17;
        slot.nswe[0] = value & 0x000F;
        return slot;
    }
    slot.n = 0;
    if (type !== 2) return slot;
    let offset = blockOffset + 1;
    const cellId = (cellX * 8) + cellY;
    for (let i = 0; i < cellId; i++) offset += 1 + (buffer.readUInt8(offset) * 2);
    const layers = buffer.readUInt8(offset);
    offset += 1;
    for (let l = 0; l < layers; l++) {
        const value = buffer.readInt16LE(offset + (l * 2));
        slot.z[l] = ((value & 0xFFF0) << 16) >> 17;
        slot.nswe[l] = value & 0x000F;
    }
    slot.n = layers;
    return slot;
}

function newCellSlot() {
    return { n: 0, closed: false, z: new Int16Array(MAX_CELL_LAYERS), nswe: new Uint8Array(MAX_CELL_LAYERS) };
}

// The layer of a decoded cell nearest a height, the first one on a tie
// (Lisvus MultilayerBlock._getNearestLayer); -1 for a cell with no layer.
function nearestLayer(slot, z) {
    let best = -1;
    let bestDiff = Infinity;
    for (let l = 0; l < slot.n; l++) {
        const diff = Math.abs(slot.z[l] - z);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = l;
        }
    }
    return best;
}

// The floor of a decoded cell nearest z, or z for a cell with no layer
// (Lisvus getNearestZ).
function nearestZ(slot, z) {
    const layer = nearestLayer(slot, z);
    return layer < 0 ? z : slot.z[layer];
}

// A cell the map knows: a layer, or a town obstacle over it (Lisvus hasGeoPos).
function hasCellData(slot) {
    return slot.n > 0 || slot.closed;
}

// Is the cell's layer nearest z open on every side in `sides` (Lisvus
// checkNearestNswe): a town obstacle is closed, a cell with no layer open.
function opensToward(slot, z, sides) {
    if (slot.closed) return false;
    if (slot.n === 0) return true;
    return (slot.nswe[nearestLayer(slot, z)] & sides) === sides;
}

// The cell's layer at z or the lowest one above it, else z (Lisvus
// MultilayerBlock.getNextHigherZ; a one-layer cell answers the higher of its
// floor and z, ComplexBlock.getNextHigherZ).
function nextHigherZ(slot, z) {
    if (slot.closed || slot.n === 0) return z;
    let higher = Infinity;
    for (let l = 0; l < slot.n; l++) {
        const layerZ = slot.z[l];
        if (layerZ === z) return z;
        if (layerZ > z && layerZ < higher) higher = layerZ;
    }
    return higher === Infinity ? z : higher;
}

function copyCell(from, to) {
    to.n = from.n;
    to.closed = from.closed;
    for (let l = 0; l < from.n; l++) {
        to.z[l] = from.z[l];
        to.nswe[l] = from.nswe[l];
    }
}

// The floor nearest z of a cell, or z for a cell with no layer.
function readHeight(buffer, blockOffset, cellX, cellY, z) {
    const layer = nearestLayer(decodeCell(buffer, blockOffset, cellX, cellY, heightCell), z);
    return layer < 0 ? z : heightCell.z[layer];
}

function regionFailure(engine, store, key, error) {
    // Files are immutable until restart; do not retry a corrupt region on every query.
    engine.missing[key] = true;
    delete engine.regions[key];
    delete engine[`index_${key}`];
    if (error && error.code !== 'ENOENT') {
        console.error(`GeodataEngine :: Failed to load region ${key}:`, error);
    } else {
        const directory = store?.descriptor.directory || engine.getGeodataDir();
        utils.infoWarn("GeodataEngine", "Geodata file not found: %s", path.join(directory, `${key}.l2j`));
    }
}

const GeodataEngine = {
    regions: {}, // Loaded region buffers, keyed by "XX_YY"
    missing: {}, // Keys of missing regions, to prevent console spam and repeat disk checks

    init() {
        this.navigationRevision = Number(this.navigationRevision || 0) + 1;
        if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) console.info("GeodataEngine :: Initializing...");
        VirtualObstacles.init();
        // Preload active regions on startup
        // L2J geodata file names follow client map regions, e.g. T_22_19.
        const activeRegions = [
            // Talking Island (x≈-84k, y≈244k)
            { x: 17, y: 25 }, // Talking Island Village (core)
            { x: 17, y: 24 }, // Talking Island (south)

            // Gludin (x≈-80k, y≈149k)
            { x: 17, y: 22 }, // Gludin Town (core)
            { x: 17, y: 21 }, // Gludin (south)
            { x: 17, y: 23 }, // Gludin (north)

            // Gludio (x≈-12k, y≈122k)
            { x: 19, y: 21 }, // Gludio Town (core)
            { x: 19, y: 20 }, // Gludio (south)
            { x: 19, y: 22 }, // Gludio (north)

            // Dion (x≈15k, y≈142k)
            { x: 20, y: 22 }, // Dion Town (core)
            { x: 20, y: 21 }, // Dion (south)

            // Dark Elven Village (x≈9k, y≈15k)
            { x: 20, y: 18 }, // Dark Elven Village (core)
            { x: 19, y: 18 }, // Dark Elven (west)
            { x: 20, y: 19 }, // Dark Elven (north)

            // Orc Village area (x≈84k, y≈-112k)
            { x: 22, y: 14 }, // Orc Village area
            { x: 21, y: 14 }, // Orc Village adjacent area

            // Neutral Zone / Elven Forest (x≈-10k, y≈75k)
            { x: 19, y: 20 }, // Neutral Zone area (already loaded for Gludio south)

            // General world areas for pathfinding
            { x: 20, y: 20 }, // Central area
            { x: 19, y: 19 }, // Between cities
        ];
        activeRegions.forEach(reg => {
            this.loadRegion(reg.x, reg.y);
        });
    },

    getGeodataDir() {
        return sharedGeodata?.descriptor.directory
            || path.resolve(process.env.L2NODE_GEODATA_DIR || path.join(__dirname, '../../../data/Geodata'));
    },

    sharedDescriptor() {
        return { ...getSharedGeodata(this.getGeodataDir()).descriptor,
            gardenOfEvaBarriers: GardenOfEvaBarriers.sharedBuffer() };
    },

    attachShared(descriptor) {
        if (descriptor?.gardenOfEvaBarriers) GardenOfEvaBarriers.attach(descriptor.gardenOfEvaBarriers);
        if (sharedGeodata) {
            if (sharedGeodata.descriptor.arena !== descriptor?.arena) {
                throw new Error('Cannot replace the shared geodata arena before restart');
            }
            return;
        }
        sharedGeodata = SharedGeodata.attach(descriptor);
    },

    storageStats() {
        let attachedBytes = 0;
        const attached = new Set(Object.keys(this.regions));
        for (const buffer of Object.values(this.regions)) attachedBytes += buffer.byteLength;
        for (const key of Object.keys(this)) {
            if (!key.startsWith('index_') || !this[key]) continue;
            attached.add(key.slice(6));
            attachedBytes += this[key].byteLength || 0;
        }
        return { ...(sharedGeodata?.stats() || { reservedBytes: 0, loadedBytes: 0, loadedRegions: 0,
            rawRegions: 0, indexOnlyRegions: 0, heightFileReads: 0 }),
            attachedBytes, attachedRegions: attached.size };
    },

    getRegionKey(x, y) {
        return `${getRegionX(x)}_${getRegionY(y)}`;
    },

    loadRegion(regionX, regionY) {
        const key = `${regionX}_${regionY}`;
        if (this.regions[key]) return true;
        if (this.missing[key]) {
            return false;
        }
        const store = getSharedGeodata(this.getGeodataDir());
        try {
            const loaded = store.load(key, (buffer, index) => this.buildOffsetIndex(buffer, index), this[`index_${key}`]);
            if (loaded) {
                this.regions[key] = loaded.buffer;
                this[`index_${key}`] = loaded.index;
                if (invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) utils.infoSuccess("GeodataEngine", "Loaded region geodata: %s (Size: %s MB)", key, (loaded.buffer.length / (1024 * 1024)).toFixed(2));
                return true;
            }
        } catch (err) {
            regionFailure(this, store, key, err);
            return false;
        }
        regionFailure(this, store, key);
        return false;
    },

    getRegionBuffer(regionX, regionY) {
        const key = `${regionX}_${regionY}`;
        if (this.regions[key]) {
            return this.regions[key];
        }
        // Try to load dynamically
        if (this.loadRegion(regionX, regionY)) {
            return this.regions[key];
        }
        return null;
    },

    hasGeo(x, y) {
        const key = this.getRegionKey(x, y);
        return !!(this.regions[key] || this[`index_${key}`]);
    },

    getHeight(x, y, z) {
        const regionX = getRegionX(x);
        const regionY = getRegionY(y);
        const key = `${regionX}_${regionY}`;
        const localX = getLocalX(x, regionX);
        const localY = getLocalY(y, regionY);
        const blockId = ((localX >> 7) * 256) + (localY >> 7);
        const cellX = (localX >> 4) & 7;
        const cellY = (localY >> 4) & 7;
        const localBuffer = this.regions[key];
        if (!localBuffer && this.missing[key]) return z;
        let buffer = localBuffer;
        let index = this[`index_${key}`];
        let blockOffset = index?.[blockId];
        if (!buffer) {
            // Missing worker bootstrap must fail before the ordinary missing-file fallback.
            const store = getSharedGeodata(this.getGeodataDir());
            let loaded;
            try {
                loaded = store.loadHeightBlock(key, blockId, (data, target) => this.buildOffsetIndex(data, target), index);
            } catch (error) {
                regionFailure(this, store, key, error);
                return z;
            }
            if (!loaded) {
                regionFailure(this, store, key);
                return z;
            }
            ({ buffer, index, blockOffset } = loaded);
            // Attach after the local load, as full-region reads do. A decoder error
            // in one block must not invalidate the region's other blocks.
            this[`index_${key}`] = index;
            if (loaded.raw) this.regions[key] = buffer;
        }
        if (blockOffset === undefined || !buffer.length) return z;
        return readHeight(buffer, blockOffset, cellX, cellY, z);
    },

    checkVirtualObstacles(x, y, regionKey) {
        return VirtualObstacles.checkObstacle(x, y, regionKey);
    },

    getCellData(x, y, z) {
        const regionX = getRegionX(x);
        const regionY = getRegionY(y);
        const regionKey = `${regionX}_${regionY}`;

        if (this.checkVirtualObstacles(x, y, regionKey)) {
            return { z: z, nswe: 0 }; // Fully blocked
        }

        const buffer = this.getRegionBuffer(regionX, regionY);
        if (!buffer) {
            return { z: z, nswe: 15 };
        }

        const offsetIndex = this[`index_${regionKey}`];
        if (!offsetIndex) {
            return { z: z, nswe: 15 };
        }

        const localX = getLocalX(x, regionX);
        const localY = getLocalY(y, regionY);
        const blockOffset = offsetIndex[((localX >> 7) * 256) + (localY >> 7)];
        if (blockOffset === undefined) {
            return { z: z, nswe: 15 };
        }

        const layer = nearestLayer(decodeCell(buffer, blockOffset, (localX >> 4) & 7, (localY >> 4) & 7, heightCell), z);
        return layer < 0 ? { z: z, nswe: 15 } : { z: heightCell.z[layer], nswe: heightCell.nswe[layer] };
    },

    // Every layer of the cell (cellX, cellY) into `slot` (decodeCell's shape),
    // and slot.closed when a town virtual obstacle covers the cell's centre. A
    // cell of a missing region or block has no layer. `memo` (optional) is the
    // caller's region lookup { key, str, buffer, index }: the caller sets key
    // to -1 at the start of its call and passes it to each read of that call,
    // so the region is looked up once per region per call and nothing outlives
    // the call.
    readCell(cellX, cellY, slot, memo) {
        const x = (cellX << 4) + 8;
        const y = (cellY << 4) + 8;
        const regionX = getRegionX(x);
        const regionY = getRegionY(y);
        const key = (regionX * 1000) + regionY;
        const region = memo || readCellRegion;
        if (!memo || region.key !== key) {
            region.key = key;
            region.str = `${regionX}_${regionY}`;
            region.buffer = this.getRegionBuffer(regionX, regionY);
            region.index = region.buffer ? this[`index_${region.str}`] : null;
        }
        slot.closed = !!this.checkVirtualObstacles(x, y, region.str);
        slot.n = 0;
        if (!region.index) return slot;
        const localX = getLocalX(x, regionX);
        const localY = getLocalY(y, regionY);
        const blockOffset = region.index[((localX >> 7) * 256) + (localY >> 7)];
        if (blockOffset === undefined) return slot;
        return decodeCell(region.buffer, blockOffset, (localX >> 4) & 7, (localY >> 4) & 7, slot);
    },

    // Does a body at one point see a body at another (C4: Lisvus
    // GeoData.canSeeTarget and getLosGeoZ). A pure read of the map, the same
    // answer whichever end asks. Each end stands on its cell's layer nearest
    // its z (getNearestZ). The ray runs from the higher floor to the lower one
    // over the cells under the line (LinePointIterator3D: Bresenham over cell
    // x, cell y and world z); on each new cell its floor is the layer the
    // cell left opens onto (anti-corner-cut on a diagonal,
    // checkNearestNsweAntiCornerCut), else the next layer above
    // (getNextHigherZ). A floor more than SEE_OVER_HEIGHT over the line hides
    // the target; over the first SEE_OVER_NEAR_POINTS cells the margin is
    // taken over the start floor, so a body sees over a lip at its feet. On a
    // diagonal both corner cells must pass too, asked as Lisvus writes them:
    // the north/south corner with the left cell's east/west side and the
    // east/west corner with its north/south side (Mobius asks each corner its
    // own side). Two floors of one cell never see each other; ends closer
    // than 64 on cells with geodata see each other when their floors lie
    // within SEE_OVER_HEIGHT. A cell with no geodata keeps the floor before
    // it. Our choices: equal floors are traced from the end on the lower cell
    // (Lisvus traces from the caller, so its answer can depend on who looks);
    // a town virtual obstacle hides, and a body in one, at either end, is
    // neither seen nor seeing (as the straight walk); no iteration cap
    // (Lisvus answers not seen past 2000 line points; we trace the whole
    // line, so we differ only for pairs whose line exceeds 2000 points, e.g.
    // a height difference over 2000). The Garden of Eva barriers hide as walls. Callers: NPC
    // aggro, assist, town guards, the NPC chase and its hits and casts, area
    // skills, party support's aggro forecast; all on main.
    hasLineOfSight(fromX, fromY, fromZ, toX, toY, toZ) {
        sightRegion.key = -1;
        let x = fromX, y = fromY, tx = toX, ty = toY;
        let gx = x >> 4, gy = y >> 4, tgx = tx >> 4, tgy = ty >> 4;
        this.readCell(gx, gy, sightEndA, sightRegion);
        this.readCell(tgx, tgy, sightEndB, sightRegion);
        if (sightEndA.closed || sightEndB.closed) return false;
        let z = nearestZ(sightEndA, fromZ);
        let tz = nearestZ(sightEndB, toZ);
        let start = sightEndA;
        let end = sightEndB;
        if (tz > z || (tz === z && (tgx < gx || (tgx === gx && tgy < gy)))) {
            let t = gx; gx = tgx; tgx = t;
            t = gy; gy = tgy; tgy = t;
            t = z; z = tz; tz = t;
            t = x; x = tx; tx = t;
            t = y; y = ty; ty = t;
            start = sightEndB; end = sightEndA;
        }
        if (GardenOfEvaBarriers.blocks(x, y, z, tx, ty, tz)) return false;
        if (gx === tgx && gy === tgy) return !hasCellData(end) || z === tz;
        const dx = x - tx, dy = y - ty;
        if ((dx * dx) + (dy * dy) < 4096 && hasCellData(start) && hasCellData(end)) {
            return Math.abs(z - tz) <= SEE_OVER_HEIGHT;
        }

        const cellsX = Math.abs(tgx - gx), cellsY = Math.abs(tgy - gy), heightZ = Math.abs(tz - z);
        const stepX = gx < tgx ? 1 : -1, stepY = gy < tgy ? 1 : -1, stepZ = z < tz ? 1 : -1;
        const major = cellsX >= cellsY && cellsX >= heightZ ? 0 : (cellsY >= heightZ ? 1 : 2);
        let error1 = (major === 0 ? cellsX : major === 1 ? cellsY : heightZ) >> 1;
        let error2 = error1;
        let prev = sightPrev, cur = sightCur;
        copyCell(start, prev);
        let sx = gx, sy = gy, sz = z;
        let px = gx, py = gy, prevGeoZ = z, point = 0;
        for (;;) {
            if (major === 0) {
                if (sx === tgx) break;
                sx += stepX;
                error1 += cellsY; if (error1 >= cellsX) { sy += stepY; error1 -= cellsX; }
                error2 += heightZ; if (error2 >= cellsX) { sz += stepZ; error2 -= cellsX; }
            } else if (major === 1) {
                if (sy === tgy) break;
                sy += stepY;
                error1 += cellsX; if (error1 >= cellsY) { sx += stepX; error1 -= cellsY; }
                error2 += heightZ; if (error2 >= cellsY) { sz += stepZ; error2 -= cellsY; }
            } else {
                if (sz === tz) break;
                sz += stepZ;
                error1 += cellsX; if (error1 >= heightZ) { sx += stepX; error1 -= heightZ; }
                error2 += cellsY; if (error2 >= heightZ) { sy += stepY; error2 -= heightZ; }
            }
            if (sx === px && sy === py) continue;
            this.readCell(sx, sy, cur, sightRegion);
            let curGeoZ = prevGeoZ;
            if (hasCellData(cur)) {
                if (cur.closed) return false;
                const ew = sx > px ? EAST : sx < px ? WEST : 0;
                const ns = sy > py ? SOUTH : sy < py ? NORTH : 0;
                const maxHeight = (point < SEE_OVER_NEAR_POINTS ? z : sz) + SEE_OVER_HEIGHT;
                if (ns && ew) {
                    const cornerNs = sightCornerNs, cornerEw = sightCornerEw;
                    this.readCell(px, ns === NORTH ? py - 1 : py + 1, cornerNs, sightRegion);
                    this.readCell(ew === EAST ? px + 1 : px - 1, py, cornerEw, sightRegion);
                    const open = opensToward(cornerNs, prevGeoZ, ew) && opensToward(cornerEw, prevGeoZ, ns)
                        && opensToward(prev, prevGeoZ, ns | ew);
                    curGeoZ = open ? nearestZ(cur, prevGeoZ) : nextHigherZ(cur, prevGeoZ);
                    if (curGeoZ > maxHeight) return false;
                    const nsGeoZ = opensToward(prev, prevGeoZ, ew) ? nearestZ(cornerNs, prevGeoZ) : nextHigherZ(cornerNs, prevGeoZ);
                    const ewGeoZ = opensToward(prev, prevGeoZ, ns) ? nearestZ(cornerEw, prevGeoZ) : nextHigherZ(cornerEw, prevGeoZ);
                    if (nsGeoZ > maxHeight || ewGeoZ > maxHeight
                        || nsGeoZ > nearestZ(cornerNs, sz) || ewGeoZ > nearestZ(cornerEw, sz)) return false;
                } else {
                    curGeoZ = opensToward(prev, prevGeoZ, ns | ew) ? nearestZ(cur, prevGeoZ) : nextHigherZ(cur, prevGeoZ);
                    if (curGeoZ > maxHeight) return false;
                }
            }
            const left = prev; prev = cur; cur = left;
            px = sx; py = sy; prevGeoZ = curGeoZ; point++;
        }
        return true;
    },

    // May a body walk straight from one point to another: the straight walk
    // reaches the target's cell and floor (movement goals, route legs, the
    // bots' target choice and hit gate).
    canWalkStraight(fromX, fromY, fromZ, toX, toY, toZ) {
        return this.walkStraight(fromX, fromY, fromZ, toX, toY, toZ, null);
    },

    // How far a straight move from a point toward another goes (C4: Lisvus
    // GeoData.moveCheck, Mobius GeoEngine.getValidLocation): the target when
    // the walk reaches it, otherwise the centre of the last cell the walk
    // stood on, or the start point when it could not take one step. locZ is
    // the floor the walk ended on. Our choice: a walk that comes to the
    // target's cell on another floor ends in that cell on its own floor (C4
    // sends it back to the start). Callers: a ground drop's landing point
    // (NpcRewards), a pickup run's end (Automation), on main.
    straightMoveEnd(fromX, fromY, fromZ, toX, toY, toZ) {
        const reached = this.walkStraight(fromX, fromY, fromZ, toX, toY, toZ, walkStop);
        if (reached) return { locX: toX, locY: toY, locZ: walkStop.cz, reached };
        if (walkStop.cx === fromX >> 4 && walkStop.cy === fromY >> 4) {
            return { locX: fromX, locY: fromY, locZ: walkStop.cz, reached };
        }
        return { locX: (walkStop.cx << 4) + 8, locY: (walkStop.cy << 4) + 8, locZ: walkStop.cz, reached };
    },

    // The step rule, one for the straight walk and for
    // the route search, on main and in the pathfinding workers: a body on the
    // cell `from` steps to the neighbouring cell on its `exit` side when
    // `from` is open on that side. The entered cell's flag toward the body is
    // not asked (C4: Lisvus GeoData.moveCheck and CellNodeBuffer.getNeighbors,
    // Mobius GeoEngine.getValidLocation and NodeBuffer.expandNeighbors read
    // the cell being left), so a one-way edge (a steep slope, a ledge) is
    // walked down and never up, and a body inside a tree's or a rock's skirt
    // walks out of it. Two clauses on the entered cell: it is not closed on
    // all four sides (Mobius GeoEngine.isCompletelyBlocked; a town building
    // is such a cell here), and its floor lies within MAX_LAYER_STEP of the
    // one left, up or down (our choice: Lisvus has no height limit on a step,
    // Mobius refuses more than 40 up and nothing down). Returns the entered
    // cell, its layer nearest the floor left, or null.
    stepTo(from, cellX, cellY, exit) {
        if ((from.nswe & exit) === 0) return null;
        const to = this.getCellData((cellX << 4) + 8, (cellY << 4) + 8, from.z);
        return to.nswe !== 0 && Math.abs(to.z - from.z) <= MAX_LAYER_STEP ? to : null;
    },

    // The one straight walk (canWalkStraight, straightMoveEnd): the cells
    // under the line, one stepTo at a time. A
    // diagonal step is two steps round either corner (our choice: C4 needs
    // both corners open). True when the walk ends on the target's cell and
    // floor. With `stop` it also reports the last cell it stood on and that
    // cell's floor.
    walkStraight(fromX, fromY, fromZ, toX, toY, toZ, stop) {
        if (GardenOfEvaBarriers.blocks(fromX, fromY, fromZ, toX, toY, toZ)) {
            if (stop) {
                stop.cx = fromX >> 4; stop.cy = fromY >> 4;
                stop.cz = this.getCellData((stop.cx << 4) + 8, (stop.cy << 4) + 8, fromZ).z;
            }
            return false;
        }
        let cx = fromX >> 4;
        let cy = fromY >> 4;

        const targetCx = toX >> 4;
        const targetCy = toY >> 4;
        const startCell = this.getCellData((cx << 4) + 8, (cy << 4) + 8, fromZ);
        const targetCell = this.getCellData((targetCx << 4) + 8, (targetCy << 4) + 8, toZ);
        const hasLayerData = this.hasGeo(fromX, fromY) && this.hasGeo(toX, toY);
        let cell = startCell;
        let cz = startCell.z;

        if (cx === targetCx && cy === targetCy) {
            if (stop) { stop.cx = cx; stop.cy = cy; stop.cz = cz; }
            // A multilevel block can contain several floors in the same XY
            // cell.  Treating that as unconditional visibility is exactly
            // what lets Cruma mobs see through a ceiling.
            return !hasLayerData || startCell.z === targetCell.z;
        }

        const dx = targetCx - cx;
        const dy = targetCy - cy;
        const steps = Math.max(Math.abs(dx), Math.abs(dy));

        const xInc = dx / steps;
        const yInc = dy / steps;

        let floatCx = cx;
        let floatCy = cy;
        let blocked = false;

        for (let i = 0; i < steps; i++) {
            const nextCx = Math.round(floatCx + xInc);
            const nextCy = Math.round(floatCy + yInc);

            const xExit = nextCx > cx ? EAST : WEST;
            const yExit = nextCy > cy ? SOUTH : NORTH;
            let next;
            if (nextCx !== cx && nextCy !== cy) {
                const side = this.stepTo(cell, nextCx, cy, xExit);
                next = side && this.stepTo(side, nextCx, nextCy, yExit);
                if (!next) {
                    const other = this.stepTo(cell, cx, nextCy, yExit);
                    next = other && this.stepTo(other, nextCx, nextCy, xExit);
                }
            } else {
                next = this.stepTo(cell, nextCx, nextCy, nextCx !== cx ? xExit : yExit);
            }
            if (!next) {
                blocked = true;
                break;
            }

            cell = next;
            cz = next.z;
            cx = nextCx;
            cy = nextCy;
            floatCx += xInc;
            floatCy += yInc;
        }

        // Walking the source layer is intentional: getCellData selects the
        // layer nearest to cz at every step.  The ray is only valid if it
        // finishes on the target's resolved layer instead of a floor above
        // or below it. Missing geodata keeps the historical permissive
        // fallback so uncovered outdoor regions do not become opaque.
        if (stop) { stop.cx = cx; stop.cy = cy; stop.cz = cz; }
        return !blocked && (!hasLayerData || Math.abs(cz - targetCell.z) <= MAX_LAYER_STEP);
    },

    // Runs the whole search in one go (findPathSteps without pauses).
    findPath(startX, startY, startZ, endX, endY, endZ, maxNodes = 2000, options = {}) {
        const search = this.findPathSteps(startX, startY, startZ, endX, endY, endZ, maxNodes, options);
        let step = search.next();
        while (!step.done) step = search.next();
        return step.value;
    },

    // The A* search, pausing (yield) at its start, every 128 expanded nodes
    // and during smoothing, so a caller can stop it there or continue it on a
    // later turn. It returns the smoothed path or null.
    *findPathSteps(startX, startY, startZ, endX, endY, endZ, maxNodes = 2000, options = {}) {
        yield;
        const startCx = startX >> 4;
        const startCy = startY >> 4;
        const endCx = endX >> 4;
        const endCy = endY >> 4;
        const startCell = this.getCellData((startCx << 4) + 8, (startCy << 4) + 8, startZ);
        const endCell = this.getCellData((endCx << 4) + 8, (endCy << 4) + 8, endZ);
        const hasLayerData = this.hasGeo(startX, startY) && this.hasGeo(endX, endY);
        const goalRadius = Math.max(0, Number(options.goalRadius || 0));
        const goalZTolerance = goalRadius > 0
            ? Math.max(MAX_LAYER_STEP, Number(options.goalZTolerance || MAX_LAYER_STEP))
            : 0;
        const heuristicWeight = Math.max(1, Number(options.heuristicWeight || 1));
        const heuristic = (cx, cy, cz) => {
            const horizontalSteps = Math.abs(endCx - cx) + Math.abs(endCy - cy);
            const horizontalDistance = goalRadius > 0
                ? Math.max(0, horizontalSteps * 16 - goalRadius * Math.SQRT2)
                : horizontalSteps * 16;
            const verticalSteps = hasLayerData
                ? Math.ceil(Math.abs(endCell.z - cz) / MAX_LAYER_STEP)
                : 0;
            return Math.max(horizontalDistance, verticalSteps * 16);
        };
        const reachedGoal = (node) => {
            if (goalRadius <= 0) {
                return node.cx === endCx
                    && node.cy === endCy
                    && (!hasLayerData || node.cz === endCell.z);
            }
            const dx = ((node.cx << 4) + 8) - endX;
            const dy = ((node.cy << 4) + 8) - endY;
            return Math.hypot(dx, dy) <= goalRadius
                && (!hasLayerData || Math.abs(node.cz - endCell.z) <= goalZTolerance);
        };

        const immediate = { cx: startCx, cy: startCy, cz: startCell.z };
        if (reachedGoal(immediate)) {
            if (GardenOfEvaBarriers.blocks(startX, startY, startZ, endX, endY, endZ)) return null;
            if (goalRadius > 0) {
                return [{ locX: startX, locY: startY, locZ: startZ }];
            }
            return [{ locX: endX, locY: endY, locZ: endZ }];
        }

        const startNode = {
            cx: startCx,
            cy: startCy,
            cz: startCell.z,
            g: 0,
            h: heuristic(startCx, startCy, startCell.z),
            f: 0,
            parent: null
        };
        startNode.f = startNode.g + heuristicWeight * startNode.h;

        let insertOrder = 0;
        startNode.order = insertOrder++;
        const openList = new BinaryMinHeap((left, right) => (
            left.f - right.f || left.h - right.h || left.order - right.order
        ));
        openList.push(startNode);
        const bestCosts = new Map();
        bestCosts.set(`${startCx},${startCy},${startCell.z}`, 0);

        let targetNode = null;
        let nodesExpanded = 0;

        while (openList.length > 0) {
            const current = openList.shift();
            const currentKey = `${current.cx},${current.cy},${current.cz}`;
            if (current.g !== bestCosts.get(currentKey)) {
                continue;
            }

            nodesExpanded++;
            if ((nodesExpanded & 127) === 0) yield;
            if (nodesExpanded > maxNodes) {
                break;
            }

            if (reachedGoal(current)) {
                targetNode = current;
                break;
            }

            const currentCell = this.getCellData((current.cx << 4) + 8, (current.cy << 4) + 8, current.cz);
            for (const dir of NEIGHBOURS) {
                const nCx = current.cx + dir.dx;
                const nCy = current.cy + dir.dy;
                const nCell = this.stepTo(currentCell, nCx, nCy, dir.exit);
                if (!nCell) continue;
                const key = `${nCx},${nCy},${nCell.z}`;

                if (GardenOfEvaBarriers.blocks((current.cx << 4) + 8, (current.cy << 4) + 8, current.cz,
                    (nCx << 4) + 8, (nCy << 4) + 8, nCell.z)) continue;

                const g = current.g + 16;
                const previousCost = bestCosts.get(key);
                if (previousCost !== undefined && previousCost <= g) {
                    continue;
                }

                const h = heuristic(nCx, nCy, nCell.z);
                const f = g + heuristicWeight * h;

                const neighbor = {
                    cx: nCx,
                    cy: nCy,
                    cz: nCell.z,
                    g: g,
                    h: h,
                    f: f,
                    parent: current,
                    order: insertOrder++
                };

                bestCosts.set(key, g);
                openList.push(neighbor);
            }
        }
        
        if ((invoke('GameServer/Bot/Population/PopulationConfig').developerDiagnostics === true) && options.debug !== false) {
            console.log(`findPath :: nodesExpanded = ${nodesExpanded}, targetNodeFound = ${!!targetNode}`);
        }

        let node = targetNode;
        if (!node) {
            return null;
        }

        const pathPoints = [];
        while (node) {
            pathPoints.push({
                locX: (node.cx << 4) + 8,
                locY: (node.cy << 4) + 8,
                locZ: node.cz
            });
            node = node.parent;
        }
        pathPoints.reverse();

        const smoothedPath = [];
        if (pathPoints.length > 0) {
            smoothedPath.push(pathPoints[0]);
            let currentIdx = 0;

            while (currentIdx < pathPoints.length - 1) {
                yield;
                let checkIdx = pathPoints.length - 1;
                while (checkIdx > currentIdx + 1) {
                    if ((checkIdx & 31) === 0) yield;
                    const startPt = pathPoints[currentIdx];
                    const endPt = pathPoints[checkIdx];
                    if (this.canWalkStraight(startPt.locX, startPt.locY, startPt.locZ, endPt.locX, endPt.locY, endPt.locZ)) {
                        break;
                    }
                    checkIdx--;
                }
                smoothedPath.push(pathPoints[checkIdx]);
                currentIdx = checkIdx;
            }
        }

        if (smoothedPath.length > 0 && goalRadius <= 0) {
            smoothedPath[smoothedPath.length - 1] = {
                locX: endX,
                locY: endY,
                locZ: endZ
            };
        }

        // Replacing cell centres with exact endpoints must not bridge a wall
        // inside a single geodata cell, including the first approach segment.
        let previous = { locX: startX, locY: startY, locZ: startZ };
        for (const point of smoothedPath) {
            if (GardenOfEvaBarriers.blocks(previous.locX, previous.locY, previous.locZ,
                point.locX, point.locY, point.locZ)) return null;
            previous = point;
        }

        return smoothedPath;
    },

    buildOffsetIndex(buffer, index = new Int32Array(256 * 256)) {
        let offset = 0;
        let blockCount = 0;
        const totalBlocks = 256 * 256;

        while (offset < buffer.length && blockCount < totalBlocks) {
            index[blockCount] = offset;
            const type = buffer.readUInt8(offset);
            offset += 1;

            if (type === 0) {
                offset += 2;
            } else if (type === 1) {
                offset += 128;
            } else if (type === 2) {
                for (let i = 0; i < 64; i++) {
                    const layers = buffer.readUInt8(offset);
                    offset += 1 + (layers * 2);
                }
            }
            blockCount++;
        }
        return index;
    }
};

module.exports = GeodataEngine;
