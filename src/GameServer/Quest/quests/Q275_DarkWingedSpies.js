// Q275 Dark Winged Spies. Source: MOBIUS_C4 6674a607 Q00275_DarkWingedSpies.
// NPC ids are L2Solo native datapack ids (reference id - 23000); mob ids are the
// reference id - 20000, or - 22000 for the 27xxx quest-monster range.
//
// Varangka's Tracker is a transient quest spawn, exactly as the reference's
// addSpawn is: it belongs to the character who provoked it and is not restored
// across a restart. See docs/c4/quests/imported-quests.md.
const TANTUS = 7567;
const DARKWING_BAT = 316;
const VARANGKA_TRACKER = 5043;

const FANG = 1478;
const PARASITE = 1479;

const ORC = 3;
const MIN_LEVEL = 11;
const REQUIRED_FANGS = 70;
const TRACKER_FANGS = 5;
const REWARD_ADENA = 4200;

// The tracker only appears in the middle of the hunt.
const SPAWN_CHANCE = 0.1;
const SPAWN_MIN_FANGS = 10;
const SPAWN_MAX_FANGS = 66;

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) =>
    state.session.actor.backpack.fetchItemFromSelfId(selfId)?.fetchAmount() || 0;
const page = (text, action = '') => `<html><body>Tantus:<br>${text}<br><br>${action}</body></html>`;
const eligible = (actor) => Number(actor.fetchRace()) === ORC && Number(actor.fetchLevel()) >= MIN_LEVEL;

module.exports = {
    id: 275,
    name: 'Dark Winged Spies',
    npcs: [TANTUS],
    startNpcs: [TANTUS],
    killNpcs: [DARKWING_BAT, VARANGKA_TRACKER],
    questSpawns: [VARANGKA_TRACKER],
    eventNpc: (event) => (['start', 'reward'].includes(event) ? TANTUS : null),
    canTalk: (state) => state.isStarted() || eligible(state.session.actor),

    async onEvent(state, event) {
        if (event === 'start' && !state.isStarted()) {
            if (!eligible(state.session.actor)) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Bring me seventy Darkwing Bat Fangs from the caves.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 2) {
            if (count(state, FANG) < REQUIRED_FANGS) return null;
            // The hand-in pays and clears every carried token in one transaction,
            // and leaves the bounty ready to be taken again.
            await step(state, {
                takes: [[FANG, count(state, FANG)], [PARASITE, count(state, PARASITE)]].filter(([, n]) => n > 0),
                gives: [[57, Math.floor(REWARD_ADENA * invoke('GameServer/ProgressionRates').profile().questAdena)]],
                status: 'created',
                variables: { ...state.variables, cond: '0' }
            });
            state.playSound('ItemSound.quest_finish');
            return page('These fangs prove the bats were spying for Varangka. Take your payment.');
        }
        return null;
    },

    async onTalk(state, npc) {
        if (Number(npc.fetchSelfId()) !== TANTUS) return null;
        if (!state.isStarted()) {
            if (!eligible(state.session.actor)) {
                return page(`Only an Orc of level ${MIN_LEVEL} or above can hunt Varangka's spies.`);
            }
            return page('The Darkwing Bats spy for Varangka.',
                '<a action="bypass -h quest 275 start">Hunt them.</a>');
        }
        if (state.getInt('cond') === 2 && count(state, FANG) >= REQUIRED_FANGS) {
            return page('You have enough fangs.',
                '<a action="bypass -h quest 275 reward">Hand over the fangs.</a>');
        }
        return page(`Darkwing Bat Fangs: ${count(state, FANG)}/${REQUIRED_FANGS}.`);
    },

    async onKill(state, npc) {
        if (!state.isStarted() || state.getInt('cond') !== 1) return;
        const selfId = Number(npc.fetchSelfId());

        if (selfId === DARKWING_BAT) {
            const fangs = count(state, FANG) + 1;
            const complete = fangs >= REQUIRED_FANGS;
            await step(state, {
                gives: [[FANG, 1]],
                variables: { ...state.variables, cond: complete ? '2' : '1' }
            });
            state.playSound(complete ? 'ItemSound.quest_middle' : 'ItemSound.quest_itemget');
            // The tracker check is independent of the fang award: the reference
            // rolls it on the same kill, using the count after the fang landed.
            if (Math.random() < SPAWN_CHANCE && fangs > SPAWN_MIN_FANGS && fangs < SPAWN_MAX_FANGS) {
                state.addSpawn(VARANGKA_TRACKER, {
                    locX: npc.fetchLocX?.(), locY: npc.fetchLocY?.(),
                    locZ: npc.fetchLocZ?.(), head: npc.fetchHead?.() ?? 0
                });
                await step(state, { gives: [[PARASITE, 1]], variables: { ...state.variables } });
            }
            return;
        }

        if (selfId === VARANGKA_TRACKER) {
            const parasites = count(state, PARASITE);
            if (!parasites) return;
            const fangs = count(state, FANG);
            // The reference pays the five fangs outright; it does not clamp the
            // total back down to seventy.
            const bonus = fangs < REQUIRED_FANGS ? TRACKER_FANGS : 0;
            const complete = fangs + bonus >= REQUIRED_FANGS;
            await step(state, {
                takes: [[PARASITE, parasites]],
                gives: bonus ? [[FANG, bonus]] : [],
                variables: { ...state.variables, cond: complete ? '2' : '1' }
            });
            state.playSound(complete ? 'ItemSound.quest_middle' : 'ItemSound.quest_itemget');
        }
    }
};
