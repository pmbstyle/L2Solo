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
        // An errand saved without travel (party or town visit wait) keeps the credit.
        assert.equal(await Credit.settle(3, 5, 124, 700, { bought: false, traveling: false,
            state: withErrands([errand('clan', 124, 3)]) }, 'clan_goal_purchase_refund'), 'kept');
        assert.equal(payments.length, 0, 'a kept errand is not refunded');
        assert.equal(await Credit.settle(3, 5, 124, 700, { bought: false, traveling: true, state: withErrands([]) }, 'x'), 'kept');
        assert.equal(await Credit.settle(3, 5, 124, 700, { bought: true, state: withErrands([]) }, 'x'), 'bought');
        assert.equal(payments.length, 0);

        // Another item's errand, another clan's errand or a lapsed one carry nothing.
        for (const other of [errand('supply', 124, 3), errand('clan', 125, 3), errand('clan', 124, 4),
            errand('clan', 124, 3, now - 31 * 60 * 1000)]) {
            payments.length = 0;
            assert.equal(await Credit.settle(3, 5, 124, 700, { bought: false, state: withErrands([other]) },
                'clan_level_purchase_refund'), 'refunded');
            assert.deepEqual(payments.map(p => [p.clanId, p.characterId, p.amount, p.kind]),
                [[3, 5, -700, 'clan_level_purchase_refund']]);
        }

        // The clan-level site passes bought=false when the purchase has no state.
        payments.length = 0;
        assert.equal(await Credit.settle(3, 5, 124, 700, { bought: true, state: null }, 'r', false), 'refunded');
        assert.equal(payments[0].amount, -700);

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
