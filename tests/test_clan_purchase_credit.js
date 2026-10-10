'use strict';
// E193/E194: the clan's credit (clanPart) travels with a pending clan errand
// and returns to the clan when the purchase fails at once or the errand ends
// without spending it. One rule for the equipment and clan-level purchases.
const assert = require('node:assert/strict');
delete process.env.L2NODE_SHARED_CONFIG_FILE;
process.env.L2NODE_CONFIG_FILE = 'config/default.ini';
require('../src/Global');
const Database = invoke('Database');
const LifeState = invoke('GameServer/Bot/Population/BotLifeState');
const Credit = invoke('GameServer/Clan/ClanPurchaseCredit');

const payments = [];
const originals = { pay: Database.payClanMember, accept: LifeState.acceptNewerLifecycleRow, find: LifeState.findByCharacterId };
Database.payClanMember = async payment => { payments.push(payment); return { ok: true, row: { characterId: payment.characterId } }; };
LifeState.acceptNewerLifecycleRow = row => ({ characterId: row.characterId, refreshed: true });
LifeState.findByCharacterId = async id => ({ characterId: id });

const now = Date.now();
const errand = (purpose, selfId, clanId, at = now) => ({ selfId, amount: 1, town: 'Giran', purpose, at,
    tag: purpose === 'clan' ? { clanId, clanPart: 700 } : null });
const withErrands = errands => ({ characterId: 5, stats: { marketErrands: errands, marketErrand: errands[0] || null } });

(async () => {
    try {
        const settle = async (...args) => (await Credit.settle(...args)).code;
        // The errand this acquire left (on its way or waiting for its party
        // or town visit) keeps the credit; so does a pending meeting.
        assert.equal(await settle(3, 5, 700, { bought: false, traveling: false, errandAt: now,
            state: withErrands([errand('clan', 124, 3)]) }, 'clan_goal_purchase_refund'), 'kept');
        assert.equal(await settle(3, 5, 700, { bought: false, traveling: true, state: withErrands([]) }, 'x'), 'kept');
        assert.equal(await settle(3, 5, 700, { bought: false, pending: true, state: withErrands([]) }, 'x'), 'kept');
        assert.equal(payments.length, 0, 'a kept credit is not refunded');

        // Bought at once: the credit it did not spend goes back; the caller gets the refunded row.
        assert.equal(await settle(3, 5, 700, { bought: true, spent: 700, state: withErrands([]) }, 'x'), 'bought');
        assert.equal(payments.length, 0, 'a fully spent credit');
        const cheaper = await Credit.settle(3, 5, 700, { bought: true, spent: 200, state: withErrands([]) }, 'clan_goal_purchase_refund');
        assert.equal(cheaper.code, 'bought');
        assert.equal(cheaper.state.refreshed, true);
        assert.deepEqual(payments.map(p => [p.clanId, p.characterId, p.amount, p.kind]), [[3, 5, -500, 'clan_goal_purchase_refund']]);
        payments.length = 0;
        assert.equal(await settle(3, 5, 700, { bought: true, spent: 200, pending: true, state: withErrands([]) }, 'x'), 'bought');
        assert.equal(payments.length, 0, 'a pending meeting may still spend the rest');

        // An errand this acquire did not leave (an older one of the same clan
        // and item, another item, a lapsed one) does not keep the new credit.
        for (const other of [errand('clan', 124, 3), errand('supply', 124, 3), errand('clan', 125, 3),
            errand('clan', 124, 3, now - 31 * 60 * 1000)]) {
            payments.length = 0;
            assert.equal(await settle(3, 5, 700, { bought: false, state: withErrands([other]) },
                'clan_level_purchase_refund'), 'refunded');
            assert.deepEqual(payments.map(p => [p.clanId, p.characterId, p.amount, p.kind]),
                [[3, 5, -700, 'clan_level_purchase_refund']]);
        }

        // The clan-level site passes bought=false when the purchase has no state.
        payments.length = 0;
        assert.equal(await settle(3, 5, 700, { bought: true, state: null }, 'r', false), 'refunded');
        assert.equal(payments[0].amount, -700);

        // A refund the member cannot pay is reported, not dropped.
        Database.payClanMember = async () => ({ ok: false, code: 'member_funds_short' });
        assert.equal(await settle(3, 5, 700, { bought: false, state: null }, 'r'), 'refund_member_funds_short');
        assert.equal(await settle(3, 5, 700, { bought: true, spent: 100, state: null }, 'r'), 'bought_refund_member_funds_short');
        Database.payClanMember = async payment => { payments.push(payment); return { ok: true, row: { characterId: payment.characterId } }; };

        // One clan errand at a time: both clan guards see every pending errand, not only the first.
        const queued = withErrands([errand('supply', 1835, 0), errand('clan', 124, 3)]);
        assert.equal(Credit.hasClanErrand(queued, 3), true, 'a clan errand behind a supply errand');
        assert.equal(Credit.hasClanErrand(queued, 3, 124), true);
        assert.equal(Credit.hasClanErrand(queued, 3, 125), false);
        assert.equal(Credit.hasClanErrand(queued, 4), false);

        // The credit a member carries for its pending clan errands is not its own money.
        const Funding = invoke('GameServer/Bot/Economy/PurchaseFunding');
        const carrier = errands => ({ ...withErrands(errands), adena: 1000, stats: { ...withErrands(errands).stats, money: [1, 1e-5, 0, 0] } });
        assert.equal(Funding.clanCredit(carrier([errand('supply', 1835, 0), errand('clan', 124, 3)])), 700);
        assert.equal(Funding.spendable(carrier([errand('clan', 124, 3)]), 0, { upperBound: true }), 300,
            'a shot restock cannot spend the clan credit while the errand waits');
        assert.equal(Funding.spendable(carrier([errand('clan', 124, 3)]), 0,
            { upperBound: true, ownClanErrand: { clanId: 3, selfId: 124 } }), 1000, 'the errand\'s own purchase uses it');
        assert.equal(Funding.spendable(carrier([errand('clan', 124, 3, now - 31 * 60 * 1000)]), 0, { upperBound: true }), 1000,
            'a lapsed errand holds nothing (E194 row)');
        assert.equal(Funding.spendable(carrier([]), 0, { upperBound: true }), 1000);

        // An errand that ends on arrival returns what it did not spend.
        payments.length = 0;
        const ended = await Credit.returnUnspent(5, errand('clan', 124, 3), 0);
        assert.equal(ended.state.refreshed, true, 'the caller gets the refunded wallet');
        assert.deepEqual(payments.map(p => [p.clanId, p.amount, p.kind]), [[3, -700, 'clan_errand_refund']]);
        payments.length = 0;
        await Credit.returnUnspent(5, errand('clan', 124, 3), 200);
        assert.equal(payments[0].amount, -500, 'a cheaper fill returns the rest of the credit');
        payments.length = 0;
        assert.equal(await Credit.returnUnspent(5, errand('clan', 124, 3), 900), null, 'a fully spent credit');
        assert.equal(await Credit.returnUnspent(5, errand('supply', 124, 3), 0), null, 'not a clan errand');
        assert.equal(payments.length, 0);

        // Funding: only the part above the member's free money is credited.
        const funded = await Credit.fund(3, { characterId: 5, adena: 0, stats: { money: [1, 1e-5, 0, 0] } }, 999.2, 'clan_goal_purchase');
        assert.equal(funded.clanPart, 1000);
        assert.equal(payments[0].amount, 1000);
        console.log('Clan purchase credit kept, refunded and returned: PASS');
    } finally {
        Database.payClanMember = originals.pay;
        LifeState.acceptNewerLifecycleRow = originals.accept;
        LifeState.findByCharacterId = originals.find;
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
