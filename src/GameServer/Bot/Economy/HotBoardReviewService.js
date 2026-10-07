const { performance } = require('perf_hooks');
const BoardReviewEvents = require('./BoardReviewEvents');

function authorityOf(state) {
    return { ownerId: state.simulation?.ownerId || 'legacy_main',
        revision: Number(state.simulation?.revision || 0), leaseId: state.simulation?.leaseId || null };
}

function sameAuthority(state, expected) {
    const actual = authorityOf(state);
    return actual.ownerId === expected.ownerId && actual.revision === expected.revision
        && actual.leaseId === expected.leaseId;
}

function botSession(session) {
    return session?.botSession === true || String(session?.accountId || '').startsWith('bot_');
}

function liveLocation(actor) {
    const loc = { locX: Number(actor.fetchLocX?.()), locY: Number(actor.fetchLocY?.()),
        locZ: Number(actor.fetchLocZ?.()) };
    return Object.values(loc).every(Number.isFinite) ? loc : null;
}

function usableOwner(record) {
    const session = record?.session;
    const actor = record?.actor;
    return record && !record.retired && session.actor === actor && botSession(session)
        && actor.fetchIsOnline?.() === true && liveLocation(actor)
        && !session.populationStaging && !session.hotCompetitionCommit
        && !session.trade && !session.activeTrade && !session.pendingActorTeleport;
}

class HotBoardReviewService {
    start({ admit, complete } = {}) {
        if (typeof admit !== 'function' || typeof complete !== 'function') {
            throw new TypeError('hot board review requires admission and completion providers');
        }
        if (this.running) return false;
        // Resolve the main-thread modules after board/lifecycle startup. A
        // module import neither starts work nor creates an import cycle.
        this.afk = invoke('GameServer/AfkTrade/AfkTradeService');
        this.world = invoke('GameServer/World/World');
        this.life = invoke('GameServer/Bot/Population/BotLifeState');
        this.metrics = invoke('GameServer/Bot/Population/PopulationMetrics');
        this.listings = invoke('GameServer/Bot/Economy/MarketListingPolicy');
        this.pricing = invoke('GameServer/Bot/Economy/MarketPricing');
        this.market = invoke('GameServer/Bot/Economy/BotAfkMarketService');
        this.dispatcher = invoke('GameServer/Bot/AI/HotAiDispatcher');
        this.board = this.afk.boardIndex();
        this.events = new BoardReviewEvents({ board: this.board });
        this.admit = admit;
        this.complete = complete;
        this.generation = (this.generation || 0) + 1;
        this.dispatchKey = Symbol('hot-board-review');
        this.running = true;
        this.scheduled = false;
        // A disposed generation may still be awaiting native flush. Its
        // token fences writes and keeps a restarted service from overlapping.
        this.inFlight = this.inFlight || null;
        this.unsubscribers = [];
        try {
            this.unsubscribers.push(this.afk.subscribeBoardChanges(change => {
                for (const id of change.ownerIds || []) this.ownerChanged(id);
            }));
            this.unsubscribers.push(this.world.subscribeUserChanges(id => this.ownerChanged(id)));
            this.unsubscribers.push(this.life.subscribeMarketReviewChanges(id => this.ownerChanged(id)));
            this.unsubscribers.push(this.life.subscribeChanges(state => this.ownerChanged(Number(state.characterId))));
            return true;
        } catch (error) {
            this.stop();
            throw error;
        }
    }

    // ARCH-NOTE: no universal break-enter hook exists. Rest/shopping ticks
    // use this numeric session guard; BotAI clears it on any other state.
    // It keeps no line observations or history on the main thread.
    naturalBreak(session, kind) {
        if (!kind) { delete session.boardBreakKind; return false; }
        if (session.boardBreakKind === kind) return false;
        session.boardBreakKind = kind;
        if (!this.running) return false;
        this.ownerChanged(Number(session.actor?.fetchId?.()));
        return true;
    }

    ownerChanged(id) {
        if (!this.running) return;
        this.events.ownerChanged(Number(id));
        this.pump();
    }

    pump() {
        if (!this.running || !this.afk.isBoardReady() || this.scheduled || this.inFlight
            || !this.events.ready.size) return false;
        const generation = this.generation;
        this.scheduled = this.dispatcher.enqueue(this.dispatchKey, () => {
            if (!this.running || this.generation !== generation) return;
            this.scheduled = false;
            this.drain(generation).catch(error => utils.infoWarn('HotMarket', 'review failed: %s', error.message));
        });
        return this.scheduled;
    }

    async drain(generation) {
        if (!this.running || this.generation !== generation || this.inFlight
            || !this.afk.isBoardReady() || !this.events.ready.size) return;
        const lease = this.admit();
        // No immediate retry on pressure denial. The existing registry tick
        // or a fresh producer input calls pump after pressure can recover.
        if (!lease) return;
        const started = performance.now();
        const complete = this.complete;
        const [id] = this.events.take(1);
        const token = { generation, id };
        this.inFlight = token;
        try {
            const record = this.world.registeredActorById(id);
            const hot = this.life.hotRow(id);
            if (!usableOwner(record) || !hot) { this.events.defer(id); return; }
            const live = this.listings.actorState(record.session);
            const state = { ...hot, characterId: id, level: live.level, adena: live.adena,
                inventory: live.inventory, phase: 'hot',
                activity: record.session.plan || hot.activity, loc: liveLocation(record.actor),
                currentRegion: record.session.currentRegion || hot.currentRegion,
                spotId: record.session.currentSpot?.id ?? hot.spotId,
                marketTrades: hot.marketTrades || {}, stats: { ...hot.stats, classId: live.stats.classId } };
            const ctx = this.listings.traderContext(state);
            const review = this.pricing.lookOwn(state, this.board.ownerLines(id), ctx);
            if (!review) { this.events.deferAfterCommand(id); return; }
            const hotAuthority = authorityOf(hot);
            const canCommitReview = () => {
                const current = this.world.registeredActorById(id);
                const life = this.life.hotRow(id);
                return this.running && this.generation === generation && this.afk.isBoardReady()
                    && current?.token === record.token && current.session === record.session
                    && current.actor === record.actor && !!usableOwner(current) && !!life
                    && sameAuthority(life, hotAuthority);
            };
            const result = await this.market.applyReview(id, review, { hotAuthority, canCommitReview });
            if (!this.running || this.generation !== generation) return;
            if (result.changed || result.updated) this.events.rearm(id);
            else this.events.deferAfterCommand(id);
        } catch (error) {
            if (this.running && this.generation === generation) this.events.deferAfterCommand(id);
            if (!['stale_market_review', 'hot_handoff_fenced'].includes(error.message)) {
                utils.infoWarn('HotMarket', 'owner %d review waits: %s', id, error.message);
            }
        } finally {
            complete(lease, { durationMs: performance.now() - started });
            if (this.inFlight === token) {
                this.inFlight = null;
                if (this.running) this.pump();
            }
        }
    }

    stop() {
        if (!this.running) return false;
        this.running = false;
        this.generation++;
        for (const unsubscribe of this.unsubscribers) unsubscribe();
        this.dispatcher.cancel(this.dispatchKey);
        this.events.clear();
        this.scheduled = false;
        return true;
    }

    dispose() { return this.stop(); }
}

module.exports = new HotBoardReviewService();
