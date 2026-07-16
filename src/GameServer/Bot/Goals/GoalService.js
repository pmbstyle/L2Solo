const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');

const GoalService = {
    initialized: false,

    init() {
        if (this.initialized) return Promise.resolve(true);
        return GoalState.init().then((ready) => {
            this.initialized = ready;
            if (ready) utils.infoSuccess('BotGoals', 'goal service initialized');
            return ready;
        });
    },

    snapshot(characterId) {
        return GoalState.snapshot(characterId);
    },

    current(characterId) {
        const cached = GoalState.snapshot(characterId);
        return cached ? Promise.resolve(cached) : GoalState.load(characterId);
    },

    complete(characterId) {
        return GoalState.clear(characterId, 'completed');
    },

    review(state, options = {}) {
        if (!state?.characterId || state.phase === 'hot') return Promise.resolve(null);
        const timestamp = Number(options.now) || Date.now();
        const cached = GoalState.snapshot(state.characterId);

        const choose = (existing) => {
            const candidates = NeedsEvaluator.evaluate(state, { spot: options.spot, now: timestamp });
            const marketCandidate = candidates.find((candidate) => candidate?.type === 'sell_inventory'
                || ['market_search_for_weapon', 'market_search_for_gear'].includes(candidate?.plan?.expectedBenefit));
            const activeMarketGoal = existing?.current?.type === 'sell_inventory'
                || ['market_search_for_weapon', 'market_search_for_gear'].includes(existing?.current?.plan?.expectedBenefit);
            if (existing?.current?.nextReviewAt > timestamp && existing.current.status === 'active'
                && !marketCandidate && !activeMarketGoal) return existing;

            const goal = GoalPlanner.plan(candidates, timestamp);
            if (!goal) return null;
            if (existing?.current?.type === goal.type) {
                goal.createdAt = existing.current.createdAt;
            }
            return GoalState.set(state.characterId, goal);
        };

        return (cached ? Promise.resolve(cached) : GoalState.load(state.characterId)).then(choose);
    }
};

module.exports = GoalService;
