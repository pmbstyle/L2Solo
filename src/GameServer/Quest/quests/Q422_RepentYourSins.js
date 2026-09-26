// Q422 Repent Your Sins. Source: MOBIUS_C4 6674a607 Q00422_RepentYourSins.
//
// NPC ids are L2Solo native datapack ids (reference id - 23000), confirmed
// against the reference's own stats/npcs/CT0_to_C4_ids.txt.
//
// This is the Sin Eater quest, and the Sin Eater itself is not built here: the
// server already summons it. PetRules maps the Penitent's Manacles (4425) to
// summon 12564, C4ItemSkills gives the collar its summon skill, and the pet's
// own level, feeding and persistence are the ordinary pet runtime. What this
// quest owns is the errand that earns the collar and the reckoning that spends
// it. See docs/c4/quests/imported-quests.md.
//
// The reckoning is the only authoritative way a character's PK count falls, and
// it is deliberately expensive: the Sin Eater must have gained a level since the
// collar was issued, and the collar is consumed either way.
const BLACK_JUDGE = 7981;
const KATARI = 7668;
const PIOTUR = 7597;
const CASIAN = 7612;
const JOAN = 7718;
const PUSHKIN = 7300;

const RATMAN_SKULL = 4326;
const WAR_HOUND_TAIL = 4327;
const KINGPIN_HEART = 4328;
const VENOM_SAC = 4329;
const CRAFTED_MANACLES = 4330;
const MANUAL_OF_MANACLES = 4331;
const PENITENT_MANACLES = 4425;
const LEFTOVER_MANACLES = 4426;

// Pushkin's bill of materials.
const FORGE_COST = [[1873, 10], [1877, 2], [1879, 10], [1880, 5], [1892, 1]];

const SIN_EATER_NPC = 12564;
const MAX_PK_REMOVED = 10;

// Each band of the Black Judge's sentence names its errand: which cond the
// sentence starts at, who assigns it, what to bring, and what proves it.
const SENTENCES = [
    { band: 2, npc: KATARI, hunting: 6, done: 10, target: 39, item: RATMAN_SKULL, required: 10 },
    { band: 3, npc: PIOTUR, hunting: 7, done: 11, target: 494, item: WAR_HOUND_TAIL, required: 10 },
    { band: 4, npc: CASIAN, hunting: 8, done: 12, target: 193, item: KINGPIN_HEART, required: 1 },
    { band: 5, npc: JOAN, hunting: 9, done: 13, target: 561, item: VENOM_SAC, required: 3 }
];
const QUEST_ITEMS = [RATMAN_SKULL, WAR_HOUND_TAIL, KINGPIN_HEART, VENOM_SAC,
    CRAFTED_MANACLES, MANUAL_OF_MANACLES, PENITENT_MANACLES];

const step = (state, options) => require('../QuestStep').apply(state, options);
const items = (state) => state.session.actor.backpack.fetchItems();
const count = (state, selfId) => items(state)
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const page = (who, text, action = '') => `<html><body>${who}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 422 ${event}">${label}</a>`;
const sentenceFor = (cond) => SENTENCES.find((entry) =>
    [entry.band, entry.hunting, entry.done].includes(cond));

// The reference reads the Sin Eater's level off the collar's enchant level.
// Locally the pet's own saved state lives on the collar, so its level is read
// from there instead.
function sinEaterLevel(state) {
    const collar = items(state).find((item) => item.fetchSelfId() === PENITENT_MANACLES);
    return Number(collar?.fetchPetData?.()?.level) || 0;
}

function sinEaterSummoned(state) {
    return Number(state.session.actor.pet?.fetchSelfId?.()) === SIN_EATER_NPC;
}

// The reference's four sentencing bands. They overlap at 20, 30 and 40, and the
// first match wins, so the bands really are <=20, 21-30, 31-40 and above.
function bandFor(level) {
    if (level <= 20) return 2;
    if (level <= 30) return 3;
    if (level <= 40) return 4;
    return 5;
}

module.exports = {
    id: 422,
    name: 'Repent Your Sins',
    npcs: [BLACK_JUDGE, KATARI, PIOTUR, CASIAN, JOAN, PUSHKIN],
    startNpcs: [BLACK_JUDGE],
    killNpcs: SENTENCES.map((entry) => entry.target),
    eventNpc: () => BLACK_JUDGE,
    canTalk: () => true,

    async onEvent(state, event) {
        const actor = state.session.actor;

        if (event === 'start') {
            if (state.isStarted()) return null;
            if (Number(actor.fetchPk?.() || 0) < 1) return null;
            if (count(state, LEFTOVER_MANACLES)) return null;
            const band = bandFor(Number(actor.fetchLevel()));
            await step(state, { variables: { ...state.variables, cond: String(band) } });
            state.playSound('ItemSound.quest_accept');
            const sentence = SENTENCES.find((entry) => entry.band === band);
            return page('Black Judge', 'Your sentence is set. Go and hear it.',
                `Seek out ${['Katari', 'Piotur', 'Casian', 'Joan'][SENTENCES.indexOf(sentence)]}.`);
        }

        if (event === 'reissue') {
            // A character who still carries a spent pair can begin the reckoning
            // again without repeating the errand.
            if ((state.isStarted() && state.getInt('cond') !== 16)
                || count(state, PENITENT_MANACLES) || !count(state, LEFTOVER_MANACLES)
                || Number(actor.fetchPk?.() || 0) < 1) return null;
            await step(state, {
                takes: [[LEFTOVER_MANACLES, 1]], gives: [[PENITENT_MANACLES, 1]],
                variables: { ...state.variables, cond: '16', level: String(actor.fetchLevel()) }
            });
            state.playSound('ItemSound.quest_itemget');
            return page('Black Judge', 'Take them up again, and let the Sin Eater grow.');
        }

        if (!state.isStarted()) return null;
        const cond = state.getInt('cond');

        if (event === 'manacles') {
            // The crafted pair becomes the collar, and the level it must beat is
            // recorded in the same commit.
            if (cond !== 15 || !count(state, CRAFTED_MANACLES)) return null;
            await step(state, {
                takes: [[CRAFTED_MANACLES, count(state, CRAFTED_MANACLES)]],
                gives: [[PENITENT_MANACLES, 1]],
                variables: { ...state.variables, cond: '16', level: String(actor.fetchLevel()) }
            });
            state.playSound('ItemSound.quest_itemget');
            return page('Black Judge', 'Summon what these call, and feed it your sins.');
        }

        if (event === 'repent') {
            if (cond !== 16 || !count(state, PENITENT_MANACLES)) return null;
            if (sinEaterSummoned(state)) {
                return page('Black Judge', 'Send it away first. I will not speak over it.');
            }
            if (sinEaterLevel(state) <= state.getInt('level')) {
                return page('Black Judge', 'It has eaten nothing since I gave it to you.');
            }
            const removed = 1 + Math.floor(Math.random() * MAX_PK_REMOVED);
            const carried = Number(actor.fetchPk?.() || 0);
            const cleared = carried <= removed;
            // The collar is spent, the leftover pair is issued and the sins are
            // struck off in one commit, so the reckoning cannot be replayed.
            await step(state, {
                takes: [[PENITENT_MANACLES, count(state, PENITENT_MANACLES)]],
                gives: [[LEFTOVER_MANACLES, 1]],
                pk: { expected: carried, next: cleared ? 0 : carried - removed },
                status: cleared ? 'created' : 'started',
                variables: cleared ? {} : { ...state.variables, cond: '16', level: String(actor.fetchLevel()) }
            });
            state.playSound(cleared ? 'ItemSound.quest_finish' : 'ItemSound.quest_middle');
            return page('Black Judge', cleared
                ? 'Your slate is clean. Do not come back to me.'
                : `It ate ${removed} of your sins. ${actor.fetchPk()} remain.`);
        }

        if (event === 'quit') {
            await step(state, {
                takes: QUEST_ITEMS.map((selfId) => [selfId, count(state, selfId)]).filter(([, n]) => n > 0),
                status: 'created', variables: {}
            });
            state.playSound('ItemSound.quest_finish');
            return page('Black Judge', 'Then carry your sins yourself.');
        }
        return null;
    },

    async onTalk(state, npc) {
        const id = Number(npc.fetchSelfId());
        if (!this.npcs.includes(id)) return null;
        const actor = state.session.actor;

        if (!state.isStarted()) {
            if (id !== BLACK_JUDGE) return null;
            if (count(state, LEFTOVER_MANACLES)) {
                return page('Black Judge', 'You still carry the spent pair.',
                    `${link('reissue', 'Ask for them to be renewed.')}<br>${link('quit', 'Be done with this.')}`);
            }
            if (Number(actor.fetchPk?.() || 0) < 1) {
                return page('Black Judge', 'You have no blood on you. I have nothing to judge.');
            }
            return page('Black Judge', 'Sin is a weight. I know something that eats it.',
                link('start', 'Accept the sentence.'));
        }
        const cond = state.getInt('cond');

        if (id === PUSHKIN) {
            if (cond !== 14 || !count(state, MANUAL_OF_MANACLES)) {
                return page('Pushkin', 'I have no work from you.');
            }
            const missing = FORGE_COST.filter(([selfId, amount]) => count(state, selfId) < amount);
            if (missing.length) {
                return page('Pushkin', FORGE_COST
                    .map(([selfId, amount]) => `${count(state, selfId)}/${amount} of item ${selfId}`)
                    .join('<br>'));
            }
            await step(state, {
                takes: [[MANUAL_OF_MANACLES, 1], ...FORGE_COST],
                gives: [[CRAFTED_MANACLES, 1]],
                variables: { ...state.variables, cond: '15' }
            });
            state.playSound('ItemSound.quest_middle');
            return page('Pushkin', 'Heavy work. Take them back to the Black Judge.');
        }

        if (id === BLACK_JUDGE) {
            if (cond <= 9) return page('Black Judge', 'Your sentence is not served yet.');
            if (cond >= 10 && cond <= 13) {
                await step(state, {
                    gives: [[MANUAL_OF_MANACLES, 1]],
                    variables: { ...state.variables, cond: '14' }
                });
                state.playSound('ItemSound.quest_middle');
                return page('Black Judge', 'Take this to Pushkin and have the manacles made.');
            }
            if (cond === 14) return page('Black Judge', 'Pushkin is waiting for the manual.');
            if (cond === 15) {
                return page('Black Judge', 'You have the manacles.',
                    link('manacles', 'Hand them over.'));
            }
            if (!count(state, PENITENT_MANACLES) && count(state, LEFTOVER_MANACLES)) {
                return page('Black Judge', 'You still carry the spent pair.', link('reissue', 'Ask for them to be renewed.'));
            }
            if (!count(state, PENITENT_MANACLES)) {
                return page('Black Judge', 'You have lost what I gave you.', link('quit', 'Be done with this.'));
            }
            if (sinEaterSummoned(state)) {
                return page('Black Judge', 'Send the Sin Eater away before we speak.');
            }
            if (sinEaterLevel(state) <= state.getInt('level')) {
                return page('Black Judge', `The Sin Eater must grow past level ${state.getInt('level')}.`);
            }
            return page('Black Judge', 'It has fed well.',
                `${link('repent', 'Let it take your sins.')}<br>${link('quit', 'Be done with this.')}`);
        }

        // The four sentencing NPCs. Each one assigns its own errand and takes
        // its own proof; none of them will speak about somebody else's sentence.
        const sentence = SENTENCES.find((entry) => entry.npc === id);
        if (!sentence || sentenceFor(cond) !== sentence) {
            return page('Quest', 'That is not the sentence you were given.');
        }
        const who = { [KATARI]: 'Katari', [PIOTUR]: 'Piotur', [CASIAN]: 'Casian', [JOAN]: 'Joan' }[id];
        if (cond === sentence.band) {
            await step(state, { variables: { ...state.variables, cond: String(sentence.hunting) } });
            state.playSound('ItemSound.quest_middle');
            return page(who, `Bring me ${sentence.required} of what the beasts carry.`);
        }
        if (cond === sentence.done) return page(who, 'Your sentence is served. Go to the Black Judge.');
        if (count(state, sentence.item) < sentence.required) {
            return page(who, `${count(state, sentence.item)}/${sentence.required}.`);
        }
        await step(state, {
            takes: [[sentence.item, count(state, sentence.item)]],
            variables: { ...state.variables, cond: String(sentence.done) }
        });
        state.playSound('ItemSound.quest_middle');
        return page(who, 'That will do. The Black Judge will hear of it.');
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        const cond = state.getInt('cond');
        const sentence = SENTENCES.find((entry) => entry.hunting === cond
            && entry.target === Number(npc.fetchSelfId()));
        if (!sentence) return;
        const held = count(state, sentence.item);
        if (held >= sentence.required) return;
        await step(state, { gives: [[sentence.item, 1]], variables: { ...state.variables } });
        state.playSound(held + 1 >= sentence.required
            ? 'ItemSound.quest_middle' : 'ItemSound.quest_itemget');
    }
};
