'use strict';

const LIMITS = Object.freeze({ rosters: 8, hydratedBots: 72, forecasts: 12, socialChecks: 288, sliceMs: 2, forecastCpuMs: 12,
    // The forecast CPU allowance refills by forecastCpuMs per this window (a rate, not a search cadence).
    forecastRefillMs: 60000 });
const RECENT_LIMIT = 2048;
const counts = () => ({ searches: 0, rosterAttempts: 0, rostersProposed: 0, rostersAssessed: 0,
    forecasts: 0, forecastWorkMs: 0, forecastFailures: 0, socialChecks: 0, hydratedBots: 0, formations: 0, preparationsStarted: 0 });
const rejections = () => ({ assembly: {}, target: {}, forecast: {}, admission: {} });
function increment(map, reason) {
    reason = typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason) ? reason : 'other';
    if (!Object.hasOwn(map, reason) && Object.keys(map).length >= 64) reason = 'other';
    map[reason] = (map[reason] || 0) + 1;
}
class RaidSearchCounters {
    constructor() { this.pendingRosters = 0; this.cpuBudget = { availableMs: LIMITS.forecastCpuMs, debtMs: 0, deferredSearches: 0 }; this.sinceAt = Date.now(); this.total = counts(); this.rejections = rejections(); this.additionalReasons = {}; this.unchecked = {}; this.recent = new Map(); }
    // woken: the situation that made the search due (OpportunisticRaidDirector.wake), counted.
    begin(at, woken = null) { this.last = { at, woken, ...counts(), searches: 1, rejections: rejections(), additionalReasons: {}, unchecked: {}, status: 'searching' }; this.total.searches++; if (woken) increment(this.woken ||= {}, woken); }
    add(key, amount = 1) { this.total[key] += amount; this.last[key] += amount; }
    reject(stage, reason) { increment(this.rejections[stage], reason); increment(this.last.rejections[stage], reason); }
    forecast(assessment, bossId) {
        this.add('forecasts');
        const ms = Number(assessment.workMs);
        if (Number.isFinite(ms) && ms >= 0) this.add('forecastWorkMs', ms);
        if (!assessment.ready) {
            this.add('forecastFailures');
            this.reject('forecast', assessment.reason);
            for (const reason of new Set(assessment.reasons || [])) if (reason !== assessment.reason) {
                increment(this.additionalReasons, reason); increment(this.last.additionalReasons, reason);
            }
        }
        for (const stage of new Set(assessment.unchecked || [])) {
            increment(this.unchecked, stage); increment(this.last.unchecked, stage);
        }
        this.lastForecast = { bossId, ready: assessment.ready, reason: assessment.reason,
            reasons: assessment.reasons || (assessment.ready ? [] : [assessment.reason]),
            unchecked: assessment.unchecked || [], workMs: assessment.workMs || 0,
            ...(assessment.defense ? { defense: { ...assessment.defense } } : {}),
            ...Object.fromEntries(['grossDps', 'regen', 'seconds', 'healing', 'healingRequired']
                .filter(k => assessment[k] !== undefined).map(k => [k, assessment[k]])) };
    }
    roster(members) {
        this.add('rosterAttempts');
        const key = members.map(s => s.characterId).sort((a, b) => a - b).join(':');
        this.recent.delete(key); this.recent.set(key, true);
        if (this.recent.size > RECENT_LIMIT) this.recent.delete(this.recent.keys().next().value);
        return key;
    }
    finish(status = 'complete') { if (this.last) this.last.status = status; }
    formed() { this.total.formations++; if (this.last?.status === 'searching') this.last.formations++; }
    snapshot() { return { sinceAt: this.sinceAt, total: { ...this.total }, woken: { ...this.woken }, rejections: structuredClone(this.rejections),
        pendingRosters: this.pendingRosters, cpuBudget: { ...this.cpuBudget }, additionalReasons: { ...this.additionalReasons }, unchecked: { ...this.unchecked },
        lastForecast: this.lastForecast ? structuredClone(this.lastForecast) : null,
        lastSearch: this.last ? structuredClone(this.last) : null, recentDistinctRosters: this.recent.size,
        recentDistinctLimit: RECENT_LIMIT, limits: LIMITS }; }
}
module.exports = { RaidSearchCounters, LIMITS };
