// Q334 The Wishing Potion runtime certification (l2j-lisvus 334_TheWishingPotion).
//
// Drives the real QuestService: the level-30 gate, the Alchemy Text and the
// Secret Book, the two recipe lists, the eight script-dropped ingredients, the
// brew, the four wishes (Succubi/Rupina, three Grima/10,000 adena,
// Certificate/Crown/Sanches, spellbooks/Wisdom Chest), the Torai scroll sale,
// the Grima purse, the Sanches kill chain and the Wisdom Chest hand-out.
// Quest spawns live in a minimal World, exactly as in the 340 certification.
const assert = require('node:assert/strict');
const { createWorld, enableQuestSpawns, withRandom } = require('./helpers/c4QuestHarness');

const MATILD = 7738, TORAI = 7557, RUPINA = 7742, WISDOM = 7743;
const TREE = 5139, GRIMA = 5135, SUCCUBUS = 5136, DEMON = 5138;
const SANCHES = 5153, BONA = 5154, RAMSE = 5155;
const TEXT = 3678, BOOK = 3679, REC1 = 3680, REC2 = 3681, ORB = 3682, SCROLL = 3683;
const POTION = 3467, CROWN = 3468, CERT = 3469;
const INGREDIENTS = [3684, 3685, 3686, 3687, 3688, 3689, 3690, 3691];
// One mob per ingredient, in DROPLIST order (all of them drop above roll 0.1).
const MATERIAL_MOBS = [199, 78, 250, 227, 168, 87, 192, 248];

async function main() {
    const world = await createWorld([
        { id: 334, level: 30 },
        { id: 9334, level: 29 },
    ], 'c4-wishing');
    enableQuestSpawns();
    const World = invoke('GameServer/World/World');
    const session = await world.session(334);
    // Reference addSpawn is at the character's feet; the harness row sits at 0,0,0.
    Object.assign(session.actor, {
        fetchLocX: () => 0, fetchLocY: () => 0, fetchLocZ: () => 0, fetchHead: () => 0
    });
    const rig = (value) => { Math.random = () => value; };
    const alive = (selfId) => World.npc.spawns.filter((npc) => Number(npc.fetchSelfId()) === selfId).length;

    // The under-30 refusal, and no acceptance through a bypass.
    {
        const young = await world.session(9334);
        await world.talk(young, MATILD);
        assert.match(world.page(young), /level 30/, 'Matild refuses anyone under 30');
        await world.event(young, 334, 'start', MATILD);
        assert.equal(young.questStates.get(334)?.getInt('cond'), 0, 'the bypass cannot start it either');
    }

    // Intro, acceptance, the Secret Keeper Tree, the two recipe lists.
    await world.talk(session, MATILD);
    assert.match(world.page(session), /wish potion/i);
    await world.event(session, 334, 'start', MATILD);
    assert.equal(session.questStates.get(334).getInt('cond'), 1);
    assert.equal(await world.amount(334, TEXT), 1, 'one Alchemy Text');

    rig(0.1);
    await world.kill(session, TREE);
    assert.equal(session.questStates.get(334).getInt('cond'), 2);
    assert.equal(await world.amount(334, BOOK), 1, 'the tree leaves the secret book');
    await world.kill(session, TREE);
    assert.equal(await world.amount(334, BOOK), 1, 'a second kill gives no second book');

    await world.talk(session, MATILD);
    assert.match(world.page(session), /secret book/i);
    await world.event(session, 334, 'recipe', MATILD);
    assert.equal(await world.amount(334, REC1), 1);
    assert.equal(await world.amount(334, REC2), 1, 'both recipe lists');
    assert.equal(await world.amount(334, TEXT), 0, 'the book chain is consumed');
    assert.equal(session.questStates.get(334).getInt('cond'), 3);

    // Ingredients: exactly one of each kind, the eighth one closing the hunt.
    const brewPotion = async () => {
        await world.event(session, 334, 'start', MATILD); // 7738-03 re-acceptance
        rig(0.1);
        await world.kill(session, TREE);
        await world.event(session, 334, 'recipe', MATILD);
        rig(0.1);
        for (let n = 0; n < 8; n++) await world.kill(session, MATERIAL_MOBS[n]);
        assert.equal(session.questStates.get(334).getInt('cond'), 4, 'eight ingredients finish the hunt');
        await world.event(session, 334, 'brew', MATILD);
        assert.equal(await world.amount(334, POTION), 1, 'a fresh Wish Potion is brewed');
    };

    rig(0.1);
    for (let n = 0; n < 8; n++) await world.kill(session, MATERIAL_MOBS[n]);
    assert.equal(session.questStates.get(334).getInt('cond'), 4, 'eight ingredients finish the hunt');
    rig(0.1);
    await world.kill(session, 199);
    assert.equal(await world.amount(334, 3684), 1, 'no second scale of the same kind');
    await world.talk(session, MATILD);
    assert.match(world.page(session), /collected all the ingredients/i);
    await world.event(session, 334, 'brew', MATILD);
    assert.equal(await world.amount(334, POTION), 1, 'the Wish Potion is handed over');
    assert.equal(await world.amount(334, ORB), 1, "Matild's Orb proves the brew");
    assert.equal(session.questStates.get(334).getInt('cond'), 5);
    for (const id of INGREDIENTS) assert.equal(await world.amount(334, id), 0, 'every ingredient is consumed');
    assert.equal(await world.amount(334, REC1), 0);
    assert.equal(await world.amount(334, REC2), 0);

    // A second potion cannot be requested while one is held (7738-13).
    await world.event(session, 334, 'recipe', MATILD);
    assert.equal(await world.amount(334, REC1), 0, '7738-13 blocks a double brew');

    // The wish card offers exactly the four reference wishes.
    await world.talk(session, MATILD);
    assert.match(world.page(session), /promise to me/i, 'the orb holder sees 7738-11');
    await world.event(session, 334, 'take_potion', MATILD);
    assert.match(world.page(session), /wish_love/);
    assert.match(world.page(session), /wish_wisdom/);

    // Wish I on a ≤50 roll: three Succubus of Seduction, and 3% Forbidden Love
    // Scrolls that Torai buys for 500,000.
    rig(0.2);
    await world.event(session, 334, 'wish_love', MATILD);
    assert.equal(alive(SUCCUBUS), 3, 'three succubi answer the wish for love');
    assert.equal(await world.amount(334, POTION), 0, 'the potion is drunk');
    await world.event(session, 334, 'take_potion', MATILD);
    assert.match(world.page(session), /not made any more wish potion/i, '7738-14 withholds the empty card');
    rig(0.01);
    await world.kill(session, SUCCUBUS);
    assert.equal(await world.amount(334, SCROLL), 1, 'a succubus leaves a forbidden love scroll');
    const adena0 = await world.amount(334, 57);
    await world.talk(session, TORAI);
    assert.equal(await world.amount(334, SCROLL), 0, 'Torai takes the scroll');
    assert.equal(await world.amount(334, 57) - adena0, 500000, 'Torai pays 500000');

    // Wish II on a >33 roll pays 10000 adena; a Grima kill then rolls 4% for
    // 900000 (the reference's 1/1000 jackpot needs a second, non-zero roll).
    await brewPotion();
    const adena1 = await world.amount(334, 57);
    rig(0.9);
    await world.event(session, 334, 'wish_riches', MATILD);
    assert.equal(await world.amount(334, 57) - adena1, 10000, 'the failed rich-man wish pays 10000');
    const adenaGrima = await world.amount(334, 57);
    rig(0.01);
    await world.kill(session, GRIMA);
    assert.equal(await world.amount(334, 57) - adenaGrima, 900000, 'a Grima purse pays 900000');

    // Wish III: the low roll gives the Certificate, the high one the Crown.
    await brewPotion();
    rig(0.01);
    await world.event(session, 334, 'wish_king', MATILD);
    assert.equal(await world.amount(334, CERT), 1, 'a low roll yields the Certificate of Royalty');
    await brewPotion();
    rig(0.9);
    await world.event(session, 334, 'wish_king', MATILD);
    assert.equal(await world.amount(334, CROWN), 1, 'a high roll yields the Ancient Crown');

    // The middle roll summons Dark Lord Sanches; the chain continues through
    // Bonaparterius and Ramsebalius to the Great Demon King, whose kill pays
    // 1,412,965. A >50 roll hands out one of the four common books instead.
    rig(0.01);
    await world.kill(session, SANCHES);
    assert.equal(alive(BONA), 1, 'Sanches calls Bonaparterius');
    await world.kill(session, BONA);
    assert.equal(alive(RAMSE), 1, 'Bonaparterius calls Ramsebalius');
    await world.kill(session, RAMSE);
    assert.equal(alive(DEMON), 1, 'Ramsebalius calls the Great Demon King');
    const adena2 = await world.amount(334, 57);
    await world.kill(session, DEMON);
    assert.equal(await world.amount(334, 57) - adena2, 1412965, 'the Demon King pays 1412965');
    const books0 = await world.amount(334, 1979) + await world.amount(334, 1980)
        + await world.amount(334, 2952) + await world.amount(334, 2953);
    rig(0.9);
    await world.kill(session, SANCHES);
    const books1 = await world.amount(334, 1979) + await world.amount(334, 1980)
        + await world.amount(334, 2952) + await world.amount(334, 2953);
    assert.equal(books1 - books0, 1, 'an unlucky chain roll drops one of the four books instead');

    // Wish IV: a ≤33 roll hands out three random spellbooks and, on a further
    // 1-in-3, the Heart of Pa'agrio; the high roll spawns the Wisdom Chest,
    // whose talk pays three more books, 4409 and 4408, and then it vanishes.
    await brewPotion();
    rig(0.01);
    await world.event(session, 334, 'wish_wisdom', MATILD);
    assert.equal(await world.amount(334, 3081), 1, 'the first R1 book on roll 0.01');
    assert.equal(await world.amount(334, 3430), 1, 'the first R2 book');
    assert.equal(await world.amount(334, 4923), 1, 'the first R3 book');
    assert.equal(await world.amount(334, 3943), 1, "0.01 also wins the Heart of Pa'agrio");
    await brewPotion();
    rig(0.9);
    await world.event(session, 334, 'wish_wisdom', MATILD);
    assert.equal(alive(WISDOM), 1, 'the high roll spawns the Wisdom Chest');
    const chest0 = await world.amount(334, 4409);
    await world.talk(session, WISDOM);
    assert.equal(await world.amount(334, 4409) - chest0, 1, 'the chest hands out 4409');
    assert.equal(await world.amount(334, 4408), 1, 'and 4408');
    assert.equal(await world.amount(334, 3943), 1, '0.9 misses the heart again');
    assert.equal(alive(WISDOM), 0, 'the chest disappears after its gift');

    // The >50 love wish sends the single fairy instead: 5% Necklace of Grace,
    // a common book otherwise, and she leaves after one talk either way.
    await brewPotion();
    rig(0.9);
    await world.event(session, 334, 'wish_love', MATILD);
    assert.equal(alive(RUPINA), 1, 'the >50 love roll summons Rupina');
    const necklace0 = await world.amount(334, 931);
    rig(0.01);
    await world.talk(session, RUPINA);
    assert.equal(await world.amount(334, 931) - necklace0, 1, 'the 5% branch pays the Necklace of Grace');
    assert.equal(alive(RUPINA), 0, 'Rupina fades after the talk');

    // The reference never closes the quest: after a restart the cond-5 orb
    // holder is still in the loop and may brew again.
    const reopened = await world.reopen(334);
    await world.talk(reopened, MATILD);
    assert.match(world.page(reopened), /promise to me/i);
    await world.event(reopened, 334, 'start', MATILD);
    assert.equal(reopened.questStates.get(334).getInt('cond'), 1, 'the loop reopens from 7738-03');

    await world.close();
    console.log('ok - 334 The Wishing Potion');
}

main().catch((error) => { console.error(error); process.exit(1); });
