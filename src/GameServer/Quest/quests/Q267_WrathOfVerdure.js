// Q267 Wrath of Verdure. Source: MOBIUS_C4 6674a607 Q00267_WrathOfVerdure.
//
// Treant Bremec is reference NPC 31853. Its local template is 12092, which is
// the id block Pixy Murika's proven spawn also comes from; native 196 carries
// the same name but has no world spawn at all. See docs/c4/quests/imported-quests.md.
//
// The hand-in pays one Silvery Leaf per club rather than a flat sum, which is
// why this stays a script instead of a reviewed COLLECT definition: the
// declarative cash-out pays adena, not a token per item.
const BREMEC = 12092;
const GOBLIN_RAIDER = 325;

const GOBLIN_CLUB = 1335;
const SILVERY_LEAF = 1340;

const ELF = 1;
const MIN_LEVEL = 4;
const DROP_CHANCE = 0.5;
const BONUS_AT = 10;
const BONUS_ADENA = 600;

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const adena = (amount) => Math.floor(amount * invoke('GameServer/ProgressionRates').profile().questAdena);
const page = (text, action = '') => `<html><body>Treant Bremec:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 267 ${event}">${label}</a>`;
const eligible = (actor) => Number(actor.fetchRace()) === ELF && Number(actor.fetchLevel()) >= MIN_LEVEL;

module.exports = {
    id: 267,
    name: 'Wrath of Verdure',
    npcs: [BREMEC],
    startNpcs: [BREMEC],
    killNpcs: [GOBLIN_RAIDER],
    eventNpc: () => BREMEC,
    canTalk: () => true,

    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (!eligible(state.session.actor)) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Bring me the clubs of the goblins that scar the forest.');
        }
        if (!state.isStarted()) return null;

        if (event === 'reward') {
            const clubs = count(state, GOBLIN_CLUB);
            if (!clubs) return null;
            // Every club is paid for in the transaction that surrenders it, and
            // the ten-club bonus rides along with it.
            const gives = [[SILVERY_LEAF, clubs]];
            if (clubs >= BONUS_AT) gives.push([57, adena(BONUS_ADENA)]);
            await step(state, { takes: [[GOBLIN_CLUB, clubs]], gives, variables: { ...state.variables } });
            state.playSound('ItemSound.quest_middle');
            return page(clubs >= BONUS_AT
                ? 'That is a real dent in their numbers. Take this as well.'
                : 'The forest thanks you. Keep hunting.');
        }

        if (event === 'quit') {
            await step(state, {
                takes: [[GOBLIN_CLUB, count(state, GOBLIN_CLUB)]].filter(([, n]) => n > 0),
                status: 'created', variables: {}
            });
            state.playSound('ItemSound.quest_finish');
            return page('Go in peace.');
        }
        return null;
    },

    async onTalk(state, npc) {
        if (Number(npc.fetchSelfId()) !== BREMEC) return null;
        if (state.isCompleted()) return page('You have done enough for the forest.');
        if (!state.isStarted()) {
            if (Number(state.session.actor.fetchRace()) !== ELF) {
                return page('Only the children of the forest can hear me.');
            }
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
                return page(`Return when you have reached level ${MIN_LEVEL}.`);
            }
            return page('The goblins burn what they cannot carry.', link('start', 'Offer to help.'));
        }
        const clubs = count(state, GOBLIN_CLUB);
        if (!clubs) {
            return page('Goblin Club: 0.', link('quit', 'End this task.'));
        }
        return page(`Goblin Club: ${clubs}.`,
            `${link('reward', 'Hand over the clubs.')}<br>${link('quit', 'End this task.')}`);
    },

    async onKill(state, npc) {
        if (!state.isStarted() || Number(npc.fetchSelfId()) !== GOBLIN_RAIDER) return;
        if (Math.random() >= DROP_CHANCE) return;
        await step(state, { gives: [[GOBLIN_CLUB, 1]], variables: { ...state.variables } });
        state.playSound('ItemSound.quest_itemget');
    }
};
