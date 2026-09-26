// C4 quest 350: Lisvus datapack, revision fdc7e33af5d69067b41a6ee7cc7c07fe7aa35975.
// Starting level: legacy-lineage2.com/Knowledge/quest3.html.
const NPCS = {
    7115: 'Grand Magister Jurek',
    7194: 'Magister Gideon',
    7856: 'Magister Winonin'
};
const COLORS = { red: 4629, green: 4640, blue: 4651 };
const CRYSTALS = new Set([
    ...Array.from({ length: 36 }, (_, i) => 4629 + i), // Stages 0-10 and broken crystals.
    5577, 5578, 5579, 5580, 5581, 5582, // Stages 11-12.
    5908, 5911, 5914 // Stage 13.
]);
const service = () => invoke('GameServer/Quest/QuestService');
const link = (npcId, event, text) => `<a action="bypass -h quest 350 ${npcId}_${event}">${text}</a>`;
const page = (npcId, text) => `<html><body>${NPCS[npcId]}:<br>${text}</body></html>`;

function parseEvent(event) {
    const match = /^(7115|7194|7856)_(start|red|green|blue|help|quit)$/.exec(event);
    return match ? { npcId: Number(match[1]), action: match[2] } : null;
}

function hasCrystal(state) {
    return state.session.actor.backpack.fetchItems().some(item =>
        CRYSTALS.has(Number(item.fetchSelfId())) && item.fetchAmount() > 0);
}

function progressPage(state, npcId) {
    const text = hasCrystal(state)
        ? 'You already carry a soul crystal or its broken remains. Collect souls with an intact crystal. '
            + 'If you need a new crystal, first put away your existing crystals or discard the broken remains.'
        : 'Choose a soul crystal. Its color determines which special ability it can bestow on a particular weapon.<br><br>'
            + Object.keys(COLORS).map(color => link(npcId, color,
                `${color[0].toUpperCase() + color.slice(1)} Soul Crystal`)).join('<br>');
    return page(npcId, `${text}<br><br>${link(npcId, 'help', 'How do I collect souls?')}<br>`
        + link(npcId, 'quit', 'Quit (unused stage 0 crystals will be removed).'));
}

async function abort(state) {
    // Lisvus marks only the three starter crystals as quest items to remove on exit.
    // Upgraded crystals are retained, including when quitting through the quest journal.
    for (const id of Object.values(COLORS)) {
        while (state.session.actor.backpack.fetchItemFromSelfId(id)) {
            if (!await service().takeItem(state.session, id, -1)) break;
        }
    }
    await state.exit(true);
}

module.exports = {
    id: 350,
    name: 'Enhance Your Weapon',
    npcs: Object.keys(NPCS).map(Number),
    startNpcs: Object.keys(NPCS).map(Number),
    canTalk: state => state.isStarted() || state.session.actor.fetchLevel() >= 40,
    eventNpc: event => parseEvent(event)?.npcId ?? null,
    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        if (!NPCS[npcId]) return null;
        if (state.isStarted()) return progressPage(state, npcId);
        if (state.session.actor.fetchLevel() < 40) return page(npcId, 'Return when you reach level 40.');
        return page(npcId, 'A great darkness approaches. We are preparing by learning to enhance our weapons '
            + `with the souls of powerful creatures.<br><br>${link(npcId, 'start', 'I wish to learn how to enhance my weapon.')}`);
    },
    async onEvent(state, event) {
        const parsed = parseEvent(event);
        if (!parsed) return null;
        const { npcId, action } = parsed;
        if (action === 'start') {
            if (!state.isStarted()) {
                if (state.session.actor.fetchLevel() < 40) return null;
                await state.setState('started');
                await state.set('cond', 1);
                state.playSound('ItemSound.quest_accept');
            }
            return progressPage(state, npcId);
        }
        if (!state.isStarted()) return null;
        if (Object.hasOwn(COLORS, action)) {
            // QuestService serializes events; always recheck inventory on the actual click.
            if (!hasCrystal(state)) await service().giveItem(state.session, COLORS[action], 1);
            return progressPage(state, npcId);
        }
        if (action === 'help') {
            return page(npcId, 'Carry only one soul crystal while collecting souls. Use it on a suitable monster '
                + 'when its HP is at half or below, then land the killing blow. Absorption may fail or break the crystal. '
                + 'As the crystal grows, it requires stronger souls.<br><br>'
                + 'Seek suitable creatures near Oren, in the Forest of Mirrors, Giants Cave, the Devastated Castle, '
                + 'the upper Tower of Insolence, deep in Antharas\' Lair, the Garden of Eva or Devil\'s Isle. '
                + 'Ordinary absorption reaches stage 10; higher stages require special bosses.<br><br>'
                + 'Take a crystal of the required color and stage, your weapon and the required payment to a blacksmith. '
                + `The ability depends on the weapon.<br><br>${link(npcId, 'start', 'Back')}`);
        }
        if (action === 'quit') {
            await abort(state);
            return page(npcId, 'You have left the quest. Return when you wish to collect souls again.');
        }
        return null;
    },
    onAbort: abort
};
