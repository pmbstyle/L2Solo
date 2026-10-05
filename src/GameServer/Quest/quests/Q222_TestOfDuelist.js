// Lisvus C4 fdc7e33a, 222_TestOfDuelist. This trial awards no diamonds.
const H = require('../SecondProfessionQuest');
const FIRST = [[85, 2768], [90, 2769], [234, 2770], [202, 2771], [270, 2772],
    [552, 2773], [582, 2774], [564, 2775], [601, 2776], [602, 2777]];
const FINAL = [[214, 2779], [217, 2780], [554, 2781], [588, 2782], [604, 2783]];
const ORDERS = [2763, 2764, 2765, 2766, 2767];
const eligible = state => state.session.actor.fetchLevel() >= 39
    && [1, 47, 19, 32].includes(state.session.actor.fetchClassId());
const requirements = state => state.getInt('step') === 1
    ? [...ORDERS.map(id => [id, 1]), ...FIRST.map(([, id]) => [id, 10])]
    : [[2778, 1], ...FINAL.map(([, id]) => [id, 3])];

const quest = {
    id: 222, name: 'Test of the Duelist', npcs: [7623], startNpcs: [7623],
    killNpcs: [...FIRST, ...FINAL].map(([id]) => id),
    questItems: Array.from({ length: 21 }, (_, n) => 2763 + n),
    eventNpc: event => ['start', 'handin', 'reissue'].includes(event) ? 7623 : null,
    canTalk: state => state.isStarted() || state.isCompleted() || eligible(state),
    async onTalk(state) {
        if (state.isCompleted()) return H.page(state, 'You have earned the Mark of Duelist.');
        if (!state.isStarted()) return H.page(state,
            'Kaien asks you to defeat opponents across Gludio, Dion, Giran, Oren and Aden. Collect ten trophies from each first-round opponent.', H.link(222, 'start', 'Accept the test'));
        const first = state.getInt('step') === 1, rows = first ? FIRST : FINAL, needed = first ? 10 : 3;
        return H.page(state, `${first ? 'First round: ten of each trophy.' : 'Final round: three of each trophy.'}<br>`
            + rows.map(([npc, item]) => `${H.npcName(npc)}: ${H.itemName(item)} ${H.count(state, item)}/${needed}`).join('<br>'),
            H.has(state, requirements(state)) ? H.link(222, 'handin', first ? 'Begin the final round' : 'Claim the Mark of Duelist')
                : first && ORDERS.some(id => !H.count(state, id)) ? H.link(222, 'reissue', 'Replace missing orders') : '');
    },
    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted() || !eligible(state)) return null;
            await H.step(state, 1, { variables: { step: '1' }, gives: ORDERS.map(id => [id, 1]) });
        } else {
            if (!state.isStarted()) return null;
            if (event === 'reissue' && state.getInt('step') === 1) {
                const missing = ORDERS.filter(id => !H.count(state, id));
                if (!missing.length) return null;
                await H.step(state, 1, { gives: missing.map(id => [id, 1]) });
            } else if (event === 'handin' && H.has(state, requirements(state))) {
                if (state.getInt('step') === 1) await H.step(state, 1, {
                    takes: requirements(state), gives: [[2778, 1]], variables: { step: '2' } });
                else if (state.getInt('step') === 2) await H.step(state, 0, { status: 'completed',
                    takes: quest.questItems.map(id => [id, H.count(state, id)]), gives: [[2762, 1]], exp: 47015, sp: 20000 });
                else return null;
            } else return null;
        }
        return quest.onTalk(state);
    },
    async onKill(state, npc) {
        const first = state.getInt('step') === 1;
        if (!first && state.getInt('step') !== 2) return;
        const drop = (first ? FIRST : FINAL).find(([id]) => id === npc.fetchSelfId());
        if (!drop) return;
        const amount = invoke('GameServer/Quest/QuestService').questDropAmount(1, first ? 10 : 3, H.count(state, drop[1]));
        if (amount) await H.step(state, 1, { gives: [[drop[1], amount]] });
    },
    onAbort: H.abort
};
module.exports = quest;
