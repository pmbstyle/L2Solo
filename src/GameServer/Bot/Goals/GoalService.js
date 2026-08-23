const GoalState = invoke('GameServer/Bot/Goals/GoalState');
const NeedsEvaluator = invoke('GameServer/Bot/Goals/NeedsEvaluator');
const GoalPlanner = invoke('GameServer/Bot/Goals/GoalPlanner');

function reviewSpot(state, explicitSpot = null, existingGoal = null) {
    if (explicitSpot) return explicitSpot;
    const spotId = state?.stats?.travel?.spotId
        || state?.stats?.marketReturn?.spotId
        || state?.spotId
        || existingGoal?.plan?.spotId
        || null;
    return spotId
        ? invoke('GameServer/Bot/Population/SpotProfiles').findById(spotId)
        : null;
}

function reviewDecision(state, existing, options, timestamp) {
    const candidates = NeedsEvaluator.evaluate(state, {
        spot: reviewSpot(state, options.spot, existing?.current),
        now: timestamp
    });
    const marketCandidate = candidates.find((candidate) => candidate?.type === 'sell_inventory' || candidate?.type === 'buy_craft_material'
        || ['market_search_for_weapon', 'market_search_for_gear'].includes(candidate?.plan?.expectedBenefit));
    const activeMarketGoal = existing?.current?.type === 'sell_inventory' || existing?.current?.type === 'buy_craft_material'
        || ['market_search_for_weapon', 'market_search_for_gear'].includes(existing?.current?.plan?.expectedBenefit);
    if (existing?.current?.nextReviewAt > timestamp && existing.current.status === 'active'
        && !marketCandidate && !activeMarketGoal) return { result: existing, unchanged: true, goal: null };

    const goal = GoalPlanner.plan(candidates, timestamp);
    if (!goal) return { result: null, unchanged: true, goal: null };
    if (existing?.current?.type === goal.type) goal.createdAt = existing.current.createdAt;
    return { result: null, unchanged: false, goal };
}

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
            const decision = reviewDecision(state, existing, options, timestamp);
            if (decision.unchanged) return decision.result;
            return GoalState.set(state.characterId, decision.goal);
        };

        return (cached ? Promise.resolve(cached) : GoalState.load(state.characterId)).then(choose);
    },

    reviewBatch(states = [], options = {}) {
        const candidates = (states || []).filter((state) => state?.characterId && state.phase !== 'hot');
        if (!candidates.length) return Promise.resolve([]);
        const timestamp = Number(options.now) || Date.now();
        return Promise.all(candidates.map((state) => {
            const cached = GoalState.snapshot(state.characterId);
            return cached ? Promise.resolve(cached) : GoalState.load(state.characterId);
        })).then((existingGoals) => {
            const decisions = candidates.map((state, index) => {
                const stateOptions = typeof options.optionsForState === 'function'
                    ? { ...options, ...(options.optionsForState(state) || {}) }
                    : options;
                return {
                    state,
                    decision: reviewDecision(state, existingGoals[index], stateOptions, timestamp)
                };
            });
            const pending = decisions.filter(({ decision }) => !decision.unchanged).map(({ state, decision }) => ({
                characterId: state.characterId,
                goal: decision.goal
            }));
            return GoalState.setBatch(pending).then((saved) => {
                const savedById = new Map(saved.map((snapshot) => [Number(snapshot.characterId), snapshot]));
                return decisions.map(({ state, decision }) => (
                    decision.unchanged ? decision.result : savedById.get(Number(state.characterId)) || null
                ));
            });
        });
    }
};

GoalService.reviewSpot = reviewSpot;

module.exports = GoalService;
