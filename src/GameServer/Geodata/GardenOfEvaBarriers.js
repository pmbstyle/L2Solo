// Pure geometry and shared state: also loaded by pathfinding and cold workers.
const { doors } = require('../../../data/World/garden_of_eva_doors.json');
// All 24 walls have the same initial state and cycle in the C4 reference.
// 0 = inactive (world not started), 1 = closed, 2 = open.
let state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
const bounds = {
    minX: Math.min(...doors.map(door => door.bounds.minX)), maxX: Math.max(...doors.map(door => door.bounds.maxX)),
    minY: Math.min(...doors.map(door => door.bounds.minY)), maxY: Math.max(...doors.map(door => door.bounds.maxY)),
    minZ: Math.min(...doors.map(door => door.bounds.minZ)), maxZ: Math.max(...doors.map(door => door.bounds.maxZ))
};

function overlaps(box, x, y, z, tx, ty, tz) {
    return Math.max(x, tx) >= box.minX && Math.min(x, tx) <= box.maxX
        && Math.max(y, ty) >= box.minY && Math.min(y, ty) <= box.maxY
        && Math.max(z, tz) >= box.minZ && Math.min(z, tz) <= box.maxZ;
}

function intersection(x, y, z, tx, ty, tz) {
    if (Atomics.load(state, 0) !== 1 || !overlaps(bounds, x, y, z, tx, ty, tz)) return null;
    let first = null;
    for (const door of doors) {
        const box = door.bounds;
        if (!overlaps(box, x, y, z, tx, ty, tz)) continue;
        // Lisvus DoorTable: the vertical plane through the bounds' XY diagonal.
        // A plane also handles the exactly zero-width goe_005 water wall.
        const a = box.maxY - box.minY, b = box.minX - box.maxX;
        const denominator = a * (tx - x) + b * (ty - y);
        if (denominator === 0) continue;
        const ratio = -(a * (x - box.minX) + b * (y - box.minY)) / denominator;
        // Someone standing on the plane when it closes can step away from it.
        if (ratio <= 0 || ratio > 1 || first !== null && ratio >= first) continue;
        const px = x + (tx - x) * ratio, py = y + (ty - y) * ratio, pz = z + (tz - z) * ratio;
        if (px >= box.minX && px <= box.maxX && py >= box.minY && py <= box.maxY
            && pz >= box.minZ && pz <= box.maxZ) first = ratio;
    }
    return first;
}

function blocks(fromX, fromY, fromZ, toX, toY, toZ) {
    return intersection(fromX, fromY, fromZ, toX, toY, toZ) !== null;
}

function clip(from, to) {
    const hit = intersection(from.locX, from.locY, from.locZ, to.locX, to.locY, to.locZ);
    if (hit === null) return to;
    const distance = Math.hypot(to.locX - from.locX, to.locY - from.locY);
    const ratio = Math.max(0, hit - 16 / Math.max(1, distance));
    return { ...to, locX: Math.round(from.locX + (to.locX - from.locX) * ratio),
        locY: Math.round(from.locY + (to.locY - from.locY) * ratio),
        locZ: Math.round(from.locZ + (to.locZ - from.locZ) * ratio) };
}

function attach(buffer) {
    if (!(buffer instanceof SharedArrayBuffer) || buffer.byteLength !== Int32Array.BYTES_PER_ELEMENT)
        throw Error('Invalid Garden of Eva barrier state');
    state = new Int32Array(buffer);
}

module.exports = { blocks, clip, sharedBuffer: () => state.buffer, attach,
    setOpen: open => Atomics.store(state, 0, open ? 2 : 1), reset: () => Atomics.store(state, 0, 0) };
