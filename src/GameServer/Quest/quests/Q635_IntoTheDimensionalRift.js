// Q635 In the Dimensional Rift. Source: MOBIUS_C4 6674a607
// Q00635_IntoTheDimensionalRift.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000), confirmed
// against the reference's own stats/npcs/CT0_to_C4_ids.txt.
//
// Despite the name, the pinned C4 handler is not an instance: there are no
// rooms, no timers, no party admission and no encounter lifecycle. It is a
// two-way passage. A Dimension Keeper outside a catacomb remembers which one you
// came from and sends you to the rift outpost; any Rift Post soldier there sends
// you back to that same catacomb. The whole quest is that round trip.
// See docs/c4/quests/imported-quests.md.
const KEEPERS = Array.from({ length: 14 }, (_, index) => 8494 + index);
const RIFT_POST = Array.from({ length: 6 }, (_, index) => 8488 + index);

const DIMENSION_FRAGMENT = 7079;

const MIN_LEVEL = 20;
// The reference refuses the passage to anyone already carrying more than this
// many active quests, because the return trip needs a quest slot of its own.
const MAX_ACTIVE_QUESTS = 23;

const OUTPOST = { locX: -114790, locY: -180576, locZ: -6781 };

// One destination per keeper, in keeper order: 8494 returns you to the
// Necropolis of Sacrifice, 8495 to the Catacomb of the Heretic, and so on.
// Relocated dungeon coordinates are adapted to C4SevenSignsDungeonTeleports.
const DESTINATIONS = [
    { locX: -41572, locY: 209731, locZ: -5087, name: 'Necropolis of Sacrifice' },
    { locX: 43050, locY: 143933, locZ: -5383, name: 'Catacomb of the Heretic' },
    { locX: 45256, locY: 123906, locZ: -5411, name: "Pilgrim's Necropolis" },
    { locX: 46192, locY: 170290, locZ: -4981, name: 'Catacomb of the Branded' },
    { locX: 111273, locY: 174015, locZ: -5437, name: 'Necropolis of Worship' },
    { locX: 78042, locY: 78404, locZ: -5128, name: 'Catacomb of the Apostate' },
    { locX: -21726, locY: 77385, locZ: -5171, name: "Patriot's Necropolis" },
    { locX: 140405, locY: 79679, locZ: -5427, name: 'Catacomb of the Witch' },
    { locX: -52366, locY: 79097, locZ: -4741, name: 'Necropolis of Devotion' },
    { locX: 118311, locY: 132797, locZ: -4829, name: 'Necropolis of Martyrdom' },
    { locX: 172185, locY: -17602, locZ: -4901, name: "Disciple's Necropolis" },
    { locX: 83000, locY: 209213, locZ: -5439, name: "Saint's Necropolis" },
    { locX: -19500, locY: 13508, locZ: -4901, name: 'Catacomb of Dark Omens' },
    { locX: 113865, locY: 84543, locZ: -6545, name: 'Catacomb of the Forbidden Path' }
];

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const page = (who, text, action = '') => `<html><body>${who}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 635 ${event}">${label}</a>`;
const activeQuests = (session) => invoke('GameServer/Quest/QuestService').active(session).length;
const teleport = (state, where) =>
    invoke('GameServer/Actor/Generics/TeleportTo')(state.session, state.session.actor,
        { locX: where.locX, locY: where.locY, locZ: where.locZ });

module.exports = {
    id: 635,
    name: 'In the Dimensional Rift',
    npcs: [...KEEPERS, ...RIFT_POST],
    startNpcs: KEEPERS,
    eventNpc: (event) => (event === 'enter' ? RIFT_POST : KEEPERS),
    canTalk: () => true,

    async onEvent(state, event) {
        const npcId = Number(state.session.activeNpcTalk?.selfId);

        // A Dimension Keeper offers this passage alongside Q634, so the client's
        // quest chooser reaches it through the ordinary start event. Starting is
        // only the offer; stepping through is its own decision.
        if (event === 'start') {
            if (!KEEPERS.includes(npcId)) return null;
            return this.keeperPage(state);
        }

        if (event === 'passage') {
            if (state.isStarted() || !KEEPERS.includes(npcId)) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            if (activeQuests(state.session) > MAX_ACTIVE_QUESTS) return null;
            if (!count(state, DIMENSION_FRAGMENT)) return null;
            // The fragment is the toll for surviving the rift, not a payment: it
            // is required and never consumed. The keeper's own index is what the
            // return trip reads.
            await step(state, {
                variables: {
                    ...state.variables, cond: '1',
                    keeper: String(KEEPERS.indexOf(npcId)),
                    crossings: String(state.getInt('crossings') + 1)
                }
            });
            state.playSound('ItemSound.quest_accept');
            teleport(state, OUTPOST);
            return page('Dimension Keeper', 'Step through. The rift outpost will send you back.');
        }

        if (event === 'enter') {
            // Any of the six Rift Post ranks will open the way back.
            if (!state.isStarted() || !RIFT_POST.includes(npcId)) return null;
            const destination = DESTINATIONS[state.getInt('keeper')];
            if (!destination) return null;
            await step(state, { status: 'created', variables: { crossings: state.get('crossings', '0') } });
            state.playSound('ItemSound.quest_finish');
            teleport(state, destination);
            return page('Rift Post', `The way back to the ${destination.name} is open.`);
        }
        return null;
    },

    async onTalk(state, npc) {
        const id = Number(npc.fetchSelfId());
        if (!this.npcs.includes(id)) return null;

        if (RIFT_POST.includes(id)) {
            if (!state.isStarted()) return page('Rift Post', 'You did not come through the rift.');
            const destination = DESTINATIONS[state.getInt('keeper')];
            if (!destination) return page('Rift Post', 'The rift has lost your bearing.');
            return page('Rift Post', `You came from the ${destination.name}.`,
                link('enter', 'Ask to be sent back.'));
        }

        return this.keeperPage(state);
    },

    // What a Dimension Keeper has to say, whether the player arrived by talking
    // to him directly or by choosing this quest from his list.
    keeperPage(state) {
        if (state.isStarted()) {
            return page('Dimension Keeper', 'You are already through. The outpost will send you back.');
        }
        if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
            return page('Dimension Keeper', `The rift will not hold anyone below level ${MIN_LEVEL}.`);
        }
        if (activeQuests(state.session) > MAX_ACTIVE_QUESTS) {
            return page('Dimension Keeper', 'You are carrying too many errands to keep your bearing.');
        }
        if (!count(state, DIMENSION_FRAGMENT)) {
            return page('Dimension Keeper', 'Without a Fragment of Dimension the rift would unmake you.');
        }
        return page('Dimension Keeper', 'The rift will take you, and remember where you came from.',
            link('passage', 'Step through.'));
    }
};
