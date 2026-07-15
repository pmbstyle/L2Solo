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

    review(state, options = {}) {
        if (!state?.characterId || state.phase === 'hot') return Promise.resolve(null);
        const timestamp = Number(options.now) || Date.now();
        const cached = GoalState.snapshot(state.characterId);
        if (cached?.current?.nextReviewAt > timestamp && cached.current.status === 'active') {
            return Promise.resolve(cached);
        }

        const choose = (existing) => {
            if (existing?.current?.nextReviewAt > timestamp && existing.current.status === 'active') return existing;
            const candidates = NeedsEvaluator.evaluate(state, { spot: options.spot, now: timestamp });
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
