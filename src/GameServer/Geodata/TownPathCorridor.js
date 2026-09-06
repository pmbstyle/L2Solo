const Geodata = invoke('GameServer/Geodata/GeodataEngine');

const SPACING = 640;
const MAX_POINTS = 128;
const OFFSETS = [-80, -56, -32, -16, 16, 32, 56, 80];

function distance(a, b) { return Math.hypot(a.locX - b.locX, a.locY - b.locY); }
function visible(a, b) {
    return Geodata.hasLineOfSight(a.locX, a.locY, a.locZ, b.locX, b.locY, b.locZ);
}

// This is deliberately stricter than the existing point-actor pathfinder.
// Only optional lane offsets require clearance; narrow passages retain their
// original validated path instead of becoming unreachable for existing bots.
function clearSegment(a, b, radius = 12) {
    if (!visible(a, b)) return false;
    const length = distance(a, b) || 1;
    const dx = -(b.locY - a.locY) / length * radius;
    const dy = (b.locX - a.locX) / length * radius;
    for (const sign of [-1, 1]) {
        const first = { locX: Math.round(a.locX + dx * sign), locY: Math.round(a.locY + dy * sign), locZ: a.locZ };
        const last = { locX: Math.round(b.locX + dx * sign), locY: Math.round(b.locY + dy * sign), locZ: b.locZ };
        if (!visible(a, first) || !visible(b, last) || !visible(first, last)) return false;
    }
    return true;
}

function samples(path) {
    const result = [{ ...path[0] }];
    for (let index = 1; index < path.length; index++) {
        const a = path[index - 1], b = path[index];
        const count = Math.max(path.length === 2 && distance(a, b) > 240 ? 2 : 1, Math.ceil(distance(a, b) / SPACING));
        if (result.length + count > MAX_POINTS) return null;
        for (let step = 1; step < count; step++) {
            const ratio = step / count;
            const point = {
                locX: Math.round(a.locX + (b.locX - a.locX) * ratio),
                locY: Math.round(a.locY + (b.locY - a.locY) * ratio),
                locZ: Math.round(a.locZ + (b.locZ - a.locZ) * ratio)
            };
            point.locZ = Geodata.getHeight(point.locX, point.locY, point.locZ);
            // Splitting a multilayer segment must not select an unrelated roof.
            if (!visible(result[result.length - 1], point) || !visible(point, b)) continue;
            result.push(point);
        }
        result.push({ ...b });
    }
    return result;
}

function build(path, checkBudget = () => {}) {
    if (!Array.isArray(path) || path.length < 2) return { path, lanes: [] };
    try {
        checkBudget();
        const center = samples(path);
        if (!center) return { path, lanes: [] };
        const lanes = OFFSETS.map((offset) => {
            const lane = [{ ...center[0] }];
            for (let index = 1; index < center.length - 1; index++) {
                checkBudget();
                const previous = lane[lane.length - 1];
                const base = center[index], next = center[index + 1];
                const tangent = center[index - 1];
                const length = distance(tangent, next) || 1;
                let selected = base;
                for (const scale of [1, 0.5]) {
                    const candidate = {
                        locX: Math.round(base.locX - (next.locY - tangent.locY) / length * offset * scale),
                        locY: Math.round(base.locY + (next.locX - tangent.locX) / length * offset * scale),
                        locZ: base.locZ
                    };
                    candidate.locZ = Geodata.getHeight(candidate.locX, candidate.locY, base.locZ);
                    if (Math.abs(candidate.locZ - base.locZ) > 32 || !visible(base, candidate)) continue;
                    if (clearSegment(previous, candidate) && clearSegment(candidate, next)) {
                        selected = candidate;
                        break;
                    }
                }
                lane.push({ ...selected });
            }
            lane.push({ ...center[center.length - 1] });
            return lane;
        });
        return { path, lanes };
    } catch (error) {
        // Optional diversity must not discard a path A* already found.
        // Cancellation still propagates so an abandoned journey stays dead.
        if (error?.code === 'PATH_BUDGET') return { path, lanes: [] };
        throw error;
    }
}

module.exports = { build, visible, clearSegment, distance, SPACING, MAX_POINTS, OFFSETS };
