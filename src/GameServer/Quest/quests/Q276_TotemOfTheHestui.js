// Q276 Totem of the Hestui. Source: MOBIUS_C4 6674a607 Q00276_TotemOfTheHestui.
// NPC ids are L2Solo native datapack ids (reference id - 23000); mob ids are the
// reference id - 20000, or - 22000 for the 27xxx quest-monster range.
//
// The Kasha Bear Totem Spirit is a transient quest spawn, exactly as the
// reference's addSpawn is: it belongs to the character who provoked it and is
// not restored across a restart. See docs/c4/quests/imported-quests.md.
const TANAPI = 7571;
const KASHA_BEAR = 479;
const TOTEM_SPIRIT = 5044;

const PARASITE = 1480;
const CRYSTAL = 1481;
const HESTUI_TOTEM = 1500;
const LEATHER_PANTS = 29;

const ORC = 3;
const MIN_LEVEL = 15;

// The spirit grows more likely the longer the parasites are carried. Each tier
// is the reference's own comparison, including where it uses <= rather than <.
const SPAWN_TIERS = [
    { parasites: 79, roll: null },
    { parasites: 69, roll: (r) => r <= 20 },
    { parasites: 59, roll: (r) => r <= 15 },
    { parasites: 49, roll: (r) => r <= 10 },
    { parasites: 39, roll: (r) => r < 2 }
];

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) =>
    state.session.actor.backpack.fetchItemFromSelfId(selfId)?.fetchAmount() || 0;
const page = (text, action = '') => `<html><body>Tanapi:<br>${text}<br><br>${action}</body></html>`;
const eligible = (actor) => Number(actor.fetchRace()) === ORC && Number(actor.fetchLevel()) >= MIN_LEVEL;

// `roll` is the reference's getRandom(100): an integer in 0..99.
function spirit(parasites, roll) {
    return SPAWN_TIERS.some((tier) =>
        parasites >= tier.parasites && (tier.roll === null || tier.roll(roll)));
}

module.exports = {
    id: 276,
    name: 'Totem of the Hestui',
    npcs: [TANAPI],
    startNpcs: [TANAPI],
    killNpcs: [KASHA_BEAR, TOTEM_SPIRIT],
    questSpawns: [TOTEM_SPIRIT],
    eventNpc: (event) => (['start', 'reward'].includes(event) ? TANAPI : null),
    canTalk: (state) => state.isStarted() || eligible(state.session.actor),
    spawnChance: spirit,

    async onEvent(state, event) {
        if (event === 'start' && !state.isStarted()) {
            if (!eligible(state.session.actor)) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Bring me the Kasha Crystal held by the bears of the Hestui totem.');
        }
        if (event === 'reward' && state.isStarted() && state.getInt('cond') === 2) {
            if (!count(state, CRYSTAL)) return null;
            await step(state, {
                takes: [[CRYSTAL, count(state, CRYSTAL)], [PARASITE, count(state, PARASITE)]].filter(([, n]) => n > 0),
                gives: [[HESTUI_TOTEM, 1], [LEATHER_PANTS, 1]],
                status: 'created',
                variables: { ...state.variables, cond: '0' }
            });
            state.playSound('ItemSound.quest_finish');
            return page('The totem spirit is appeased. Take the Totem of Hestui and these leather pants.');
        }
        return null;
    },

    async onTalk(state, npc) {
        if (Number(npc.fetchSelfId()) !== TANAPI) return null;
        if (!state.isStarted()) {
            if (!eligible(state.session.actor)) {
                return page(`Only an Orc of level ${MIN_LEVEL} or above may seek the Hestui totem.`);
            }
            return page('The Kasha bears carry our totem spirit.',
                '<a action="bypass -h quest 276 start">Seek the crystal.</a>');
        }
        if (state.getInt('cond') === 2 && count(state, CRYSTAL)) {
            return page('You carry the Kasha Crystal.',
                '<a action="bypass -h quest 276 reward">Hand over the crystal.</a>');
        }
        return page(`Kasha Parasites: ${count(state, PARASITE)}.`);
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        const selfId = Number(npc.fetchSelfId());

        if (selfId === TOTEM_SPIRIT) {
            if (count(state, CRYSTAL)) return;
            await step(state, {
                gives: [[CRYSTAL, 1]],
                variables: { ...state.variables, cond: '2' }
            });
            state.playSound('ItemSound.quest_middle');
            return;
        }

        // Once the crystal is held the ordinary bears no longer matter.
        if (selfId !== KASHA_BEAR || state.getInt('cond') !== 1 || count(state, CRYSTAL)) return;

        const parasites = count(state, PARASITE);
        const roll = Math.floor(Math.random() * 100);
        if (spirit(parasites, roll)) {
            state.addSpawn(TOTEM_SPIRIT, {
                locX: npc.fetchLocX?.(), locY: npc.fetchLocY?.(),
                locZ: npc.fetchLocZ?.(), head: npc.fetchHead?.() ?? 0
            });
            // Provoking the spirit consumes the parasites that attracted it.
            if (parasites) {
                await step(state, { takes: [[PARASITE, parasites]], variables: { ...state.variables } });
            }
            state.playSound('ItemSound.quest_middle');
            return;
        }
        await step(state, { gives: [[PARASITE, 1]], variables: { ...state.variables } });
        state.playSound('ItemSound.quest_itemget');
    }
};
