const Corridor = invoke('GameServer/Geodata/TownPathCorridor');
const Geodata = invoke('GameServer/Geodata/GeodataEngine');

const CELL = 192;
const MAX_CANDIDATES = 48;
const MAX_NEIGHBORS = 8;
const MAX_ACTORS = 2048;
const STALE_MS = 3500;
const WINDOW_MS = 50;
const BUDGET_MS = 1;

class TownTraffic {
    constructor() {
        this.cells = new Map();
        this.actors = new Map();
        this.windowAt = 0;
        this.spentMs = 0;
        this.metrics = { queries: 0, candidates: 0, maxCandidates: 0, detours: 0, yields: 0, deferred: 0, maxWorkMs: 0 };
    }

    remove(id) {
        const entry = this.actors.get(id);
        if (!entry) return;
        const cell = this.cells.get(entry.cell);
        cell.delete(id);
        if (!cell.size) this.cells.delete(entry.cell);
        this.actors.delete(id);
    }

    update(id, point, to = point, speed = 0, now = Date.now()) {
        this.remove(id);
        // At most four stale entries per update, with an independent hard cap.
        for (let n = 0; n < 4 && this.actors.size; n++) {
            const oldest = this.actors.values().next().value;
            if (now - oldest.at <= STALE_MS && this.actors.size < MAX_ACTORS) break;
            this.remove(oldest.id);
        }
        const cell = `${Math.floor(point.locX / CELL)}:${Math.floor(point.locY / CELL)}`;
        const length = Corridor.distance(point, to) || 1;
        const entry = { id, ...point, cell, at: now,
            vx: (to.locX - point.locX) / length * speed, vy: (to.locY - point.locY) / length * speed };
        if (!this.cells.has(cell)) this.cells.set(cell, new Map());
        this.cells.get(cell).set(id, entry);
        this.actors.set(id, entry);
    }

    neighbors(id, point, now) {
        const x = Math.floor(point.locX / CELL), y = Math.floor(point.locY / CELL);
        const found = [];
        let inspected = 0;
        outer: for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
            const cell = this.cells.get(`${x + dx}:${y + dy}`);
            if (!cell) continue;
            for (const entry of cell.values()) {
                if (++inspected > MAX_CANDIDATES) break outer;
                if (entry.id === id || now - entry.at > STALE_MS || Math.abs(entry.locZ - point.locZ) > 48) continue;
                const distance = Corridor.distance(point, entry);
                if (distance < CELL) found.push({ ...entry, distance });
            }
        }
        this.metrics.candidates += Math.min(inspected, MAX_CANDIDATES);
        this.metrics.maxCandidates = Math.max(this.metrics.maxCandidates, Math.min(inspected, MAX_CANDIDATES));
        return found.sort((a, b) => a.distance - b.distance).slice(0, MAX_NEIGHBORS);
    }

    steer(session, actor, point, to, nearestPlayer, now = Date.now()) {
        if (nearestPlayer > 1500 || now < Number(session.townSteerAt || 0) || Corridor.distance(point, to) < 100) return null;
        session.townSteerAt = now + 500;
        const started = performance.now();
        if (started - this.windowAt >= WINDOW_MS) { this.windowAt = started; this.spentMs = 0; }
        if (this.spentMs >= BUDGET_MS) { this.metrics.deferred++; return null; }
        try {
            this.metrics.queries++;
            const id = Number(actor.fetchId());
            const speed = actor.fetchCollectiveRunSpd() || 120;
            const length = Corridor.distance(point, to);
            const ux = (to.locX - point.locX) / length, uy = (to.locY - point.locY) / length;
            const neighbors = this.neighbors(id, point, now);
            const blocker = neighbors.find((other) => {
                const dx = other.locX - point.locX, dy = other.locY - point.locY;
                const ahead = dx * ux + dy * uy;
                if (ahead < 0 || ahead > 170) return false;
                const futureX = dx + (other.vx - ux * speed) * 0.7;
                const futureY = dy + (other.vy - uy * speed) * 0.7;
                return Math.abs(dx * uy - dy * ux) < 40
                    && (Math.hypot(futureX, futureY) < 64 || other.distance < 72);
            });
            if (!blocker || id < blocker.id) return null;
            // At most one course correction per four seconds per actor.
            session.townSteerAt = now + 4000;
            if (length <= 1000) {
                for (const sign of [1, -1]) {
                    if (performance.now() - started + this.spentMs >= BUDGET_MS) break;
                    const ahead = Math.min(160, length * 0.6);
                    const candidate = {
                        locX: Math.round(point.locX + ux * ahead - uy * 64 * sign),
                        locY: Math.round(point.locY + uy * ahead + ux * 64 * sign), locZ: point.locZ
                    };
                    candidate.locZ = Geodata.getHeight(candidate.locX, candidate.locY, candidate.locZ);
                    if (Math.abs(candidate.locZ - point.locZ) > 32 || neighbors.some((n) => Corridor.distance(n, candidate) < 48)) continue;
                    if (Corridor.clearSegment(point, candidate) && Corridor.clearSegment(candidate, to)) {
                        this.metrics.detours++;
                        return { point: candidate };
                    }
                }
            }
            this.metrics.yields++;
            return { waitMs: 350 + id % 250 };
        } finally {
            const work = performance.now() - started;
            this.spentMs += work;
            this.metrics.maxWorkMs = Math.max(this.metrics.maxWorkMs, work);
        }
    }

    stats() { return { ...this.metrics, actors: this.actors.size, cells: this.cells.size }; }
}

const traffic = new TownTraffic();
module.exports = traffic;
module.exports.TownTraffic = TownTraffic;
module.exports.MAX_CANDIDATES = MAX_CANDIDATES;
