const TALLOTH = 7141;
const EYE = 1081;
const STONE = 1082;
const BLOOD = 1083;

function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }

async function collect(state, itemId) {
    const Quest = service();
    const current = state.session.actor.backpack.fetchItemFromSelfId(itemId)?.fetchAmount() || 0;
    const amount = Quest.questDropAmount(1, 1, current);
    if (amount) await Quest.giveItem(state.session, itemId, amount);
    const complete = [EYE, STONE, BLOOD].every((id) => state.session.actor.backpack.fetchItemFromSelfId(id)?.fetchAmount() >= 1);
    if (complete) await state.set('cond', 2);
}

module.exports = {
    id: 3,
    name: 'Will the Seal be Broken?',
    npcs: [TALLOTH],
    startNpcs: [TALLOTH],
    killNpcs: [31, 41, 46, 48, 52, 57],
    eventNpc: (event) => event === 'start' ? TALLOTH : null,

    async onEvent(state, event) {
        if (event !== 'start' || state.isStarted() || state.isCompleted()) return null;
        const actor = state.session.actor;
        if (Number(actor.fetchRace()) !== 2 || Number(actor.fetchLevel()) < 16) return null;
        await state.setState('started');
        await state.set('cond', 1);
        return page('Talloth', 'Bring me an Onyx Beast Eye, a Taint Stone, and Succubus Blood.');
    },

    async onTalk(state, npc) {
        const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) {
            if (Number(actor.fetchRace()) !== 2) return page('Talloth', 'This task is for Dark Elves only.');
            return Number(actor.fetchLevel()) < 16
                ? page('Talloth', 'Come back after reaching level 16.')
                : page('Talloth', 'Will the seal be broken?', '<a action="bypass -h quest 3 start">Accept the task.</a>');
        }
        if (state.getInt('cond') === 1) return page('Talloth', 'Keep hunting until you have all three ritual ingredients.');
        const Quest = service();
        const backpack = state.session.actor.backpack;
        const hasAllItems = [EYE, STONE, BLOOD].every((id) => (backpack.fetchItemFromSelfId(id)?.fetchAmount() || 0) >= 1);
        if (!hasAllItems) return page('Talloth', 'You must bring all three ritual ingredients before I can reward you.');
        await Quest.takeItem(state.session, EYE);
        await Quest.takeItem(state.session, STONE);
        await Quest.takeItem(state.session, BLOOD);
        await Quest.giveItem(state.session, 57, 4900);
        Quest.rewardExpSp(state.session, 5000, 0);
        await state.exit(false);
        return page('Talloth', 'The seal has been broken. You receive 4,900 Adena and 5,000 XP.');
    },

    async onKill(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        if (npcId === 31) return collect(state, EYE);
        if ([41, 46].includes(npcId)) return collect(state, STONE);
        return collect(state, BLOOD);
    }
};
