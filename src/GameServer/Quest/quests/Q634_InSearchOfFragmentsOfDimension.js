// Q634 In Search of Fragments of the Dimension. Source: MOBIUS_C4 6674a607
// Q00634_InSearchOfFragmentsOfDimension.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000), confirmed
// against the reference's own stats/npcs/CT0_to_C4_ids.txt.
//
// Every Dimension Keeper standing outside a catacomb or necropolis offers the
// same standing errand. The pinned handler has no Seven Signs condition of any
// kind: anything inside can drop a fragment, one kill in twelve, and the size of
// the find scales with what died.
const KEEPERS = Array.from({ length: 14 }, (_, index) => 8494 + index);

const DIMENSION_FRAGMENT = 7079;

const MIN_LEVEL = 20;
const DROP_CHANCE = 0.08;

// The reference registers the whole 21208-21255 range with a bare loop, but
// seven of those ids are unspawned content in Chronicle 4: they have reference
// templates and no spawn anywhere in the pinned datapack, and no local template
// at all. Q385's own chance table skips exactly the same seven. The real
// targets are the forty-one a player can actually meet.
const UNSPAWNED_IN_C4 = new Set([1212, 1216, 1220, 1232, 1233, 1234, 1235]);
const TARGETS = Array.from({ length: 48 }, (_, index) => 1208 + index)
    .filter((selfId) => !UNSPAWNED_IN_C4.has(selfId));

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const page = (text, action = '') => `<html><body>Dimension Keeper:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 634 ${event}">${label}</a>`;

// The reference's own formula, truncated exactly as its int cast is.
const fragmentsFor = (level) => Math.floor((Number(level) * 0.15) + 2.6);

module.exports = {
    id: 634,
    name: 'In Search of Fragments of the Dimension',
    npcs: KEEPERS,
    startNpcs: KEEPERS,
    killNpcs: TARGETS,
    eventNpc: () => KEEPERS,
    canTalk: () => true,

    async onEvent(state, event) {
        if (!KEEPERS.includes(Number(state.session.activeNpcTalk?.selfId))) return null;
        if (event === 'start') {
            if (state.isStarted()) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Gather the fragments the dead leave behind. They are yours to keep.');
        }
        if (event === 'quit' && state.isStarted()) {
            // The fragments are ordinary goods, not quest items: ending the
            // errand leaves whatever was already gathered in the pack.
            await step(state, { status: 'created', variables: {} });
            state.playSound('ItemSound.quest_finish');
            return page('Come back when the rift calls you again.');
        }
        return null;
    },

    async onTalk(state, npc) {
        if (!KEEPERS.includes(Number(npc.fetchSelfId()))) return null;
        if (!state.isStarted()) {
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
                return page(`The rift will not open for anyone below level ${MIN_LEVEL}.`);
            }
            return page('The dimension bleeds through the dead of this place.',
                link('start', 'Offer to gather the fragments.'));
        }
        return page(`Fragment of Dimension: ${count(state, DIMENSION_FRAGMENT)}.`,
            link('quit', 'End this task.'));
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        if (!TARGETS.includes(Number(npc.fetchSelfId()))) return;
        if (Math.random() >= DROP_CHANCE) return;
        const amount = fragmentsFor(npc.fetchLevel?.() ?? 0);
        if (amount <= 0) return;
        await step(state, { gives: [[DIMENSION_FRAGMENT, amount]], variables: { ...state.variables } });
        state.playSound('ItemSound.quest_itemget');
    }
};
