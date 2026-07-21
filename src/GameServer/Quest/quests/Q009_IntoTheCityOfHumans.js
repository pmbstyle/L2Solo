const PETUKAI = 7583;
const TANAPI = 7571;
const TAMIL = 7576;
const MARK_OF_TRAVELER = 7570;
const SOE_GIRAN = 7126;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';

function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }

module.exports = {
    id: 9,
    name: 'Into the City of Humans',
    npcs: [PETUKAI, TANAPI, TAMIL],
    startNpcs: [PETUKAI],
    eventNpc: (event) => {
        if (event === 'start') return PETUKAI;
        if (event === 'council') return TANAPI;
        if (event === 'reward') return TAMIL;
        return null;
    },

    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            if (Number(actor.fetchRace()) !== 3 || Number(actor.fetchLevel()) < 3) return null;
            await state.setState('started');
            await state.set('cond', 1);
            state.playSound(SOUND_ACCEPT);
            return page('Petukai', 'Seek Tanapi’s counsel before travelling to the City of Humans.');
        }
        if (event === 'council' && state.isStarted() && state.getInt('cond') === 1) {
            await state.set('cond', 2);
            state.playSound(SOUND_MIDDLE);
            return page('Tanapi', 'Speak with TAmil about your journey.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 2) {
            await service().giveItem(state.session, MARK_OF_TRAVELER, 1);
            await service().giveItem(state.session, SOE_GIRAN, 1);
            state.playSound(SOUND_FINISH);
            await state.exit(false);
            return page('TAmil', 'May Pa’agrio watch over your travels.');
        }
        return null;
    },

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) {
            if (npcId !== PETUKAI) return page('Quest', 'You are not on a quest that involves this NPC.');
            if (Number(actor.fetchRace()) !== 3 || Number(actor.fetchLevel()) < 3) return page('Petukai', 'This journey is for Orcs of level 3 or higher.');
            return page('Petukai', 'Would you like to begin your journey?', '<a action="bypass -h quest 9 start">Begin.</a>');
        }
        const cond = state.getInt('cond');
        if (npcId === PETUKAI) return page('Petukai', 'Seek Tanapi’s counsel.');
        if (npcId === TANAPI) {
            return cond === 1
                ? page('Tanapi', 'I will advise you.', '<a action="bypass -h quest 9 council">Receive Tanapi’s counsel.</a>')
                : page('Tanapi', 'Continue to TAmil.');
        }
        if (npcId === TAMIL) {
            return cond === 2
                ? page('TAmil', 'You are ready to travel.', '<a action="bypass -h quest 9 reward">Receive the traveler’s mark.</a>')
                : page('TAmil', 'Speak with Tanapi first.');
        }
        return null;
    }
};
