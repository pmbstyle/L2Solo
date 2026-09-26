// Q385 Yoke of the Past. Source: MOBIUS_C4 6674a607 Q00385_YokeOfThePast.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000), confirmed
// against the reference's own stats/npcs/CT0_to_C4_ids.txt.
//
// Every Gatekeeper Ziggurat in front of a catacomb or necropolis offers the same
// standing errand: bring back Scrolls of Ancient Magic from anything inside, and
// each one is exchanged for a Blank Scroll. There is no Seven Signs condition of
// any kind in the pinned handler - no seal, no side, no participation check.
// See docs/c4/quests/imported-quests.md.
const GATEKEEPERS = [
    ...Array.from({ length: 16 }, (_, index) => 8095 + index),
    ...Array.from({ length: 13 }, (_, index) => 8114 + index)
];

const ANCIENT_SCROLL = 5902;
const BLANK_SCROLL = 5965;

const MIN_LEVEL = 20;

// Each catacomb dweller has its own chance, authored out of a million in the
// reference. The seven ids its table omits (21212, 21216, 21220 and
// 21232-21235) are unspawned content in C4: reference templates with no spawn
// anywhere in the pinned datapack, and no local template at all.
const CHANCES = new Map([
    [1208, 0.07], [1209, 0.08], [1210, 0.11], [1211, 0.11], [1213, 0.14],
    [1214, 0.19], [1215, 0.19], [1217, 0.24], [1218, 0.3], [1219, 0.3],
    [1221, 0.37], [1222, 0.46], [1223, 0.45], [1224, 0.5], [1225, 0.54],
    [1226, 0.66], [1227, 0.64], [1228, 0.7], [1229, 0.75], [1230, 0.91],
    [1231, 0.86], [1236, 0.12], [1237, 0.14], [1238, 0.19], [1239, 0.19],
    [1240, 0.22], [1241, 0.24], [1242, 0.3], [1243, 0.3], [1244, 0.34],
    [1245, 0.37], [1246, 0.46], [1247, 0.45], [1248, 0.5], [1249, 0.54],
    [1250, 0.66], [1251, 0.64], [1252, 0.7], [1253, 0.75], [1254, 0.91],
    [1255, 0.86]
]);

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const page = (text, action = '') => `<html><body>Gatekeeper Ziggurat:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 385 ${event}">${label}</a>`;

module.exports = {
    id: 385,
    name: 'Yoke of the Past',
    npcs: GATEKEEPERS,
    startNpcs: GATEKEEPERS,
    killNpcs: [...CHANCES.keys()],
    // Every gatekeeper answers for this errand, so the whole set is offered and
    // the player's own gatekeeper is the one that serves them.
    eventNpc: () => GATEKEEPERS,
    canTalk: () => true,

    async onEvent(state, event) {
        const npcId = Number(state.session.activeNpcTalk?.selfId);
        if (!GATEKEEPERS.includes(npcId)) return null;

        if (event === 'start') {
            if (state.isStarted()) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Bring me the Scrolls of Ancient Magic the dead still carry.');
        }
        if (!state.isStarted()) return null;

        if (event === 'exchange') {
            const scrolls = count(state, ANCIENT_SCROLL);
            if (!scrolls) return null;
            // Every scroll is exchanged in the transaction that surrenders it.
            await step(state, {
                takes: [[ANCIENT_SCROLL, scrolls]], gives: [[BLANK_SCROLL, scrolls]],
                variables: { ...state.variables }
            });
            state.playSound('ItemSound.quest_middle');
            return page('The magic is drawn out. These blanks are yours.');
        }

        if (event === 'quit') {
            await step(state, {
                takes: [[ANCIENT_SCROLL, count(state, ANCIENT_SCROLL)]].filter(([, n]) => n > 0),
                status: 'created', variables: {}
            });
            state.playSound('ItemSound.quest_finish');
            return page('Then the past keeps its own.');
        }
        return null;
    },

    async onTalk(state, npc) {
        if (!GATEKEEPERS.includes(Number(npc.fetchSelfId()))) return null;
        if (!state.isStarted()) {
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
                return page(`The dead will not speak to anyone below level ${MIN_LEVEL}.`);
            }
            return page('The catacombs are full of magic nobody living can read.',
                link('start', 'Offer to bring the scrolls out.'));
        }
        const scrolls = count(state, ANCIENT_SCROLL);
        if (!scrolls) {
            return page('Scroll of Ancient Magic: 0.', link('quit', 'End this task.'));
        }
        return page(`Scroll of Ancient Magic: ${scrolls}.`,
            `${link('exchange', 'Hand over the scrolls.')}<br>${link('quit', 'End this task.')}`);
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        const chance = CHANCES.get(Number(npc.fetchSelfId()));
        if (chance === undefined || Math.random() >= chance) return;
        await step(state, { gives: [[ANCIENT_SCROLL, 1]], variables: { ...state.variables } });
        state.playSound('ItemSound.quest_itemget');
    }
};
