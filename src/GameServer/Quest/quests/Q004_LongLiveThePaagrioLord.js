const NAKUSIN = 7578;
const GIFTS = new Map([
    [7585, 1542], // Tataru Zu Hestui: Bear Fur Cloak
    [7566, 1541], // Varkees: Honey Khandar
    [7562, 1543], // Grookin: Bloody Axe
    [7560, 1544], // Uska: Ancestor Skull
    [7559, 1545], // Kunai: Spider Dust
    [7587, 1546]  // Gantaki Zu Urutu: Deep Sea Orb
]);
const CLUB = 4;
const SOUND_ACCEPT = 'ItemSound.quest_accept';
const SOUND_ITEMGET = 'ItemSound.quest_itemget';
const SOUND_MIDDLE = 'ItemSound.quest_middle';
const SOUND_FINISH = 'ItemSound.quest_finish';

function service() { return invoke('GameServer/Quest/QuestService'); }
function page(title, text, action = '') { return `<html><body>${title}:<br>${text}<br><br>${action}</body></html>`; }
function startLink() { return '<a action="bypass -h quest 4 start">I will gather the six gifts.</a>'; }

function giftCount(state) {
    return [...GIFTS.values()].reduce((count, itemId) => (
        count + (state.session.actor.backpack.fetchItemFromSelfId(itemId)?.fetchAmount() || 0)
    ), 0);
}

async function takeAll(state, itemId) {
    const item = state.session.actor.backpack.fetchItemFromSelfId(itemId);
    if (item) await service().takeItem(state.session, itemId, item.fetchAmount());
}

module.exports = {
    id: 4,
    name: "Long Live the Pa'agrio Lord!",
    npcs: [NAKUSIN, ...GIFTS.keys()],
    startNpcs: [NAKUSIN],
    eventNpc: (event) => event === 'start' ? NAKUSIN : null,

    async onEvent(state, event) {
        if (event !== 'start' || state.isStarted() || state.isCompleted()) return null;
        const actor = state.session.actor;
        if (Number(actor.fetchRace()) !== 3 || Number(actor.fetchLevel()) < 2) return null;
        await state.setState('started');
        await state.set('cond', 1);
        state.playSound(SOUND_ACCEPT);
        return page('Nakusin', 'Visit the six elders and collect their gifts for Lord Pa’agrio.');
    },

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        const actor = state.session.actor;
        if (state.isCompleted()) return page('Quest', 'You have already completed this quest.');
        if (!state.isStarted()) {
            if (npcId !== NAKUSIN) return page('Quest', 'You are not on a quest that involves this NPC.');
            if (Number(actor.fetchRace()) !== 3) return page('Nakusin', 'This duty is for Orcs only.');
            return Number(actor.fetchLevel()) < 2
                ? page('Nakusin', 'Come back after reaching level 2.')
                : page('Nakusin', 'Will you bring the six gifts for Lord Pa’agrio?', startLink());
        }

        if (npcId === NAKUSIN) {
            if (state.getInt('cond') === 1) return page('Nakusin', 'Bring me all six gifts.');
            await service().giveItem(state.session, CLUB, 1);
            for (const itemId of GIFTS.values()) await takeAll(state, itemId);
            state.playSound(SOUND_FINISH);
            await state.exit(false);
            return page('Nakusin', 'You have served Lord Pa’agrio well. Please accept this Club.');
        }

        const gift = GIFTS.get(npcId);
        if (!gift) return null;
        if (state.session.actor.backpack.fetchItemFromSelfId(gift)) {
            return page('Quest', 'You have already received this elder’s gift.');
        }

        await service().giveItem(state.session, gift, 1);
        if (giftCount(state) >= GIFTS.size) {
            await state.set('cond', 2);
            state.playSound(SOUND_MIDDLE);
        } else {
            state.playSound(SOUND_ITEMGET);
        }
        return page('Quest', 'You received an elder’s gift. Return to Nakusin after collecting all six.');
    }
};
