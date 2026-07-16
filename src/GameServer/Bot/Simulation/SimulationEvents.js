const Contracts = invoke('GameServer/Bot/Simulation/SimulationContracts');

const DEFAULT_MAX_QUEUE = 500;

const SimulationEvents = {
    queue: [],
    dropped: 0,
    delivered: 0,
    failed: 0,

    emit(event, options = {}) {
        const normalized = Contracts.normalizeEvent(event, options.now || Date.now());
        if (!normalized) return null;

        const maxQueue = Math.max(1, Number(options.maxQueue) || DEFAULT_MAX_QUEUE);
        if (this.queue.length >= maxQueue) {
            this.queue.shift();
            this.dropped += 1;
        }
        this.queue.push(normalized);
        return normalized;
    },

    drain(limit, deliver, now = Date.now()) {
        const max = Math.max(0, Number(limit) || 0);
        if (typeof deliver !== 'function' || max === 0) return [];

        const delivered = [];
        while (this.queue.length > 0 && delivered.length < max) {
            const event = this.queue.shift();
            if (event.expiresAt && event.expiresAt <= now) continue;
            try {
                deliver(event);
                delivered.push(event);
                this.delivered += 1;
            } catch (err) {
                this.failed += 1;
                utils.infoWarn('BotSim', 'event delivery failed type=%s source=%s: %s', event.type, event.source, err.message);
            }
        }
        return delivered;
    },

    snapshot() {
        return {
            queued: this.queue.length,
            dropped: this.dropped,
            delivered: this.delivered,
            failed: this.failed
        };
    },

    reset() {
        this.queue = [];
        this.dropped = 0;
        this.delivered = 0;
        this.failed = 0;
    }
};

module.exports = SimulationEvents;
