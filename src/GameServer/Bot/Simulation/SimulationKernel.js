const Contracts = invoke('GameServer/Bot/Simulation/SimulationContracts');
const Events = invoke('GameServer/Bot/Simulation/SimulationEvents');

function moduleId(module) {
    return typeof module?.id === 'string' ? module.id.trim() : '';
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

const SimulationKernel = {
    initialized: false,
    started: false,
    context: null,
    modules: new Map(),
    handlers: new Map(),
    statusProviders: new Map(),
    metrics: {
        proposalsAccepted: 0,
        proposalsRejected: 0,
        moduleErrors: 0
    },

    init(context = {}) {
        if (this.initialized) return this;
        this.context = Object.freeze({ ...context });
        this.initialized = true;
        utils.infoSuccess('BotSim', 'simulation kernel initialized');
        return this;
    },

    register(module) {
        const id = moduleId(module);
        if (!id) throw new Error('Simulation module requires a non-empty id.');
        if (this.modules.has(id)) throw new Error(`Simulation module already registered: ${id}`);

        const requires = unique(Array.isArray(module.requires) ? module.requires : []);
        this.modules.set(id, { ...module, id, requires, initialized: false, started: false });
        return id;
    },

    registryFor(source) {
        return Object.freeze({
            eventHandler: (type, handler) => {
                if (typeof handler !== 'function' || !type) throw new Error('Simulation event handler requires a type and function.');
                const key = String(type);
                const handlers = this.handlers.get(key) || [];
                handlers.push({ source, handler });
                this.handlers.set(key, handlers);
            },
            statusProvider: (provider) => {
                if (typeof provider !== 'function') throw new Error('Simulation status provider requires a function.');
                this.statusProviders.set(source, provider);
            }
        });
    },

    start() {
        if (this.started) return this;
        if (!this.initialized) this.init();

        for (const module of this.modules.values()) {
            const missing = module.requires.filter((id) => !this.modules.has(id));
            if (missing.length > 0) throw new Error(`Simulation module ${module.id} missing dependencies: ${missing.join(', ')}`);

            try {
                module.init?.(this.context);
                module.register?.(this.registryFor(module.id));
                module.initialized = true;
                module.start?.(this.context);
                module.started = true;
            } catch (err) {
                this.metrics.moduleErrors += 1;
                throw new Error(`Simulation module ${module.id} failed to start: ${err.message}`);
            }
        }

        this.started = true;
        utils.infoSuccess('BotSim', 'simulation kernel started modules=%d', this.modules.size);
        return this;
    },

    propose(proposal, snapshot, now = Date.now()) {
        const result = Contracts.validateProposal(proposal, snapshot, now);
        if (result.accepted) this.metrics.proposalsAccepted += 1;
        else this.metrics.proposalsRejected += 1;
        return result;
    },

    emit(event) {
        return Events.emit(event);
    },

    dispatchEvents(limit = 50, now = Date.now()) {
        return Events.drain(limit, (event) => {
            (this.handlers.get(event.type) || []).forEach(({ source, handler }) => {
                try {
                    handler(event, this.context);
                } catch (err) {
                    this.metrics.moduleErrors += 1;
                    utils.infoWarn('BotSim', 'module=%s event=%s failed: %s', source, event.type, err.message);
                }
            });
        }, now);
    },

    snapshot() {
        const modules = Array.from(this.modules.values()).map((module) => ({
            id: module.id,
            requires: [...module.requires],
            initialized: module.initialized,
            started: module.started
        }));
        const moduleStatus = {};
        this.statusProviders.forEach((provider, id) => {
            try {
                moduleStatus[id] = provider(this.context);
            } catch (err) {
                moduleStatus[id] = { error: err.message };
            }
        });

        return {
            initialized: this.initialized,
            started: this.started,
            modules,
            metrics: { ...this.metrics },
            events: Events.snapshot(),
            moduleStatus
        };
    },

    reset() {
        this.initialized = false;
        this.started = false;
        this.context = null;
        this.modules = new Map();
        this.handlers = new Map();
        this.statusProviders = new Map();
        this.metrics = { proposalsAccepted: 0, proposalsRejected: 0, moduleErrors: 0 };
        Events.reset();
    }
};

module.exports = SimulationKernel;
