// Q378 Magnificent Feast. Source: MOBIUS_C4 6674a607 Q00378_GrandFeast.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000).
//
// Ranspo's banquet is scored, not randomised. The wine contributes 1, 2 or 4,
// the food recipe 8, 16 or 32, and the musical score is required but adds
// nothing. Those nine sums are the nine reward rows below; no other total can
// occur, and each row is exact.
const RANSPO = 7594;

const WINE_15 = 5956;
const WINE_30 = 5957;
const WINE_60 = 5958;
const MUSICAL_SCORE = 4421;
const SALAD_RECIPE = 1455;
const SAUCE_RECIPE = 1456;
const STEAK_RECIPE = 1457;
const RITRON_DESSERT = 5959;

const MIN_LEVEL = 20;

const WINES = {
    wine15: { item: WINE_15, score: 1, label: '15 Year Old Wine' },
    wine30: { item: WINE_30, score: 2, label: '30 Year Old Wine' },
    wine60: { item: WINE_60, score: 4, label: '60 Year Old Wine' }
};
const RECIPES = {
    salad: { item: SALAD_RECIPE, score: 8, label: "Jonas's Salad Recipe" },
    sauce: { item: SAUCE_RECIPE, score: 16, label: "Jonas's Sauce Recipe" },
    steak: { item: STEAK_RECIPE, score: 32, label: "Jonas's Steak Recipe" }
};
// score -> [item, amount, adena]
const REWARDS = {
    9: [847, 1, 5700],
    10: [846, 2, 0],
    12: [909, 1, 25400],
    17: [846, 2, 1200],
    18: [879, 1, 6900],
    20: [890, 2, 8500],
    33: [879, 1, 8100],
    34: [910, 1, 0],
    36: [848, 1, 2200]
};

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const rate = () => invoke('GameServer/ProgressionRates').profile().questAdena;
const page = (text, action = '') => `<html><body>Ranspo:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 378 ${event}">${label}</a>`;
const menu = (entries) => Object.entries(entries)
    .map(([event, spec]) => link(event, spec.label)).join('<br>');

module.exports = {
    id: 378,
    name: 'Magnificent Feast',
    npcs: [RANSPO],
    startNpcs: [RANSPO],
    eventNpc: () => RANSPO,
    canTalk: () => true,

    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            await step(state, { variables: { ...state.variables, cond: '1', score: '0' } });
            state.playSound('ItemSound.quest_accept');
            return page('Bring me a wine worthy of the banquet.');
        }
        if (!state.isStarted()) return null;
        const cond = state.getInt('cond');

        const wine = WINES[event];
        if (wine) {
            if (cond !== 1 || !count(state, wine.item)) return null;
            // The wine is consumed and its contribution recorded together, so a
            // second bottle can never be scored.
            await step(state, {
                takes: [[wine.item, 1]],
                variables: { ...state.variables, cond: '2', score: String(wine.score) }
            });
            state.playSound('ItemSound.quest_middle');
            return page('Now I need the music. Bring me the Theme of the Feast.');
        }

        if (event === 'score') {
            if (cond !== 2 || !count(state, MUSICAL_SCORE)) return null;
            // The musical score is required but contributes nothing to the total.
            await step(state, {
                takes: [[MUSICAL_SCORE, 1]],
                variables: { ...state.variables, cond: '3' }
            });
            state.playSound('ItemSound.quest_middle');
            return page('Last, the food. Bring me one of Jonas\'s recipes.');
        }

        const recipe = RECIPES[event];
        if (recipe) {
            if (cond !== 3 || !count(state, recipe.item)) return null;
            await step(state, {
                takes: [[recipe.item, 1]],
                variables: {
                    ...state.variables, cond: '4',
                    score: String(state.getInt('score') + recipe.score)
                }
            });
            state.playSound('ItemSound.quest_middle');
            return page("The menu is settled. Bring me Ritron's Dessert Recipe and we can begin.");
        }
        return null;
    },

    async onTalk(state, npc) {
        if (Number(npc.fetchSelfId()) !== RANSPO) return null;
        if (state.isCompleted()) return page('The banquet is long over.');
        if (!state.isStarted()) {
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
                return page(`I need an adventurer of level ${MIN_LEVEL} or above.`);
            }
            return page('I am preparing a banquet and I am short of everything.',
                link('start', 'Offer to help.'));
        }
        const cond = state.getInt('cond');

        if (cond === 1) {
            const carried = Object.fromEntries(Object.entries(WINES).filter(([, w]) => count(state, w.item)));
            if (!Object.keys(carried).length) return page('Bring me a wine worthy of the banquet.');
            return page('Which wine shall we pour?', menu(carried));
        }
        if (cond === 2) {
            if (!count(state, MUSICAL_SCORE)) return page('I still need the Theme of the Feast.');
            return page('You have the score.', link('score', 'Hand over the musical score.'));
        }
        if (cond === 3) {
            const carried = Object.fromEntries(Object.entries(RECIPES).filter(([, r]) => count(state, r.item)));
            if (!Object.keys(carried).length) return page("I still need one of Jonas's recipes.");
            return page('What shall we serve?', menu(carried));
        }

        const reward = REWARDS[state.getInt('score')];
        if (!reward || !count(state, RITRON_DESSERT)) {
            return page("I still need Ritron's Dessert Recipe before the banquet can begin.");
        }
        const [item, amount, money] = reward;
        const gives = [[item, amount]];
        if (money > 0) gives.push([57, Math.floor(money * rate())]);
        await step(state, {
            takes: [[RITRON_DESSERT, 1]], gives,
            status: 'created', variables: {}
        });
        state.playSound('ItemSound.quest_finish');
        return page('The banquet was magnificent. This is your share of the praise.');
    }
};
