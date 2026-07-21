const DONAL = 8314;
const DAISY = 8315;
const ABERCROMBIE = 8555;
const SUPPLY_BOX = 7245;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';
function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }

module.exports = {
    id: 18, name: 'Meeting with the Golden Ram', npcs: [DONAL, DAISY, ABERCROMBIE], startNpcs: [DONAL],
    eventNpc: (event) => ({ start: DONAL, supplies: DAISY, reward: ABERCROMBIE }[event] ?? null),
    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            if (Number(actor.fetchLevel()) >= 66) return null;
            await state.setState('started'); await state.set('cond', 1); state.playSound(SOUND_ACCEPT);
            return page('Donal', 'Meet Daisy for supplies.');
        }
        if (event === 'supplies' && state.isStarted() && state.getInt('cond') === 1) {
            await service().giveItem(state.session, SUPPLY_BOX, 1); await state.set('cond', 2); state.playSound(SOUND_MIDDLE);
            return page('Daisy', 'Deliver the supply box to Abercrombie.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 2) {
            if (!await service().takeItem(state.session, SUPPLY_BOX)) return null;
            await service().rewardAdena(state.session, 15000); service().rewardExpSp(state.session, 50000, 0);
            state.playSound(SOUND_FINISH); await state.exit(false);
            return page('Abercrombie', 'Welcome to the Golden Ram.');
        }
        return null;
    },
    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) return npcId === DONAL ? (Number(actor.fetchLevel()) < 66 ? page('Donal', 'Will you meet the Golden Ram?', '<a action="bypass -h quest 18 start">Accept.</a>') : page('Donal', 'This task is for adventurers below level 66.')) : page('Quest', 'You are not on a quest that involves this NPC.');
        const cond = state.getInt('cond');
        if (npcId === DONAL) return page('Donal', 'Speak with Daisy.');
        if (npcId === DAISY) return cond === 1 ? page('Daisy', 'Take this supply box.', '<a action="bypass -h quest 18 supplies">Receive the box.</a>') : page('Daisy', 'Deliver it to Abercrombie.');
        return cond === 2 ? page('Abercrombie', 'Have you brought the supplies?', '<a action="bypass -h quest 18 reward">Deliver the supplies.</a>') : page('Abercrombie', 'Speak with Daisy first.');
    }
};
