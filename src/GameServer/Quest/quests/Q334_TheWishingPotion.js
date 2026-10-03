// Q334 The Wishing Potion. Source: l2j-lisvus fdc7e33 334_TheWishingPotion.
//
// Alchemist Matild (7738), in the little house west of the Ivory Tower, sends
// a level 30+ character after the Alchemy Text and the Secret Book held by the
// Secret Keeper Tree (5139). Eight ingredients, one each, come off the local
// hunt with script-side drop chances; the brew yields Matild's Orb and a Wish
// Potion (3467). Drinking one of four wishes is a gamble: love conjures three
// Succubus of Seduction (5136) or the fairy Rupina (7742), riches spawn three
// Grima (5135) or pays 10,000 adena, kingship gives a Certificate of Royalty
// (3469), an Ancient Crown (3468) or Dark Lord Sanches (5153) - whose kill
// chain Bonaparterius, Ramsebalius and the Great Demon King pays out in books
// and 1,412,965 adena - and wisdom hands out three random spellbooks or a
// Wisdom Chest (7743). The reference never closes the quest: the orb keeps
// the character in the loop, and re-accepting at Matild starts a fresh brew.
const MATILD = 7738;
const TORAI = 7557;
const RUPINA = 7742;
const WISDOM_CHEST = 7743;

const SECRET_KEEPER_TREE = 5139;
const GRIMA = 5135;
const SUCCUBUS = 5136;
const GREAT_DEMON_KING = 5138;
const SANCHES = 5153;
const BONAPARTERIUS = 5154;
const RAMSEBALIUS = 5155;

const ALCHEMY_TEXT = 3678;
const SECRET_BOOK = 3679;
const RECIPE_1 = 3680;
const RECIPE_2 = 3681;
const MATILDS_ORB = 3682;
const FORBIDDEN_LOVE_SCROLL = 3683;
const WISH_POTION = 3467;
const ANCIENT_CROWN = 3468;
const CERTIFICATE_OF_ROYALTY = 3469;
const NECKLACE_OF_GRACE = 931;
const HEART_OF_PAAGRIO = 3943;

const INGREDIENTS = [3684, 3685, 3686, 3687, 3688, 3689, 3690, 3691];
// Mob -> [quest item, percent chance] straight off the reference DROPLIST.
const DROPLIST = {
    199: [3684, 15], 78: [3685, 20], 250: [3686, 35], 227: [3687, 15],
    168: [3688, 30], 87: [3689, 40], 88: [3689, 40], 192: [3690, 50],
    193: [3690, 50], 248: [3691, 25], 249: [3691, 25]
};
// The reference's three long wisdom tables and the four common books.
const R1 = [3081, 3076, 3075, 3074, 4917, 3077, 3080, 3079, 3078, 4928, 4931, 4932, 5013, 3067, 3064, 3061, 3062, 3058, 4206, 3065, 3060, 3063, 4208, 3057, 3059, 3066, 4911, 4918, 3092, 3039, 4922, 3091, 3093, 3431];
const R2 = [3430, 3429, 3073, 3941, 3071, 3069, 3072, 4200, 3068, 3070, 4912, 3100, 3101, 3098, 3094, 3102, 4913, 3095, 3096, 3097, 3099, 3085, 3086, 3082, 4907, 3088, 4207, 3087, 3084, 3083, 4929, 4933, 4919, 3045];
const R3 = [4923, 4201, 4914, 3942, 3090, 4909, 3089, 4930, 4934, 4920, 3041, 4924, 3114, 3105, 3110, 3104, 3113, 3103, 4204, 3108, 4926, 3112, 3107, 4205, 3109, 3111, 3106, 4925, 3117, 3115, 3118, 3116, 4927];
const R4 = [1979, 1980, 2952, 2953];

const MIN_LEVEL = 30;
const MATERIAL_TIME = 200000;
const FAIRY_TIME = 120000;
const CHAIN_TIME = 600000;

const World = invoke('GameServer/World/World');
const step = (state, options) => require('../QuestStep').apply(state, options);
const count = (state, selfId) => state.session.actor.backpack.fetchItems()
    .filter((item) => item.fetchSelfId() === selfId)
    .reduce((sum, item) => sum + item.fetchAmount(), 0);
const adena = (amount) => Math.floor(amount * invoke('GameServer/ProgressionRates').profile().questAdena);
const page = (name, text, action = '') => `<html><body>${name}:<br>${text}<br><br>${action}</body></html>`;
const link = (event, label) => `<a action="bypass -h quest 334 ${event}">${label}</a>`;
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const chance = (bound) => Math.floor(Math.random() * bound);
// exitQuest(1) clears the reference's quest-item set 3678..3682, 3684..3691;
// the potions, crown and certificate of 3467..3469 are ordinary items.
const questOwned = (state) => [...[3678, 3679, 3680, 3681, 3682], ...INGREDIENTS]
    .map((id) => [id, count(state, id)]).filter(([, n]) => n > 0);
// The reference's check_ingredients demands exactly one of each kind.
const exactIngredients = (state) => INGREDIENTS.every((id) => count(state, id) === 1);

// Reference addSpawn is at the character's feet with a fixed lifetime, and
// only the summoning character's kills and talks feed back into the quest.
const spawn = (state, selfId, despawnDelay) => {
    const actor = state.session.actor;
    const npc = World.spawnQuestNpc({
        selfId,
        locX: actor.fetchLocX?.(), locY: actor.fetchLocY?.(), locZ: actor.fetchLocZ?.(),
        head: actor.fetchHead?.() ?? 0,
        ownerId: actor.fetchId(),
        questId: 334,
        despawnDelay
    });
    // A pending despawn must not be what holds the process open.
    npc?.questSpawn?.timer?.unref?.();
    return npc;
};
const ownedSpawn = (state, selfId) => (World.npc?.spawns || []).find((npc) =>
    Number(npc.fetchSelfId?.()) === selfId &&
    Number(npc.questSpawn?.ownerId) === Number(state.session.actor.fetchId()) &&
    Number(npc.questSpawn?.questId) === 334);

module.exports = {
    id: 334,
    name: 'The Wishing Potion',
    npcs: [MATILD, TORAI, RUPINA, WISDOM_CHEST],
    startNpcs: [MATILD],
    killNpcs: [SECRET_KEEPER_TREE, ...Object.keys(DROPLIST).map(Number), SUCCUBUS, GRIMA,
        SANCHES, BONAPARTERIUS, RAMSEBALIUS, GREAT_DEMON_KING],
    questSpawns: [SUCCUBUS, GRIMA, RUPINA, WISDOM_CHEST, SANCHES, BONAPARTERIUS, RAMSEBALIUS, GREAT_DEMON_KING],
    eventNpc: (event) => MATILD,
    // Matild talks to anyone: the reference shows the under-30 refusal rather
    // than staying silent.
    canTalk: () => true,

    async onTalk(state, npc) {
        const npcId = Number(npc.fetchSelfId());
        if (npcId === TORAI) {
            if (!state.isStarted() || !count(state, FORBIDDEN_LOVE_SCROLL)) return null;
            await step(state, { takes: [[FORBIDDEN_LOVE_SCROLL, 1]], gives: [[57, adena(500000)]],
                variables: { ...state.variables } });
            return page('Torai', 'A forbidden love scroll! My thanks - take this and speak of it to no one.');
        }
        if (npcId === RUPINA) {
            if (!state.isStarted()) return null;
            const rupina = ownedSpawn(state, RUPINA);
            const lucky = chance(100) <= 4;
            const gift = lucky ? [[NECKLACE_OF_GRACE, 1]] : [[pick(R4), 1]];
            await step(state, { gives: gift, variables: { ...state.variables } });
            if (rupina) World.despawnQuestNpc(rupina, state.session);
            return lucky
                ? page('Fairy Rupina', 'Take this pendant - it will help you find your soul mate.')
                : page('Fairy Rupina', 'Love is such a lovely thing. Lovers love loving. Love each other!');
        }
        if (npcId === WISDOM_CHEST) {
            if (!state.isStarted()) return null;
            const chest = ownedSpawn(state, WISDOM_CHEST);
            const gives = [[pick(R1), 1], [pick(R2), 1], [pick(R3), 1], [4409, 1], [4408, 1]];
            if (chance(3) === 0) gives.push([HEART_OF_PAAGRIO, 1]);
            await step(state, { gives, variables: { ...state.variables } });
            if (chest) World.despawnQuestNpc(chest, state.session);
            return page('Chest of Wisdom', '(A voice comes out of the chest.) They are magic scrolls that contain the wisdom of sages!');
        }
        // The reference refuses under-30 characters before any other branch.
        if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) {
            return page('Alchemist Matild', 'Many people have their eyes on the secrets of alchemy. You don\'t look strong enough to protect those secrets. Come back at level 30.');
        }
        const cond = state.getInt('cond');
        if (cond === 5 && count(state, MATILDS_ORB)) {
            return page('Alchemist Matild', 'Ah, you there! Do you remember? You made a promise to me. Are you here for the wish potion, or will you gather ingredients for another?',
                `${link('take_potion', 'I want the wish potion.')}<br>${link('start', 'I will gather the ingredients again.')}`);
        }
        if (cond === 4 && exactIngredients(state)) {
            return page('Alchemist Matild', 'Umm... you have collected all the ingredients. You have done a great job. Shall we start?',
                link('brew', 'Make the wish potion.'));
        }
        if (cond === 3 && !exactIngredients(state)) {
            return page('Alchemist Matild', 'I\'m sorry to say this, but we are still short on ingredients. I can\'t start the work until every one is here.');
        }
        if (cond === 2 || (count(state, ALCHEMY_TEXT) && count(state, SECRET_BOOK))) {
            return page('Alchemist Matild', 'You brought the secret book! But while you were away I spent my last adena on precious ingredients. The recipe is in this book - here, take the two lists and gather what is still missing.',
                link('recipe', 'Take the ingredient lists.'));
        }
        if (cond === 1 || (count(state, ALCHEMY_TEXT) && !count(state, SECRET_BOOK))) {
            return page('Alchemist Matild', 'Is the work of finding the secret book progressing well? Not finished yet? Then hurry, please.');
        }
        return page('Alchemist Matild', 'For twenty years I have brewed the finest potions, but the wish potion of ancient lore still eludes me. A clue sits hidden in a book. Go, bring it to me.',
            link('start', 'How can I help?'));
    },

    async onEvent(state, event) {
        // Reference 7738-03: fresh acceptance and the cond-5 re-acceptance run
        // the same code, so only the level gate stands in front of it.
        if (event === 'start') {
            if (Number(state.session.actor.fetchLevel()) < MIN_LEVEL) return null;
            const text = count(state, ALCHEMY_TEXT);
            await step(state, {
                ...(text > 1 ? { takes: [[ALCHEMY_TEXT, text]] } : {}),
                ...(text === 0 ? { gives: [[ALCHEMY_TEXT, 1]] } : {}),
                variables: { ...state.variables, cond: '1' }
            });
            state.playSound('ItemSound.quest_accept');
            return page('Alchemist Matild', 'This alchemy textbook tells where the book of secrets is hidden. Find it, and hurry.');
        }
        if (!state.isStarted()) return null;
        const cond = state.getInt('cond');
        if (event === 'recipe') {
            if (count(state, WISH_POTION)) {
                return page('Alchemist Matild', 'Huh? You already have a wish potion. What a greedy person - drink that one first.');
            }
            const takes = [[ALCHEMY_TEXT, count(state, ALCHEMY_TEXT)], [SECRET_BOOK, count(state, SECRET_BOOK)]];
            const gives = [];
            for (const id of [RECIPE_1, RECIPE_2]) {
                if (count(state, id) >= 2) takes.push([id, count(state, id)]);
                else if (count(state, id) === 1) continue;
                gives.push([id, 1]);
            }
            await step(state, {
                takes: takes.filter(([, n]) => n > 0), gives,
                variables: { ...state.variables, cond: '3' }
            });
            state.playSound('ItemSound.quest_accept');
            return count(state, MATILDS_ORB)
                ? page('Alchemist Matild', 'OK, just like last time, gather the ingredients written here. No long explanations needed, I hope.')
                : page('Alchemist Matild', 'Done deal! Here is the ingredient list - go and get what is written on it. Please!');
        }
        if (event === 'brew') {
            if (!exactIngredients(state)) return null;
            await step(state, {
                takes: questOwned(state),
                gives: [...(!count(state, MATILDS_ORB) ? [[MATILDS_ORB, 1]] : []), [WISH_POTION, 1]],
                variables: { ...state.variables, cond: '5' }
            });
            state.playSound('ItemSound.quest_finish');
            return page('Alchemist Matild', 'The potion is done - Matild\'s Orb is your proof, and the Wish Potion is yours. Choose your wish when you drink it.');
        }
        if (event === 'take_potion') {
            if (count(state, WISH_POTION)) {
                return page('Alchemist Matild', 'Normally you may ask for one of four wishes. Take a look at the card and choose.',
                    `${link('wish_love', 'Make me loving.')}<br>${link('wish_riches', 'Make me rich.')}<br>` +
                    `${link('wish_king', 'Make me a king.')}<br>${link('wish_wisdom', 'Make me the wisest.')}`);
            }
            return page('Alchemist Matild', 'Umm... I am sure you have not made any more wish potion since your last wish...');
        }
        const wishes = { wish_love: 1, wish_riches: 2, wish_king: 3, wish_wisdom: 4 };
        const wish = wishes[event];
        if (wish) {
            if (!count(state, WISH_POTION)) return null;
            const roll = chance(100);
            let gives = [];
            let ceremony = 'OK, apply blood of crow to your forehead first... and start the ceremony...';
            if (wish === 1) {
                ceremony = 'Apply blood of crow, shake wing of fairy three times... the ceremony begins...';
                if (roll <= 50) {
                    for (let i = 0; i < 3; i++) spawn(state, SUCCUBUS, MATERIAL_TIME);
                } else spawn(state, RUPINA, FAIRY_TIME);
            } else if (wish === 2) {
                ceremony = 'Apply blood of crow, shake leaf of timitran three times... the ceremony begins...';
                if (roll <= 33) {
                    for (let i = 0; i < 3; i++) spawn(state, GRIMA, MATERIAL_TIME);
                } else gives = [[57, adena(10000)]];
            } else if (wish === 3) {
                ceremony = 'Apply blood of crow, put the crown of glory on your head... the ceremony begins...';
                if (roll <= 33) gives = [[CERTIFICATE_OF_ROYALTY, 1]];
                else if (roll >= 66) gives = [[ANCIENT_CROWN, 1]];
                else spawn(state, SANCHES, MATERIAL_TIME);
            } else {
                ceremony = 'Apply blood of crow, hit your head three times with a sage\'s staff. Bang! Bang! The ceremony begins...';
                if (roll <= 33) {
                    gives = [[pick(R1), 1], [pick(R2), 1], [pick(R3), 1]];
                    if (chance(3) === 0) gives.push([HEART_OF_PAAGRIO, 1]);
                } else spawn(state, WISDOM_CHEST, FAIRY_TIME);
            }
            await step(state, {
                takes: [[WISH_POTION, 1]], gives,
                variables: { ...state.variables, wish: String(wish) }
            });
            return page('Alchemist Matild', `${ceremony} One! Two! May your dreams come true!`);
        }
        return null;
    },

    async onKill(state, npc) {
        if (!state.isStarted()) return;
        const npcId = Number(npc.fetchSelfId());
        const cond = state.getInt('cond');
        const roll = chance(100);
        if (npcId === SECRET_KEEPER_TREE) {
            if (cond !== 1 || count(state, SECRET_BOOK)) return;
            await step(state, { gives: [[SECRET_BOOK, 1]], variables: { ...state.variables, cond: '2' } });
            state.playSound('ItemSound.quest_itemget');
            return;
        }
        if (DROPLIST[npcId] && cond === 3) {
            const [item, percent] = DROPLIST[npcId];
            if (roll <= percent && !count(state, item)) {
                const next = { ...state.variables };
                const held = { ...Object.fromEntries(INGREDIENTS.map((id) => [id, count(state, id)])) };
                held[item] = 1;
                const done = INGREDIENTS.every((id) => held[id] === 1);
                await step(state, { gives: [[item, 1]],
                    variables: done ? { ...next, cond: '4' } : next });
                state.playSound(done ? 'ItemSound.quest_middle' : 'ItemSound.quest_itemget');
            }
            return;
        }
        if (npcId === SUCCUBUS) {
            if (roll > 3) return;
            await step(state, { gives: [[FORBIDDEN_LOVE_SCROLL, 1]], variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return;
        }
        if (npcId === GRIMA) {
            if (roll >= 4) return;
            const purse = Math.floor(Math.random() * 1000) === 0 ? 100000000 : 900000;
            await step(state, { gives: [[57, adena(purse)]], variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
            return;
        }
        if (npcId === SANCHES || npcId === BONAPARTERIUS || npcId === RAMSEBALIUS) {
            const successor = { [SANCHES]: BONAPARTERIUS, [BONAPARTERIUS]: RAMSEBALIUS, [RAMSEBALIUS]: GREAT_DEMON_KING }[npcId];
            if (roll <= 50) spawn(state, successor, CHAIN_TIME);
            else {
                await step(state, { gives: [[pick(R4), 1]], variables: { ...state.variables } });
                state.playSound('ItemSound.quest_itemget');
            }
            return;
        }
        if (npcId === GREAT_DEMON_KING) {
            await step(state, { gives: [[57, adena(1412965)]], variables: { ...state.variables } });
            state.playSound('ItemSound.quest_itemget');
        }
    }
};
