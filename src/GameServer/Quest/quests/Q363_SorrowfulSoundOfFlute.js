// Q363 Sorrowful Sound of Flute. Source: MOBIUS_C4 6674a607
// Q00363_SorrowfulSoundOfFlute.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000).
//
// Nanarin wants to know what the crowd really wants to see. Any one of five
// townspeople will give an opinion, Nanarin then hands over one of three props,
// and Barbado reports how the performance went. Only the flute is the right
// answer, and the quest records that outcome before Nanarin is told: the
// reference's "success" variable is the whole point of the errand.
const NANARIN = 7956;
const BARBADO = 7959;
const ADVISERS = [7595, 7458, 7057, 7594, 7058];

const CLOTHES = 4318;
const FLUTE = 4319;
const BLACK_BEER = 4320;
const PROPS = [CLOTHES, FLUTE, BLACK_BEER];
const THEME_OF_SOLITUDE = 4420;

const MIN_LEVEL = 15;

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const page = (who, text, action = '') => `<html><body>${who}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 363 ${event}">${label}</a>`;

const PROP_EVENTS = { clothes: CLOTHES, flute: FLUTE, beer: BLACK_BEER };

module.exports = {
    id: 363,
    name: 'Sorrowful Sound of Flute',
    npcs: [NANARIN, BARBADO, ...ADVISERS],
    startNpcs: [NANARIN],
    eventNpc: (event) => (event === 'start' || event in PROP_EVENTS ? NANARIN : null),
    canTalk: () => true,

    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Nanarin', 'Ask the townspeople what they would like to see.');
        }
        if (!state.isStarted() || state.getInt('cond') !== 2) return null;
        const prop = PROP_EVENTS[event];
        if (!prop) return null;
        // Choosing a prop is the decision the quest is about; it commits with the
        // cond so a second choice cannot be taken.
        await step(state, { gives: [[prop, 1]], variables: { ...state.variables, cond: '3' } });
        state.playSound('ItemSound.quest_middle');
        return page('Nanarin', 'Take this to Barbado and see how the audience receives it.');
    },

    async onTalk(state, npc) {
        const id = Number(npc.fetchSelfId());
        if (!this.npcs.includes(id)) return null;
        if (state.isCompleted()) return page('Nanarin', 'You have already helped me.');
        if (!state.isStarted()) {
            if (id !== NANARIN) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
                return page('Nanarin', `Come back when you have reached level ${MIN_LEVEL}.`);
            }
            return page('Nanarin', 'My performances draw no crowd any more.',
                link('start', 'Offer to ask around.'));
        }
        const cond = state.getInt('cond');

        if (ADVISERS.includes(id)) {
            // Every adviser answers, and the first answer is enough.
            if (cond === 1) {
                await step(state, { variables: { ...state.variables, cond: '2' } });
                state.playSound('ItemSound.quest_middle');
                return page('Townsfolk', 'They say the sound of a flute would suit Nanarin best.');
            }
            return page('Townsfolk', 'I have already given you my opinion.');
        }

        if (id === NANARIN) {
            if (cond === 1) return page('Nanarin', 'Ask the townspeople what they would like to see.');
            if (cond === 2) {
                return page('Nanarin', 'What should I take to the stage?',
                    `${link('clothes', 'The event clothes.')}<br>${link('flute', 'The flute.')}<br>${link('beer', 'The black beer.')}`);
            }
            if (cond === 3) return page('Nanarin', 'Barbado is waiting to hear how it went.');
            // cond 4: Barbado has already reported, and the answer is recorded.
            const succeeded = state.getInt('success') === 1;
            await step(state, {
                gives: succeeded ? [[THEME_OF_SOLITUDE, 1]] : [],
                status: 'created', variables: {}
            });
            state.playSound(succeeded ? 'ItemSound.quest_finish' : 'ItemSound.quest_giveup');
            return page('Nanarin', succeeded
                ? 'The flute was exactly right. Take this score as my thanks.'
                : 'That was not what the crowd wanted. I will try again another day.');
        }

        // BARBADO
        if (cond === 4) return page('Barbado', 'Go and tell Nanarin yourself.');
        if (cond !== 3) return page('Barbado', 'Nanarin has nothing on stage yet.');
        // The verdict and the props are settled in one transaction, so the props
        // can never be carried into a second report.
        const succeeded = count(state, FLUTE) > 0;
        await step(state, {
            takes: PROPS.map((selfId) => [selfId, count(state, selfId)]).filter(([, n]) => n > 0),
            variables: { ...state.variables, cond: '4', success: succeeded ? '1' : '0' }
        });
        state.playSound('ItemSound.quest_middle');
        return page('Barbado', succeeded
            ? 'The flute silenced the whole tavern. Nanarin should hear this.'
            : 'The crowd barely looked up. Nanarin should hear this.');
    }
};
