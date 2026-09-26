// Q340 Subjugation of Lizardmen. Source: MOBIUS_C4 6674a607
// Q00340_SubjugationOfLizardmen.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000); ordinary mob
// ids are the reference id - 20000. The raid boss is this quest's one
// exception: reference 25146 is native 10146 (Serpent Demon Bifrons), not 5146,
// which is the unrelated quest monster 27146. See docs/c4/quests/imported-quests.md.
//
// Bifrons' chest is a transient quest spawn exactly as the reference's
// addSpawn(CHEST, npc, false, 30000) is: it stands where the boss fell, belongs
// to the character who felled it, lasts thirty seconds and is not restored
// across a restart.
const WEISZ = 7385;
const ADONIUS = 7375;
const LEVIAN = 7037;
const CHEST = 7989;

const BIFRONS = 10146;
const CARGO_MOBS = [[8, 0.5], [10, 0.52], [14, 0.55]];
const SYMBOL_MOBS = [24, 27, 30];

const CARGO = 4255;
const HOLY = 4256;
const ROSARY = 4257;
const TOTEM = 4258;

const MIN_LEVEL = 17;
const CARGO_REQUIRED = 30;
const SYMBOL_CHANCE = 0.1;
const ROSARY_CHANCE = 0.1;
const REFUSE_ADENA = 4090;
const REWARD_ADENA = 14700;
const CHEST_LIFETIME = 30000;

const World = invoke('GameServer/World/World');
const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const adena = (amount) => [[57, Math.floor(amount * invoke('GameServer/ProgressionRates').profile().questAdena)]];
const page = (who, text, action = '') => `<html><body>${who}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 340 ${event}">${label}</a>`;

// The chest only answers to the character whose kill produced it, and only
// while that spawn is still standing.
function ownedChest(state) {
    const ownerId = Number(state.session.actor.fetchId());
    return (World.npc?.spawns || []).find((npc) => Number(npc.fetchSelfId?.()) === CHEST
        && Number(npc.questSpawn?.ownerId) === ownerId && Number(npc.questSpawn?.questId) === 340);
}

module.exports = {
    id: 340,
    name: 'Subjugation of Lizardmen',
    npcs: [WEISZ, ADONIUS, LEVIAN, CHEST],
    startNpcs: [WEISZ],
    killNpcs: [...CARGO_MOBS.map(([npc]) => npc), ...SYMBOL_MOBS, BIFRONS],
    questSpawns: [CHEST],
    eventNpc: (event) => ({
        start: WEISZ, temple: WEISZ, refuse: WEISZ, paid_continue: WEISZ, paid_quit: WEISZ,
        adonius: ADONIUS, levian: LEVIAN, chest: CHEST
    })[event] ?? null,
    // Weisz talks to anyone: the reference explains the level requirement rather
    // than staying silent. Only start NPCs are reachable before the quest runs,
    // so the other three stay unreachable until it does.
    canTalk: () => true,

    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            await step(state, { variables: { ...state.variables, cond: '1' } });
            state.playSound('ItemSound.quest_accept');
            return page('Weisz', `Recover ${CARGO_REQUIRED} of the stolen cargo boxes from the Felim Lizardmen.`);
        }
        if (!state.isStarted()) return null;
        const cond = state.getInt('cond');
        const cargo = count(state, CARGO);

        // The three hand-in branches all consume the cargo; they differ only in
        // what Weisz pays and whether the subjugation itself continues.
        if (['temple', 'refuse', 'paid_continue', 'paid_quit'].includes(event)) {
            if (cond !== 1 || cargo < CARGO_REQUIRED) return null;
            if (event === 'refuse') {
                return page('Weisz', 'The temple can wait. Name your price.',
                    `${link('paid_continue', 'Take the payment and keep hunting.')}<br>${link('paid_quit', 'Take the payment and be done.')}`);
            }
            if (event === 'temple') {
                await step(state, { takes: [[CARGO, cargo]], variables: { ...state.variables, cond: '2' } });
                state.playSound('ItemSound.quest_middle');
                return page('Weisz', 'Speak to Priest Adonius about the temple raid.');
            }
            // Both paid branches settle the cargo and the payment together; the
            // quit branch additionally releases the quest so it can be retaken.
            const quitting = event === 'paid_quit';
            await step(state, {
                takes: [[CARGO, cargo]], gives: adena(REFUSE_ADENA),
                status: quitting ? 'created' : 'started',
                variables: quitting ? {} : { ...state.variables, cond: '1' }
            });
            state.playSound(quitting ? 'ItemSound.quest_finish' : 'ItemSound.quest_middle');
            return page('Weisz', quitting ? 'Our business is concluded.' : 'Bring me another thirty boxes.');
        }

        if (event === 'adonius' && cond === 2) {
            await step(state, { variables: { ...state.variables, cond: '3' } });
            state.playSound('ItemSound.quest_middle');
            return page('Adonius', "Recover Agnes's Holy Symbol and Rosary from the Langk Lizardmen.");
        }
        if (event === 'levian' && cond === 4) {
            await step(state, { variables: { ...state.variables, cond: '5' } });
            state.playSound('ItemSound.quest_middle');
            return page('Levian', 'Destroy Bifrons and recover the totem it guards.');
        }
        if (event === 'chest' && cond === 5) {
            if (!ownedChest(state)) return null;
            await step(state, { gives: [[TOTEM, 1]], variables: { ...state.variables, cond: '6' } });
            state.playSound('ItemSound.quest_middle');
            return page('Chest of Bifrons', 'The chest holds a black totem. Take it to Levian.');
        }
        return null;
    },

    async onTalk(state, npc) {
        const id = Number(npc.fetchSelfId());
        if (!this.npcs.includes(id)) return null;
        if (state.isCompleted()) return page('Weisz', 'You have already completed this task.');
        if (!state.isStarted()) {
            if (id !== WEISZ) return null;
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
                return page('Weisz', `Only an adventurer of level ${MIN_LEVEL} or above can help us.`);
            }
            return page('Weisz', 'Lizardmen have been raiding the trade wagons.', link('start', 'Accept the subjugation.'));
        }
        const cond = state.getInt('cond');

        if (id === WEISZ) {
            if (cond === 1) {
                if (count(state, CARGO) < CARGO_REQUIRED) {
                    return page('Weisz', `Trade Cargo: ${count(state, CARGO)}/${CARGO_REQUIRED}.`);
                }
                return page('Weisz', 'You have recovered the cargo.',
                    `${link('temple', 'Hear him out about the temple.')}<br>${link('refuse', 'Ask only for payment.')}`);
            }
            if (cond === 2) return page('Weisz', 'Priest Adonius is waiting for you.');
            if (cond === 7) {
                await step(state, {
                    gives: adena(REWARD_ADENA), status: 'completed',
                    variables: { ...state.variables, cond: '0' }
                });
                state.playSound('ItemSound.quest_finish');
                return page('Weisz', 'The lizardmen are broken. Take your reward.');
            }
            return page('Weisz', 'Your task is not finished yet.');
        }

        if (id === ADONIUS) {
            if (cond === 2) {
                return page('Adonius', 'The lizardmen defiled our shrine.', link('adonius', 'Offer to recover the relics.'));
            }
            if (cond === 3) {
                if (!count(state, HOLY) || !count(state, ROSARY)) {
                    return page('Adonius', `Holy Symbol: ${count(state, HOLY)}/1. Rosary: ${count(state, ROSARY)}/1.`);
                }
                await step(state, {
                    takes: [[HOLY, count(state, HOLY)], [ROSARY, count(state, ROSARY)]],
                    variables: { ...state.variables, cond: '4' }
                });
                state.playSound('ItemSound.quest_middle');
                return page('Adonius', 'Agnes can rest now. High Priestess Levian should hear of this.');
            }
            if (cond === 4) return page('Adonius', 'Speak with High Priestess Levian.');
            return page('Adonius', 'We have nothing to discuss yet.');
        }

        if (id === LEVIAN) {
            if (cond === 4) {
                return page('Levian', 'A demon commands the lizardmen.', link('levian', 'Accept the hunt.'));
            }
            if (cond === 5) return page('Levian', 'Bifrons still lives.');
            if (cond === 6) {
                await step(state, {
                    takes: [[TOTEM, count(state, TOTEM)]],
                    variables: { ...state.variables, cond: '7' }
                });
                state.playSound('ItemSound.quest_middle');
                return page('Levian', 'I will destroy this totem. Report to Guard Weisz.');
            }
            if (cond === 7) return page('Levian', 'Guard Weisz is waiting for your report.');
            return page('Levian', 'We have nothing to discuss yet.');
        }

        // CHEST
        if (!ownedChest(state)) return page('Chest of Bifrons', 'The chest does not open for you.');
        if (cond !== 5) return page('Chest of Bifrons', 'The chest is empty.');
        return page('Chest of Bifrons', 'The chest is unlocked.', link('chest', 'Search the chest.'));
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        const id = Number(npc.fetchSelfId());
        const cond = state.getInt('cond');

        if (id === BIFRONS) {
            // The reference spawns the chest on every Bifrons kill, whatever the
            // quest stage; only condition 5 can open it.
            const chest = state.addSpawn(CHEST, {
                locX: npc.fetchLocX?.(), locY: npc.fetchLocY?.(),
                locZ: npc.fetchLocZ?.(), head: npc.fetchHead?.() ?? 0,
                despawnDelay: CHEST_LIFETIME
            });
            // The server's own listeners keep the loop alive; a pending despawn
            // must not be what holds the process open.
            chest?.questSpawn?.timer?.unref?.();
            return;
        }

        const cargo = CARGO_MOBS.find(([mob]) => mob === id);
        if (cargo) {
            if (cond !== 1 || count(state, CARGO) >= CARGO_REQUIRED) return;
            if (Math.random() >= cargo[1]) return;
            const complete = count(state, CARGO) + 1 >= CARGO_REQUIRED;
            await step(state, { gives: [[CARGO, 1]], variables: { ...state.variables } });
            state.playSound(complete ? 'ItemSound.quest_middle' : 'ItemSound.quest_itemget');
            return;
        }

        if (!SYMBOL_MOBS.includes(id) || cond !== 3) return;
        const holy = count(state, HOLY);
        const rosary = count(state, ROSARY);
        // The reference stops rolling as soon as the Holy Symbol is held, which
        // strands the nine players in ten whose nested rosary roll failed:
        // Adonius demands both relics and nothing else can ever drop one. The
        // rolls and their rates are kept exactly as authored; only the outer
        // guard is widened to "does not yet hold both", so the pair stays
        // reachable. See docs/c4/quests/imported-quests.md.
        if (holy && rosary) return;
        if (Math.random() >= SYMBOL_CHANCE) return;
        const gives = [];
        if (!holy) gives.push([HOLY, 1]);
        if (!rosary && Math.random() < ROSARY_CHANCE) gives.push([ROSARY, 1]);
        if (!gives.length) return;
        await step(state, { gives, variables: { ...state.variables } });
        state.playSound('ItemSound.quest_itemget');
    }
};
