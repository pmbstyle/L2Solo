// Main's executor of the spot aggregate's outcomes that start a fight between far bots: a
// spot's PvP dispute (SpotContest) and a grievance meeting (EnemyMet's revenge, the war
// director's clan_war), each carried out by ColdPartyConflict. Called with the worker's
// competition frame (ColdSimulationCoordinator).
const DiagnosticConfig = require('./PopulationConfig');
// A forecast's freshness: the spot contest's (SpotContest).
const { EVENT_TTL_MS: TTL_MS } = require('./SpotContest');
// The pause a contested fight's sides wait before it starts (ColdPartyConflict's waitMs).
const WAIT_MS = 15000;
const MAX_APPLIED = 4, MAX_ATTEMPTS = 8, BUDGET_MS = 75;
const count = (map, key) => { if (!DiagnosticConfig.developerDiagnostics) return; map[key] = (map[key] || 0) + 1; };
// A meeting of grievance peers (enemy_met, the war director): no spot pressure is its cause.
const MEETINGS = new Set(['revenge', 'clan_war']);
const priority = e => e.action === 'revenge' || e.pvpIntent ? 3 : e.action === 'contest' ? 1 : 0;

// Consumes forecasts, not combat events. The two participant versions fence
// duplicate deliveries, hot handoffs, target changes and concurrent worker work.
class ColdCompetitionActions {
    constructor({ life, owner, memory, parties, personaFor = () => ({ traits: {} }), onState = () => {}, canRun = () => true, participantAllowed = () => true,
        conflictsEnabled = () => false, pvpEnabled = () => false, incrementalPvp = false, onEncounter = () => {}, contestContextAllowed = () => false, now = Date.now, budgetNow = () => performance.now(),
        releaseForecasts = () => {} }) {
        Object.assign(this, { life, owner, memory, parties, personaFor, onState, canRun, participantAllowed, conflictsEnabled, pvpEnabled, contestContextAllowed, now });
        Object.assign(this, { incrementalPvp, onEncounter, budgetNow, releaseForecasts });
        this.stopping = false;
        this.running = null;
        this.lastScanAt = 0;
        this.spotActivity = new Map();
        this.spotActivityEvicted = 0;
        this.report = { mode: 'cooperation', applied: 0, rejected: 0, contests: 0, revenges: 0, clanWars: 0, deescalated: 0, pvpFights: 0, pvpDeaths: 0, pkKills: 0, budgetSkipped: 0, recent: [] };
        Object.assign(this.report, { attempted: 0, decisionRefreshes: 0, decisionRecomputes: 0, rejectedReasons: {}, rejectionExamples: [], skippedActions: {}, pvpRejected: {}, pvpSuppressed: {}, pvpCompleted: 0, pvpOutcomes: {}, pvpExtensions: 0, pvpExtendedMs: 0 });
    }
    submit(forecast, options = {}) {
        if (this.stopping || this.running || !forecast || (!options.framed && forecast.at <= this.lastScanAt) || !this.canRun()) return false;
        const releaseForecasts = options.releaseForecasts || this.releaseForecasts;
        this.lastScanAt = options.framed ? Math.max(this.lastScanAt, forecast.at) : forecast.at;
        const candidates = (forecast.events || forecast.recent || []).filter(e => e.at === forecast.at
            && ((e.action === 'contest' && this.conflictsEnabled())
                || (e.action === 'revenge' && this.conflictsEnabled() && this.pvpEnabled())
                || (e.action === 'clan_war' && this.pvpEnabled())))
            .sort((a, b) => priority(b) - priority(a));
        this.running = (async () => {
            const started = this.budgetNow();
            const slots = { attempted: 0, applied: 0, maxApplied: MAX_APPLIED, maxAttempts: MAX_ATTEMPTS };
            const skipped = [];
            let open = true;
            for (const event of candidates) {
                if (slots.applied >= slots.maxApplied || slots.attempted >= slots.maxAttempts) { skipped.push(event); continue; }
                open = open && !this.stopping && this.canRun() && this.budgetNow() - started < BUDGET_MS;
                if (!open) { skipped.push(event); continue; }
                slots.attempted++; DiagnosticConfig.developerDiagnostics && (this.report.attempted++);
                let result;
                try { result = await this.apply(event); }
                catch (error) { result = { ok: false, reason: 'action_error', error: error.message }; }
                if (DiagnosticConfig.developerDiagnostics) this.report[result.ok ? 'applied' : 'rejected']++;
                if (result.ok) slots.applied++;
                else count(this.report.rejectedReasons, result.detail || result.reason || 'unknown');
                if (DiagnosticConfig.developerDiagnostics && !result.ok && result.detail) {
                    this.report.rejectionExamples = [...this.report.rejectionExamples.filter(e => e.detail !== result.detail), {
                        at: this.now(), key: event.key, action: event.action, pvpIntent: !!event.pvpIntent,
                        spotId: event.spotId, reason: result.reason, detail: result.detail, ...result.rejectionContext
                    }].slice(-16);
                }
                if (event.pvpIntent || event.action === 'revenge') {
                    if (!result.ok) count(this.report.pvpRejected, result.detail || result.reason || 'unknown');
                    else if (!result.pvp) count(this.report.pvpSuppressed, result.deescalated ? 'deescalated' : result.pvpReason || 'not_started');
                }
                if (DiagnosticConfig.developerDiagnostics && result.ok) this.report[result.deescalated ? 'deescalated' : event.action === 'revenge' ? 'revenges' : event.action === 'contest' ? 'contests' : 'clanWars']++;
                if (DiagnosticConfig.developerDiagnostics && result.ok && result.pvp) {
                    DiagnosticConfig.developerDiagnostics && (this.report.pvpFights++);
                    const kills = result.combat.fighters.flatMap(f => f.kills);
                    DiagnosticConfig.developerDiagnostics && (this.report.pvpDeaths += kills.length);
                    DiagnosticConfig.developerDiagnostics && (this.report.pkKills += kills.filter(k => k.outcome === 'pk').length);
                    if (!result.encounter) { DiagnosticConfig.developerDiagnostics && (this.report.pvpCompleted++); count(this.report.pvpOutcomes, result.outcome || 'finished'); }
                }
                if (DiagnosticConfig.developerDiagnostics && result.ok && event.spotId) {
                    const activity = this.spotActivity.get(event.spotId) || { spotId: event.spotId,
                        since: this.now(), applied: 0, contests: 0, pvpFights: 0, lastPvpAt: null };
                    activity.applied++;
                    activity.contests += Number(event.action === 'contest' && !result.deescalated);
                    activity.pvpFights += Number(!!result.pvp);
                    activity.lastAt = this.now();
                    if (result.pvp) activity.lastPvpAt = activity.lastAt;
                    this.spotActivity.delete(event.spotId);
                    this.spotActivity.set(event.spotId, activity);
                    // Session telemetry, not another durable relationship store.
                    if (this.spotActivity.size > 128) {
                        this.spotActivity.delete(this.spotActivity.keys().next().value);
                        this.spotActivityEvicted++;
                    }
                }
                if (DiagnosticConfig.developerDiagnostics) this.report.recent = [...this.report.recent, { key: event.key, at: this.now(), actorId: event.actor.id,
                    peerId: event.peer.id, spotId: event.spotId, action: event.action, ...result }].slice(-12);
            }
            DiagnosticConfig.developerDiagnostics && (this.report.budgetSkipped += skipped.length);
            for (const event of skipped) count(this.report.skippedActions, event.pvpIntent ? 'pvp' : event.action);
            // A skipped forecast was never carried out: its pair re-decides on
            // the next scan instead of waiting out the cooldown. No backlog.
            if (skipped.length) releaseForecasts(skipped);
        })().finally(() => { this.running = null; });
        return true;
    }
    async apply(event) {
        const now = this.now();
        if (!event.key || event.at > now || now - event.at > TTL_MS || event.actor.id === event.peer.id
            || (!MEETINGS.has(event.action) && !(event.pressure > 1))) return { ok: false, reason: 'invalid_or_expired' };
        if (event.action === 'contest' || MEETINGS.has(event.action)) {
            const current = require('./ColdConflictDecision').refresh(event, this, now);
            // A participant written since the worker's scan: main decided again.
            if (current.recomputed) DiagnosticConfig.developerDiagnostics && (this.report.decisionRecomputes++);
            if (!current.event) return { ok: false, reason: current.reason, decision: current.decision };
            event = current.event;
            if (current.refreshed) DiagnosticConfig.developerDiagnostics && (this.report.decisionRefreshes++);
        }
        const participants = [event.actor, event.peer];
        if (!participants.every(p => this.participantAllowed(p.id))) return { ok: false, reason: 'hot_handoff_fenced' };
        if (event.action === 'clan_war') {
            if (!this.pvpEnabled()) return { ok: false, reason: 'forecast_only' };
            return require('./ColdPartyConflict').apply({ ...this, event, waitMs: 1000 });
        }
        if (event.action === 'revenge') {
            if (!this.conflictsEnabled() || !this.pvpEnabled()) return { ok: false, reason: 'forecast_only' };
            return require('./ColdPartyConflict').apply({ ...this, event, waitMs: WAIT_MS });
        }
        // A spot's dispute is carried out as a fight (PvP intent, PvP on) or, with a party on
        // a side, by the party conflict; a solo pair with no fight to carry out is no action.
        if (event.action === 'contest' && (participants.some(p => p.partyId) || event.pvpIntent === true && this.pvpEnabled())) {
            if (!this.conflictsEnabled()) return { ok: false, reason: 'forecast_only' };
            return require('./ColdPartyConflict').apply({ ...this, event, waitMs: WAIT_MS });
        }
        return { ok: false, reason: 'forecast_only' };
    }
    async stop() { this.stopping = true; if (this.running) await this.running; }
    recordPvpStep(result) {
        if (!DiagnosticConfig.developerDiagnostics) return;
        if (result.ok && result.extensionMs > 0) {
            DiagnosticConfig.developerDiagnostics && (this.report.pvpExtensions++);
            DiagnosticConfig.developerDiagnostics && (this.report.pvpExtendedMs += result.extensionMs);
        }
        const kills = result.combat?.fighters.flatMap(f => f.kills) || [];
        DiagnosticConfig.developerDiagnostics && (this.report.pvpDeaths += kills.length);
        DiagnosticConfig.developerDiagnostics && (this.report.pkKills += kills.filter(k => k.outcome === 'pk').length);
        if (!result.encounter) { DiagnosticConfig.developerDiagnostics && (this.report.pvpCompleted++); count(this.report.pvpOutcomes, result.outcome || 'finished'); }
        DiagnosticConfig.developerDiagnostics && (this.report.lastPvpStep = { at: this.now(), ...result });
    }
    snapshot() { if (!DiagnosticConfig.developerDiagnostics) return { enabled: false }; return { ...this.report, spotActivity: [...this.spotActivity.values()].map(row => ({ ...row })),
        spotActivityEvicted: this.spotActivityEvicted,
        mode: this.conflictsEnabled() ? this.pvpEnabled() ? 'resource_pvp' : 'resource_conflicts' : 'cooperation' }; }
}
module.exports = { ColdCompetitionActions, TTL_MS, WAIT_MS };
