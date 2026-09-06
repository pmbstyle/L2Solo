const Geodata = invoke('GameServer/Geodata/GeodataEngine');
const Corridor = invoke('GameServer/Geodata/TownPathCorridor');

const CACHE_LIMIT = 256;
const POINT_LIMIT = 32768;
const CACHE_TTL_MS = 120000;
const NEGATIVE_TTL_MS = 3000;
const services = new WeakMap();

function enabled() { return process.env.L2_TOWN_NAVIGATION !== '0'; }
function startOf(r) { return { locX: r.startX, locY: r.startY, locZ: r.startZ }; }
function endOf(r) { return { locX: r.endX, locY: r.endY, locZ: r.endZ }; }
function hash(value) {
    let h = 2166136261;
    for (const c of String(value)) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h;
}
function keyOf(r, priority, exact = false) {
    const xy = (n) => exact ? n : Math.floor(n / 128);
    return [exact ? 'exact' : 'tile', r.town, priority, Geodata.navigationRevision || 0,
        xy(r.startX), xy(r.startY), r.startZ, xy(r.endX), xy(r.endY), r.endZ,
        r.goalRadius || 0, r.goalZTolerance || 0, r.maxNodes].join(':');
}
function staleError() { return Object.assign(new Error('stale town route'), { code: 'STALE_PATH' }); }

class TownNavigation {
    constructor(pool) {
        this.pool = pool;
        this.cache = new Map();
        this.groups = new Map();
        this.consumers = new Map();
        this.points = 0;
        this.sequence = 0;
        this.deliveries = [];
        this.deliveryScheduled = false;
        this.metrics = { hits: 0, misses: 0, joined: 0, rejectedConnectors: 0, evicted: 0 };
    }

    deliver(callback, onError) {
        this.deliveries.push({ callback, onError });
        if (this.deliveryScheduled) return;
        this.deliveryScheduled = true;
        const drain = () => {
            const started = performance.now();
            let count = 0;
            while (this.deliveries.length && count++ < 8 && performance.now() - started < 1) {
                const job = this.deliveries.shift();
                try { job.callback(); } catch (error) { job.onError(error); }
            }
            if (this.deliveries.length) setImmediate(drain);
            else this.deliveryScheduled = false;
        };
        setImmediate(drain);
    }

    adapt(result, request, actorKey) {
        if (!result?.path?.length) return result?.path || null;
        const choices = result.lanes?.length ? result.lanes : [result.path];
        const path = choices[hash(actorKey) % choices.length].map((p) => ({ ...p }));
        const from = startOf(request), to = endOf(request);
        if (Corridor.distance(from, path[0]) > 192 || Math.abs(from.locZ - path[0].locZ) > 64) return undefined;
        // Join ahead without funnelling everyone back to the cache's origin.
        const join = path.length > 1 && Corridor.distance(from, path[1]) <= 1000 ? 1 : 0;
        if (!Corridor.visible(from, path[join])) return undefined;
        path.splice(0, join, { ...from });
        const last = path[path.length - 1];
        if (Corridor.distance(last, to) > 256 || Math.abs(last.locZ - to.locZ) > 64) return undefined;
        const original = result.request;
        const sameDestination = original && original.endX === request.endX && original.endY === request.endY && original.endZ === request.endZ;
        if (!sameDestination && !Corridor.visible(last, to)) return undefined;
        if (Corridor.distance(last, to) > Number(request.goalRadius || 0)) path.push({ ...to });
        return path;
    }

    store(key, result) {
        const count = (result?.path?.length || 0) + (result?.lanes || []).reduce((n, p) => n + p.length, 0);
        if (count > POINT_LIMIT) return;
        if (this.cache.has(key)) this.remove(key);
        while (this.cache.size >= CACHE_LIMIT || this.points + count > POINT_LIMIT) this.remove(this.cache.keys().next().value);
        this.points += count;
        this.cache.set(key, { result, count, until: Date.now() + (count ? CACHE_TTL_MS : NEGATIVE_TTL_MS) });
    }

    remove(key) {
        const entry = this.cache.get(key);
        if (!entry) return;
        this.points -= entry.count;
        this.cache.delete(key);
        this.metrics.evicted++;
    }

    request(request, options = {}, exact = false) {
        const actorKey = options.key;
        const revision = Geodata.navigationRevision || 0;
        this.cancel(actorKey);
        if (this.consumers.size + this.deliveries.length >= 2048) return Promise.reject(Object.assign(new Error('town route delivery queue is full'), { code: 'QUEUE_FULL' }));
        if (!exact && this.cache.get(keyOf(request, options.priority, true))?.until > Date.now()) return this.request(request, options, true);
        const key = keyOf(request, options.priority, exact);
        const entry = this.cache.get(key);
        if (entry && entry.until > Date.now()) {
            // Negative results are exact-coordinate only: a nearby door may
            // be reachable even when a point on the other side is not.
            return new Promise((resolve, reject) => {
                const consumer = { group: null, reject, cancelled: false };
                this.consumers.set(actorKey, consumer);
                this.deliver(() => {
                    if (consumer.cancelled) return;
                    if (revision !== (Geodata.navigationRevision || 0)) throw staleError();
                    const path = this.adapt(entry.result, request, actorKey);
                    this.finish(actorKey, consumer);
                    if (path !== undefined) {
                        this.metrics.hits++;
                        // Another delivery may have evicted this entry already.
                        if (this.cache.get(key) === entry) { this.cache.delete(key); this.cache.set(key, entry); }
                        resolve(path);
                    } else {
                        this.metrics.rejectedConnectors++;
                        if (exact) this.remove(key);
                        resolve(this.request(request, options, true));
                    }
                }, (error) => { this.finish(actorKey, consumer); reject(error); });
            });
        } else if (entry) this.remove(key);

        let group = this.groups.get(key);
        if (group) this.metrics.joined++;
        else {
            this.metrics.misses++;
            group = { key, request, workerKey: `${options.priority >= 100 ? 'companion:town' : 'town'}:${++this.sequence}`, consumers: new Set() };
            this.groups.set(key, group);
            group.promise = this.pool.request({ ...request, townCorridor: true, navigationRevision: Geodata.navigationRevision || 0 }, { ...options, key: group.workerKey });
        }
        return new Promise((resolve, reject) => {
            const consumer = { group, reject, cancelled: false };
            this.consumers.set(actorKey, consumer);
            group.consumers.add(consumer);
            group.promise.then((value) => this.deliver(() => {
                if (consumer.cancelled) return;
                if (revision !== (Geodata.navigationRevision || 0)) {
                    if (this.groups.get(key) === group) this.groups.delete(key);
                    throw staleError();
                }
                const result = Array.isArray(value) || !value ? { path: value, lanes: [] } : value;
                result.request = group.request;
                if (this.groups.get(key) === group) {
                    this.groups.delete(key);
                    if (result?.path?.length || exact) this.store(key, result);
                    else this.store(keyOf(group.request, options.priority, true), result);
                }
                this.finish(actorKey, consumer);
                if (!result.path?.length && !exact && (
                    request.startX !== group.request.startX || request.startY !== group.request.startY
                    || request.endX !== group.request.endX || request.endY !== group.request.endY
                )) { resolve(this.request(request, options, true)); return; }
                const path = this.adapt(result, request, actorKey);
                if (path === undefined && !exact) {
                    this.metrics.rejectedConnectors++;
                    resolve(this.request(request, options, true));
                } else resolve(path === undefined ? result.path : path);
            }, (error) => { this.finish(actorKey, consumer); reject(error); }), (error) => {
                if (this.groups.get(key) === group) this.groups.delete(key);
                if (consumer.cancelled) return;
                this.finish(actorKey, consumer);
                reject(error);
            });
        });
    }

    finish(key, consumer) {
        consumer.group?.consumers.delete(consumer);
        if (this.consumers.get(key) === consumer) this.consumers.delete(key);
    }

    cancel(key) {
        const consumer = this.consumers.get(key);
        if (!consumer) return false;
        consumer.cancelled = true;
        this.finish(key, consumer);
        consumer.reject(staleError());
        if (consumer.group && !consumer.group.consumers.size) {
            if (this.groups.get(consumer.group.key) === consumer.group) this.groups.delete(consumer.group.key);
            this.pool.cancel(consumer.group.workerKey);
        }
        return true;
    }

    stats() { return { ...this.metrics, entries: this.cache.size, points: this.points, pending: this.groups.size, consumers: this.consumers.size }; }
}

function forPool(pool) {
    if (!services.has(pool)) services.set(pool, new TownNavigation(pool));
    return services.get(pool);
}

module.exports = { TownNavigation, forPool, enabled, CACHE_LIMIT, POINT_LIMIT, hash };
