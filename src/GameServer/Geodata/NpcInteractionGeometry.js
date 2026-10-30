const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');

const EYE_HEIGHT = 48;
let cachedKey, cached;
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const keyFor = target => `${Number(target.npcSelfId)}:${Math.round(target.locX)}:${Math.round(target.locY)}`;

function geometry() {
    const directory = Geodata.getGeodataDir();
    const key = `${directory}:${Geodata.navigationRevision || 0}`;
    if (key === cachedKey) return cached;
    cachedKey = key;
    cached = null;
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, '.l2solo-geodata-manifest.json')));
        const info = manifest.interactionGeometry;
        if (info?.file !== 'npc-interaction-geometry.json' || !Number.isSafeInteger(info.bytes)
            || info.bytes <= 0 || !/^[a-f0-9]{64}$/.test(info.sha256)) return null;
        const bytes = fs.readFileSync(path.join(directory, info.file));
        if (bytes.length !== info.bytes || digest(bytes) !== info.sha256) return null;
        const data = JSON.parse(bytes);
        if (data.schemaVersion !== 1 || !Number.isFinite(data.radius) || data.radius < 144 || !Array.isArray(data.records)
            || !Array.isArray(data.triangles) || data.triangles.length % 9 !== 0
            || !data.triangles.every(Number.isFinite)) return null;
        const records = new Map();
        for (const record of data.records) {
            if (![record.id, record.x, record.y, record.z].every(Number.isFinite)
                || record.region !== Geodata.getRegionKey(record.x, record.y)
                || !Array.isArray(record.triangles) || !record.triangles.length
                || !record.triangles.every(i => Number.isSafeInteger(i) && i >= 0 && i < data.triangles.length / 9)) return null;
            const targetKey = keyFor({ npcSelfId: record.id, locX: record.x, locY: record.y });
            if (records.has(targetKey)) return null;
            records.set(targetKey, { ...record, triangles: Uint32Array.from(record.triangles) });
        }
        cached = { records, triangles: Float64Array.from(data.triangles), regions: new Map(), sourceRegions: data.sourceRegions || {} };
    } catch (_) { /* Packs without verified client geometry retain strict walking LOS. */ }
    return cached;
}

function coplanarIntersection(a, b, triangle, normal) {
    const drop = normal.reduce((axis, value, i) => Math.abs(value) > Math.abs(normal[axis]) ? i : axis, 0);
    const project = point => point.filter((_, axis) => axis !== drop);
    const first = project(a), last = project(b);
    const vertices = [project(Array.from(triangle.subarray(0, 3))),
        project(Array.from(triangle.subarray(3, 6))), project(Array.from(triangle.subarray(6, 9)))];
    const epsilon = 1e-7;
    const orientation = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const onSegment = (p, q, r) => Math.abs(orientation(p, q, r)) <= epsilon
        && r[0] >= Math.min(p[0], q[0]) - epsilon && r[0] <= Math.max(p[0], q[0]) + epsilon
        && r[1] >= Math.min(p[1], q[1]) - epsilon && r[1] <= Math.max(p[1], q[1]) + epsilon;
    const inside = point => {
        const sides = vertices.map((vertex, i) => orientation(vertex, vertices[(i + 1) % 3], point));
        return sides.every(side => side >= -epsilon) || sides.every(side => side <= epsilon);
    };
    if (inside(first) || inside(last)) return true;
    return vertices.some((vertex, i) => {
        const next = vertices[(i + 1) % 3];
        const p = orientation(first, last, vertex), q = orientation(first, last, next);
        const r = orientation(vertex, next, first), s = orientation(vertex, next, last);
        return (p * q < 0 && r * s < 0) || onSegment(first, last, vertex)
            || onSegment(first, last, next) || onSegment(vertex, next, first) || onSegment(vertex, next, last);
    });
}

function intersects(a, b, values, index) {
    const t = values.subarray(index * 9, index * 9 + 9);
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    for (let axis = 0; axis < 3; axis++) {
        if (Math.max(a[axis], b[axis]) < Math.min(t[axis], t[axis + 3], t[axis + 6])
            || Math.min(a[axis], b[axis]) > Math.max(t[axis], t[axis + 3], t[axis + 6])) return false;
    }
    const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const e1 = [t[3] - t[0], t[4] - t[1], t[5] - t[2]];
    const e2 = [t[6] - t[0], t[7] - t[1], t[8] - t[2]];
    const offset = [a[0] - t[0], a[1] - t[1], a[2] - t[2]];
    const p = cross(d, e2), det = dot(e1, p);
    if (Math.abs(det) < 1e-8) {
        const normal = cross(e1, e2), length = Math.hypot(...normal);
        if (length < 1e-8 || Math.abs(dot(normal, offset)) > 1e-7 * length) return false;
        return coplanarIntersection(a, b, t, normal);
    }
    const u = dot(offset, p) / det;
    if (u < -1e-7 || u > 1 + 1e-7) return false;
    const q = cross(offset, e1), v = dot(d, q) / det;
    if (v < -1e-7 || u + v > 1 + 1e-7) return false;
    const distance = dot(e2, q) / det;
    return distance >= -1e-7 && distance <= 1 + 1e-7;
}

function canSee(from, target) {
    const data = geometry(), record = data?.records.get(keyFor(target));
    if (!record || Math.abs(target.locZ - record.z) > 32
        || Math.hypot(from.locX - record.x, from.locY - record.y) > 144
        || Math.abs(from.locZ - target.locZ) > 16) return false;
    if (!data.regions.has(record.region)) {
        const [x, y] = record.region.split('_').map(Number);
        const bytes = Geodata.getRegionBuffer(x, y);
        data.regions.set(record.region, !!bytes && digest(bytes) === data.sourceRegions[record.region]);
    }
    if (!data.regions.get(record.region)) return false;
    const a = [from.locX, from.locY, from.locZ + EYE_HEIGHT];
    const b = [target.locX, target.locY, target.locZ + EYE_HEIGHT];
    return !record.triangles.some(index => intersects(a, b, data.triangles, index));
}

module.exports = { canSee, init: geometry };
