const MINA = 7533;
const MARYSE = 7520;
const JACOB = 7650;
const NECKLACE = 7574;
const SOE_GIRAN = 7559;
const MARK_OF_TRAVELER = 7570;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';

function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }

module.exports = {
    id: 10,
    name: 'Into the World',
    npcs: [MINA, MARYSE, JACOB],
    startNpcs: [MINA],
    eventNpc: (event) => ({ start: MINA, necklace: MARYSE, appraise: JACOB, report: MARYSE, reward: MINA }[event] ?? null),

    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            if (Number(actor.fetchRace()) !== 4) return null;
            await state.setState('started'); await state.set('cond', 1); state.playSound(SOUND_ACCEPT);
            return page('Mineral Trader Mina', 'Take the necklace to Maryse.');
        }
        if (event === 'necklace' && state.isStarted() && state.getInt('cond') === 1) {
            await service().giveItem(state.session, NECKLACE, 1);
            await state.set('cond', 2); state.playSound(SOUND_MIDDLE);
            return page('Maryse', 'Ask Jacob to appraise this necklace.');
        }
        if (event === 'appraise' && state.isStarted() && state.getInt('cond') === 2) {
            if (!await service().takeItem(state.session, NECKLACE)) return null;
            await state.set('cond', 3); state.playSound(SOUND_MIDDLE);
            return page('Jacob', 'Return to Maryse with my appraisal.');
        }
        if (event === 'report' && state.isStarted() && state.getInt('cond') === 3) {
            await state.set('cond', 4);
            return page('Maryse', 'Report back to Mina.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 4) {
            await service().giveItem(state.session, SOE_GIRAN, 1);
            await service().giveItem(state.session, MARK_OF_TRAVELER, 1);
            state.playSound(SOUND_FINISH); await state.exit(false);
            return page('Mineral Trader Mina', 'Your journey into the world begins now.');
        }
        return null;
    },

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) {
            if (npcId !== MINA) return page('Quest', 'You are not on a quest that involves this NPC.');
            if (Number(actor.fetchRace()) !== 4) return page('Mineral Trader Mina', 'This errand is for Dwarves.');
            return page('Mineral Trader Mina', 'Would you carry out a small errand?', '<a action="bypass -h quest 10 start">Accept.</a>');
        }
        const cond = state.getInt('cond');
        if (npcId === MINA) return cond === 4 ? page('Mineral Trader Mina', 'You have returned.', '<a action="bypass -h quest 10 reward">Receive the traveler’s mark.</a>') : page('Mineral Trader Mina', 'Speak with Maryse.');
        if (npcId === MARYSE) {
            if (cond === 1) return page('Maryse', 'Here is the necklace. Take it to Jacob.', '<a action="bypass -h quest 10 necklace">Receive the necklace.</a>');
            if (cond === 3) return page('Maryse', 'I have the appraisal.', '<a action="bypass -h quest 10 report">Report Jacob’s appraisal.</a>');
            return page('Maryse', 'Take the necklace to Jacob.');
        }
        if (npcId === JACOB) return cond === 2 ? page('Jacob', 'I can appraise it.', '<a action="bypass -h quest 10 appraise">Receive Jacob’s appraisal.</a>') : page('Jacob', 'Bring me the necklace first.');
        return null;
    }
};
