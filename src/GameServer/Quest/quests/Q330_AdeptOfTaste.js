// Q330 Adept Of Taste. Source: l2j-lisvus fdc7e33 330_AdeptOfTaste.
//
// Mirien (7469) commissions five market ingredients from specialist handlers:
// Sonia (7062) trades mandragora roots for sap, Jaycubs (7073) beekeeping goods
// for honey, Panos (7078) a contract and hobgoblin amulets for Dionian potato,
// Glyvkas (7067) marsh moss for moss bundles, and Rolant (7069) monster-eye
// bodies for eye meat. Five ingredients earn a cooked steak dish from Mirien,
// rarer specials push the dish a tier up (ten percent chance of an upgrade,
// jackpot sound on the fifth tier); the dish then trades to Chef Jonas (7461)
// for a review, and each review is paid and closes the quest.
const MIRIEN = 7469;
const JONAS = 7461;
const SONIA = 7062;
const JAYCUBS = 7073;
const PANOS = 7078;
const GLYVKAS = 7067;
const ROLANT = 7069;

const LIST = 1420;
const SONIA_BOOK = 1421;
const RED_ROOT = 1422;
const WHITE_ROOT = 1423;
const RED_SAP = 1424;
const WHITE_SAP = 1425;
const JAYCUBS_BOOK = 1426;
const NECTAR = 1427;
const JELLY = 1428;
const HONEY = 1429;
const GOLDEN_HONEY = 1430;
const PANOS_CONTRACT = 1431;
const AMULET = 1432;
const POTATO = 1433;
const GLYVKAS_BOOK = 1434;
const GREEN_MOSS = 1435;
const BROWN_MOSS = 1436;
const GREEN_BUNDLE = 1437;
const BROWN_BUNDLE = 1438;
const ROLANT_BOOK = 1439;
const EYE_BODY = 1440;
const EYE_MEAT = 1441;
const DISHES = [1442, 1443, 1444, 1445, 1446];
const REVIEWS = [1447, 1448, 1449, 1450, 1451];
// Review 3-5 also hand Jonas' recipes back to the kitchen (reference lines 179-192).
const REVIEW_PAY = { 1447: [7500, 0, 6000, 0], 1448: [9000, 0, 7000, 0], 1449: [5800, 1455, 9000, 0],
    1450: [6800, 1456, 10500, 0], 1451: [7800, 1457, 12000, 0] };
// The eight market goods a dish is cooked from (reference takeItems block).
const COOK_TAKES = [RED_SAP, WHITE_SAP, HONEY, GOLDEN_HONEY, POTATO, GREEN_BUNDLE, BROWN_BUNDLE, EYE_MEAT];
const SPECIALS = [WHITE_SAP, GOLDEN_HONEY, BROWN_BUNDLE];
const INGREDIENTS = [RED_SAP, HONEY, POTATO, GREEN_BUNDLE, EYE_MEAT, ...SPECIALS];

const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const adena = (amount) => Math.floor(amount * invoke('GameServer/ProgressionRates').profile().questAdena);
const page = (name, text, action = '') => `<html><body>${name}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 330 ${event}">${label}</a>`;
const hasList = (state) => count(state, LIST) > 0;
const ingredientCount = (state) => INGREDIENTS.reduce((sum, id) => sum + count(state, id), 0);
const specialCount = (state) => SPECIALS.reduce((sum, id) => sum + count(state, id), 0);
const dishCount = (state) => DISHES.reduce((sum, id) => sum + count(state, id), 0);
const reviewCount = (state) => REVIEWS.reduce((sum, id) => sum + count(state, id), 0);
// exitQuest(1) clears the whole quest-item chain 1420..1451 (reference line 78).
const questOwned = (state) => Array.from({ length: 32 }, (_, i) => 1420 + i)
    .map((id) => [id, count(state, id)]).filter(([, n]) => n > 0);

module.exports = {
    id: 330,
    name: 'Adept Of Taste',
    npcs: [MIRIEN, JONAS, SONIA, JAYCUBS, PANOS, GLYVKAS, ROLANT],
    startNpcs: [MIRIEN],
    killNpcs: [147, 154, 155, 156, 204, 223, 226, 228, 229, 265, 266],
    eventNpc: (event) => ({ start: MIRIEN, sonia: SONIA, jaycubs: JAYCUBS, glyvkas: GLYVKAS })[event] || null,
    canTalk: () => true,

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        if (!state.isStarted()) {
            if (npcId !== MIRIEN) return null;
            if (Number(state.session.actor.fetchLevel()) < 24) {
                return page('Mirien', 'Cooking is not a game for children. Come back when you are level 24.');
            }
            return page('Mirien', 'Chef Jonas needs market ingredients for his famous steaks. Visit Sonia, Jaycubs, Panos, Glyvkas and Rolant - each supplies one ingredient. Bring me five and I will cook.',
                link('start', 'Accept.'));
        }
        const cond = state.getInt('cond');
        if (!cond) return null;
        const ing = ingredientCount(state);
        if (npcId === MIRIEN) {
            if (hasList(state) && ing < 5) return page('Mirien', 'Five ingredients, then we cook. Red sap or white sap, honey or golden honey, Dionian potato, a moss bundle, and monster eye meat.');
            if (hasList(state) && ing >= 5) return this.cook(state);
            if (!hasList(state) && ing === 0 && dishCount(state) > 0 && !reviewCount(state)) {
                return page('Mirien', 'The dish is done - take it to Chef Jonas himself and hear his review.');
            }
            if (!hasList(state) && ing === 0 && dishCount(state) === 0 && reviewCount(state) > 0) {
                const review = REVIEWS.find((id) => count(state, id) > 0);
                const [fee, extra, exp] = REVIEW_PAY[review];
                const gives = [[57, adena(fee)]];
                if (extra) gives.push([extra, 1]);
                // Reference exitQuest(1) after payment: the quest closes, ready to
                // be taken from Mirien again.
                await step(state, { takes: [[review, 1], ...questOwned(state).filter(([id]) => id !== review)],
                    gives, exp, status: 'created', variables: {} });
                state.playSound('ItemSound.quest_finish');
                return page('Mirien', 'Jonas was delighted with the dish. Here is your payment - and a recipe to keep.');
            }
            return page('Mirien', 'Five ingredients first.');
        }
        if (npcId === JONAS) {
            if (hasList(state)) return page('Chef Jonas', 'Mirien is cooking for me? Good. I am waiting for the result.');
            if (!hasList(state) && ing === 0 && dishCount(state) > 0 && !reviewCount(state)) {
                const dish = DISHES.find((id) => count(state, id) > 0);
                const review = REVIEWS[DISHES.indexOf(dish)];
                await step(state, { takes: [[dish, 1]], gives: [[review, 1]], variables: { ...state.variables } });
                return page('Chef Jonas', 'Exquisite. Here - write up my review and claim your fee from Mirien.');
            }
            if (!hasList(state) && ing === 0 && dishCount(state) === 0 && reviewCount(state) > 0) {
                return page('Chef Jonas', 'My review? Take it to Mirien, she settles the accounts.');
            }
            return page('Chef Jonas', 'Nothing for me yet.');
        }
        if (npcId === SONIA && hasList(state) && ing < 5) {
            if (!count(state, SONIA_BOOK) && !count(state, RED_SAP) && !count(state, WHITE_SAP)) {
                await step(state, { gives: [[SONIA_BOOK, 1]], variables: { ...state.variables } });
                return page('Trader Sonia', 'Mandragora roots grow on the northern roads - take my botany book and gather 40 of either colour.');
            }
            if (count(state, SONIA_BOOK) && !count(state, RED_SAP) && !count(state, WHITE_SAP)) {
                const roots = count(state, RED_ROOT) + count(state, WHITE_ROOT);
                if (roots < 40) return page('Trader Sonia', 'Both kinds of mandragora root, 40 of a colour. Sonia pays nothing for laziness.');
                if (count(state, WHITE_ROOT) < 40) {
                    return page('Trader Sonia', 'Bring me 40 red roots and the book, and I will press the sap.',
                        link('sonia', 'Hand over the red roots.'));
                }
                // 40 of both colours: the reference presses both batches at once
                // and hands over the white sap.
                await step(state, {
                    takes: [[SONIA_BOOK, count(state, SONIA_BOOK)], [RED_ROOT, count(state, RED_ROOT)],
                        [WHITE_ROOT, count(state, WHITE_ROOT)]],
                    gives: [[WHITE_SAP, 1]], variables: { ...state.variables } });
                state.playSound('ItemSound.quest_middle');
                return page('Trader Sonia', 'Red and white pressed together - white sap, the finest.');
            }
            if (!count(state, SONIA_BOOK) && (count(state, RED_SAP) || count(state, WHITE_SAP))) {
                return page('Trader Sonia', 'You already have my sap. Off you go.');
            }
        }
        if (npcId === JAYCUBS && hasList(state) && ing < 5) {
            if (!count(state, JAYCUBS_BOOK) && !count(state, HONEY) && !count(state, GOLDEN_HONEY)) {
                await step(state, { gives: [[JAYCUBS_BOOK, 1]], variables: { ...state.variables } });
                return page('Beekeeper Jaycubs', 'Take my insect book and gather 20 nectar and 10 royal jelly from the forest bugs.');
            }
            if (count(state, JAYCUBS_BOOK)) {
                if (count(state, NECTAR) < 20) return page('Beekeeper Jaycubs', 'Nectar! 20 jars of it.');
                if (count(state, JELLY) < 10) return page('Beekeeper Jaycubs', 'Nectar enough - now 10 royal jelly, and I will render the honey.',
                    link('jaycubs', 'Render common honey.'));
                await step(state, {
                    takes: [[JAYCUBS_BOOK, count(state, JAYCUBS_BOOK)], [NECTAR, count(state, NECTAR)],
                        [JELLY, count(state, JELLY)]],
                    gives: [[GOLDEN_HONEY, 1]], variables: { ...state.variables } });
                state.playSound('ItemSound.quest_middle');
                return page('Beekeeper Jaycubs', 'Golden honey - the pride of my hives!');
            }
            if (count(state, HONEY) + count(state, GOLDEN_HONEY) === 1) {
                return page('Beekeeper Jaycubs', 'My honey is not for resale. Keep it for the pot.');
            }
        }
        if (npcId === PANOS && hasList(state) && ing < 5) {
            if (!count(state, PANOS_CONTRACT) && !count(state, POTATO)) {
                await step(state, { gives: [[PANOS_CONTRACT, 1]], variables: { ...state.variables } });
                return page('Farmer Panos', 'Sign my contract and bring me 30 amulets off the hobgoblins to the west. Then the secret Dionian potato is yours.');
            }
            if (count(state, PANOS_CONTRACT)) {
                if (count(state, AMULET) < 30) return page('Farmer Panos', '30 hobgoblin amulets. Count them yourself.');
                await step(state, {
                    takes: [[PANOS_CONTRACT, count(state, PANOS_CONTRACT)], [AMULET, count(state, AMULET)]],
                    gives: [[POTATO, 1]], variables: { ...state.variables } });
                state.playSound('ItemSound.quest_middle');
                return page('Farmer Panos', 'A fine potato. The stew will sing.');
            }
            if (count(state, POTATO)) return page('Farmer Panos', 'That potato is already yours, friend.');
        }
        if (npcId === GLYVKAS && hasList(state) && ing < 5) {
            if (!count(state, GLYVKAS_BOOK) && !count(state, GREEN_BUNDLE) && !count(state, BROWN_BUNDLE)) {
                await step(state, { gives: [[GLYVKAS_BOOK, 1]], variables: { ...state.variables } });
                return page('Glyvkas', 'My book knows every moss. Gather 20 green and 20 brown marsh moss for me.');
            }
            if (count(state, GLYVKAS_BOOK)) {
                const moss = count(state, GREEN_MOSS) + count(state, BROWN_MOSS);
                if (moss < 20) return page('Glyvkas', 'The marsh grows both green and brown moss. 20 of each, no less.');
                if (count(state, BROWN_MOSS) < 20) {
                    return page('Glyvkas', 'Bring the mosses with my book and I will bind a bundle.',
                        link('glyvkas', 'Bind the green bundle.'));
                }
                await step(state, {
                    takes: [[GLYVKAS_BOOK, count(state, GLYVKAS_BOOK)], [GREEN_MOSS, count(state, GREEN_MOSS)],
                        [BROWN_MOSS, count(state, BROWN_MOSS)]],
                    gives: [[BROWN_BUNDLE, 1]], variables: { ...state.variables } });
                state.playSound('ItemSound.quest_middle');
                return page('Glyvkas', 'A brown bundle - bitter, but rare.');
            }
            if (count(state, GREEN_BUNDLE) + count(state, BROWN_BUNDLE) === 1) {
                return page('Glyvkas', 'One bundle is enough per cook, traveller.');
            }
        }
        if (npcId === ROLANT && hasList(state) && ing < 5) {
            if (!count(state, ROLANT_BOOK) && !count(state, EYE_MEAT)) {
                await step(state, { gives: [[ROLANT_BOOK, 1]], variables: { ...state.variables } });
                return page('Rolant', 'Monster eyes, 30 of them, from the fungi of the south. My creature book shows where.');
            }
            if (count(state, ROLANT_BOOK)) {
                if (count(state, EYE_BODY) < 30) return page('Rolant', '30 eye bodies. The fungi are plentiful enough.');
                await step(state, {
                    takes: [[ROLANT_BOOK, count(state, ROLANT_BOOK)], [EYE_BODY, count(state, EYE_BODY)]],
                    gives: [[EYE_MEAT, 1]], variables: { ...state.variables } });
                state.playSound('ItemSound.quest_middle');
                return page('Rolant', 'Eye meat - the secret of the steak, eh?');
            }
            if (count(state, EYE_MEAT) === 1) return page('Rolant', 'A single serving of eye meat is all any cook needs.');
        }
        return page('Mirien', 'The kitchen never sleeps.');
    },

    async onEvent(state, event) {
        if (event === 'start') {
            if (state.isStarted() || state.isCompleted()) return null;
            if (Number(state.session.actor.fetchLevel()) < 24) return null;
            await step(state, { variables: { ...state.variables, cond: '1' }, gives: [[LIST, 1]] });
            state.playSound('ItemSound.quest_accept');
            return page('Mirien', 'The ingredient list is in your hands now. Five ingredients, any five.');
        }
        if (!state.isStarted()) return null;
        const ing = ingredientCount(state);
        if (event === 'sonia') {
            if (!hasList(state) || ing >= 5 || !count(state, SONIA_BOOK)) return null;
            const red = count(state, RED_ROOT);
            const white = count(state, WHITE_ROOT);
            if (red + white < 40 || red < 40) return null;
            await step(state, {
                takes: [[SONIA_BOOK, count(state, SONIA_BOOK)], [RED_ROOT, red], [WHITE_ROOT, white]],
                gives: [[RED_SAP, 1]], variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return page('Trader Sonia', 'Red mandragora sap - take it and go.');
        }
        if (event === 'jaycubs') {
            if (!hasList(state) || ing >= 5 || !count(state, JAYCUBS_BOOK)) return null;
            const nectar = count(state, NECTAR);
            const jelly = count(state, JELLY);
            if (nectar < 20 || jelly < 10) return null;
            await step(state, {
                takes: [[JAYCUBS_BOOK, count(state, JAYCUBS_BOOK)], [NECTAR, nectar], [JELLY, jelly]],
                gives: [[HONEY, 1]], variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return page('Beekeeper Jaycubs', 'Plain honey, honest work.');
        }
        if (event === 'glyvkas') {
            if (!hasList(state) || ing >= 5 || !count(state, GLYVKAS_BOOK)) return null;
            const green = count(state, GREEN_MOSS);
            const brown = count(state, BROWN_MOSS);
            if (green + brown < 20 || green < 20) return null;
            await step(state, {
                takes: [[GLYVKAS_BOOK, count(state, GLYVKAS_BOOK)], [GREEN_MOSS, green], [BROWN_MOSS, brown]],
                gives: [[GREEN_BUNDLE, 1]], variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return page('Glyvkas', 'A green bundle, bound tight.');
        }
        return null;
    },

    // The cooking branch of 7469-05: specials set the dish tier, a ten percent
    // roll lifts it once more, and the fifth tier is the jackpot.
    async cook(state) {
        const special = specialCount(state);
        const upgraded = Math.floor(Math.random() * 10) < 1;
        const tier = Math.min(4, special + (upgraded ? 1 : 0));
        const dish = DISHES[tier];
        const takes = [[LIST, 1], ...COOK_TAKES.map((id) => [id, Math.min(1, count(state, id))]).filter(([, n]) => n > 0)];
        await step(state, { takes, gives: [[dish, 1]], variables: { ...state.variables } });
        state.playSound(tier === 4 ? 'ItemSound.quest_jackpot' : 'ItemSound.quest_middle');
        return page('Mirien', `A dish comes off the fire${upgraded ? ' - better than promised!' : '.'}`);
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        if (!state.getInt('cond') || !hasList(state) || ingredientCount(state) >= 5) return;
        const npcId = Number(npc.fetchSelfId());
        const roll = Math.floor(Math.random() * 100);
        const bookSapGates = [223, 154, 155, 156];
        const give = async (item, amount, middleAt) => {
            const held = count(state, item);
            const final = Math.min(amount, (middleAt === undefined ? Infinity : middleAt) - held);
            if (final <= 0) return;
            await step(state, { gives: [[item, final]], variables: { ...state.variables } });
            state.playSound(held + final === middleAt ? 'ItemSound.quest_middle' : 'ItemSound.quest_itemget');
        };
        if (bookSapGates.includes(npcId)) {
            if (!count(state, SONIA_BOOK)) return;
            if (count(state, RED_SAP) || count(state, WHITE_SAP)) return;
            const redAt = { 223: .67, 154: .74, 155: .80, 156: .90 }[npcId] * 100;
            const whiteAt = { 223: .93, 154: .92, 155: .91, 156: .90 }[npcId] * 100;
            if (roll < redAt) await give(RED_ROOT, 1, 40);
            else if (npcId === 156 ? roll >= 90 : roll > whiteAt) await give(WHITE_ROOT, 1, 40);
            return;
        }
        if (npcId === 226 || npcId === 228) {
            if (!count(state, GLYVKAS_BOOK)) return;
            const greenChance = npcId === 226 ? 90 : 88;
            if (roll < greenChance) await give(GREEN_MOSS, 1, 20);
            else await give(BROWN_MOSS, 1, 20);
            return;
        }
        if (npcId === 147) {
            if (!count(state, PANOS_CONTRACT) || count(state, AMULET) >= 30) return;
            await give(AMULET, 1, 30);
            return;
        }
        if (npcId === 204 || npcId === 229) {
            if (!count(state, JAYCUBS_BOOK)) return;
            const nectarChance = npcId === 204 ? 80 : 92;
            if (roll < nectarChance) await give(NECTAR, 1, 20);
            else if (npcId === 204 ? roll > 95 : true) await give(JELLY, 1, 10);
            return;
        }
        if (npcId === 265) {
            if (!count(state, ROLANT_BOOK) || count(state, EYE_BODY) >= 30) return;
            if (roll < 75) await give(EYE_BODY, 1, 30);
            else if (count(state, EYE_BODY) === 29) await give(EYE_BODY, 1, 30);
            else await give(EYE_BODY, 2, 30);
            return;
        }
        if (npcId === 266) {
            if (!count(state, ROLANT_BOOK) || count(state, EYE_BODY) >= 30) return;
            const ten = Math.floor(Math.random() * 10);
            if (ten < 7) await give(EYE_BODY, 1, 30);
            else if (count(state, EYE_BODY) === 29) await give(EYE_BODY, 1, 30);
            else await give(EYE_BODY, 2, 30);
        }
    }
};
