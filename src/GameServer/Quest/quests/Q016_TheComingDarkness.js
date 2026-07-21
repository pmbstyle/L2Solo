const HIERARCH = 8517;
const ALTARS = [8512, 8513, 8514, 8515, 8516];
const CRYSTAL = 7167;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';
function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }

module.exports = {
    id: 16, name: 'The Coming Darkness', npcs: [HIERARCH, ...ALTARS], startNpcs: [HIERARCH],
    eventNpc(event) {
        if (event === 'start' || event === 'reward') return HIERARCH;
        const step = Number(String(event).replace('altar', ''));
        return Number.isInteger(step) && step >= 1 && step <= ALTARS.length ? ALTARS[step - 1] : null;
    },
    async onEvent(state, event) {
        const actor = state.session.actor;
        if (event === 'start' && !state.isStarted() && !state.isCompleted()) {
            if (Number(actor.fetchLevel()) >= 62) return null;
            await state.setState('started'); await state.set('cond', 1);
            await service().giveItem(state.session, CRYSTAL, 5); state.playSound(SOUND_ACCEPT);
            return page('Hierarch', 'Purify the five Evil Altars in order.');
        }
        const step = Number(String(event).replace('altar', ''));
        if (Number.isInteger(step) && step >= 1 && step <= ALTARS.length && state.isStarted() && state.getInt('cond') === step) {
            if (!await service().takeItem(state.session, CRYSTAL)) return null;
            await state.set('cond', step + 1); state.playSound(SOUND_MIDDLE);
            return page(`Evil Altar ${step}`, 'The seal has been purified.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 6) {
            service().rewardExpSp(state.session, 221958, 0); state.playSound(SOUND_FINISH); await state.exit(false);
            return page('Hierarch', 'The darkness has receded.');
        }
        return null;
    },
    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId()); const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) return npcId === HIERARCH ? (Number(actor.fetchLevel()) < 62 ? page('Hierarch', 'Will you confront the coming darkness?', '<a action="bypass -h quest 16 start">Accept.</a>') : page('Hierarch', 'This task is for adventurers below level 62.')) : page('Quest', 'You are not on a quest that involves this NPC.');
        const cond = state.getInt('cond');
        if (npcId === HIERARCH) return cond === 6 ? page('Hierarch', 'All five altars are purified.', '<a action="bypass -h quest 16 reward">Report success.</a>') : page('Hierarch', 'Continue to the next Evil Altar.');
        const step = ALTARS.indexOf(npcId) + 1;
        if (cond === step) return page(`Evil Altar ${step}`, 'Use a Crystal of Seal.', `<a action="bypass -h quest 16 altar${step}">Purify the altar.</a>`);
        return page(`Evil Altar ${step}`, cond > step ? 'This altar is already purified.' : 'Purify the previous altar first.');
    }
};
