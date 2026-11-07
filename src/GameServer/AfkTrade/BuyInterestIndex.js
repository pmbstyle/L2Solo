'use strict';
const { fnv1a32 } = require('../Bot/Fnv1a');
const EMPTY = Object.freeze([]);

// Public quotes only. An owner's overlapping ads/shop are one demand: the
// maximum quoted remainder at each accepted price, with backed units first.
function ownerCurve(lines) {
    const ordered = [...lines.values()].sort((a, b) => b.price - a.price);
    const points = [];
    let backed = 0, total = 0;
    for (let at = 0; at < ordered.length;) {
        const price = ordered[at].price;
        do {
            const line = ordered[at++];
            total = Math.max(total, line.count);
            if (line.custodyPolicy !== 1) backed = Math.max(backed, line.count);
        } while (at < ordered.length && ordered[at].price === price);
        points.push([price, backed, total - backed, 1]);
    }
    return points;
}
function atPrice(points, price) {
    let lo = 0, hi = points.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (points[mid][0] >= price) lo = mid + 1;
        else hi = mid;
    }
    return lo ? points[lo - 1] : [0, 0, 0, 0];
}
function digestChange(digest, hash, step) {
    digest[0] = (digest[0] ^ hash) >>> 0;
    digest[1] = (digest[1] + step * hash) >>> 0;
    digest[2] += step;
}
class BuyInterestIndex {
    constructor() { this.items = new Map(); }
    clear() { this.items.clear(); }
    change(line, step) {
        if (line.storeType !== 3 || line.enchant || !line.town || !(line.price > 0)
            || !Number.isFinite(line.price) || !Number.isSafeInteger(line.count) || line.count <= 0
            || !Number.isSafeInteger(line.ownerId) || line.ownerId <= 0) return;
        let towns = this.items.get(line.selfId), group = towns?.get(line.town);
        if (!group && step < 0) return;
        if (!towns) { towns = new Map(); this.items.set(line.selfId, towns); }
        if (!group) {
            group = { owners: new Map(), levels: new Map(), digest: [0, 0, 0], curve: null };
            towns.set(line.town, group);
        }
        let owner = group.owners.get(line.ownerId);
        if (!owner) { owner = { lines: new Map(), points: EMPTY, digest: [0, 0, 0] }; group.owners.set(line.ownerId, owner); }
        const apply = (points, direction) => {
            let previous = [0, 0, 0, 0];
            for (const point of points) {
                const delta = group.levels.get(point[0]) || [0, 0, 0];
                for (let i = 0; i < 3; i++) delta[i] += direction * (point[i + 1] - previous[i + 1]);
                if (delta.some(value => value !== 0)) group.levels.set(point[0], delta);
                else group.levels.delete(point[0]);
                previous = point;
            }
        };
        apply(owner.points, -1);
        const key = `${line.recordId}:${line.lineId}`;
        if (step > 0) owner.lines.set(key, line);
        else owner.lines.delete(key);
        const hash = fnv1a32(JSON.stringify([line.recordId, line.lineId, line.revision, line.ownerId,
            line.selfId, line.town, line.count, line.price, line.custodyPolicy]));
        digestChange(group.digest, hash, step); digestChange(owner.digest, hash, step);
        owner.points = ownerCurve(owner.lines);
        apply(owner.points, 1); group.curve = null;
        if (!owner.lines.size) group.owners.delete(line.ownerId);
        if (!group.owners.size) towns.delete(line.town);
        if (!towns.size) this.items.delete(line.selfId);
    }
    towns(selfId) { return [...(this.items.get(Number(selfId))?.keys() || [])]; }
    snapshot(selfId, town, excludeOwner = 0) {
        const group = this.items.get(Number(selfId))?.get(town);
        if (!group) return null;
        if (!group.curve) {
            let backed = 0, conditional = 0, buyers = 0;
            group.curve = [...group.levels].sort((a, b) => b[0] - a[0]).map(([price, delta]) => {
                backed += delta[0]; conditional += delta[1]; buyers += delta[2];
                return Object.freeze([price, backed, conditional, buyers]);
            });
        }
        const own = group.owners.get(Number(excludeOwner));
        const digest = group.digest.slice();
        if (own) {
            digest[0] = (digest[0] ^ own.digest[0]) >>> 0;
            digest[1] = (digest[1] - own.digest[1]) >>> 0; digest[2] -= own.digest[2];
        }
        return { points: group.curve, own: own?.points || EMPTY,
            revision: fnv1a32(JSON.stringify([selfId, town, digest])) + 1 };
    }
}
function quantities(view, price) {
    if (!view || !(price > 0) || !Number.isFinite(price)) return null;
    const all = atPrice(view.points, price), own = atPrice(view.own, price);
    const backedUnits = all[1] - own[1], conditionalUnits = all[2] - own[2], buyers = all[3] - own[3];
    const applicableUnits = backedUnits + conditionalUnits;
    return buyers >= 2 && [backedUnits, conditionalUnits, applicableUnits].every(n => Number.isSafeInteger(n) && n >= 0)
        ? { applicableUnits, backedUnits, conditionalUnits, buyers } : null;
}
module.exports = { BuyInterestIndex, quantities };
