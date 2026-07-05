const assert = require('assert');

require('../src/Global');

const World = invoke('GameServer/World/World');
const SocialAggro = invoke('GameServer/Npc/SocialAggro');

function state({ dead = false, combat = false } = {}) {
    return {
        fetchDead: () => dead,
        fetchCombats: () => combat
    };
}

function npc(id, options = {}) {
    const model = {
        id,
        clanName: options.clanName ?? 'Goblin',
        helpRadius: options.helpRadius ?? 300,
        attackable: options.attackable ?? true,
        dead: options.dead ?? false,
        locX: options.locX ?? 0,
        locY: options.locY ?? 0,
        locZ: 0,
        state: state({ dead: options.stateDead, combat: options.combat }),
        assists: []
    };

    return {
        state: model.state,
        fetchId: () => model.id,
        fetchClanName: () => model.clanName,
        fetchClanHelpRadius: () => model.helpRadius,
        fetchAttackable: () => model.attackable,
        isDead: () => model.dead,
        fetchLocX: () => model.locX,
        fetchLocY: () => model.locY,
        fetchLocZ: () => model.locZ,
        fetchDestId: () => model.destId,
        enterCombatState(session, attacker) {
            model.destId = attacker.fetchId();
            model.assists.push({ session, attackerId: attacker.fetchId() });
        },
        assists: model.assists
    };
}

function attacker() {
    return {
        state: state(),
        fetchId: () => 2000001,
        fetchLocX: () => 10,
        fetchLocY: () => 0,
        fetchLocZ: () => 0
    };
}

const originalFetchNpcsInRadius = World.fetchNpcsInRadius;

try {
    const attacked = npc(1001, { clanName: 'Goblin', helpRadius: 300 });
    const helper = npc(1002, { clanName: 'Goblin', locX: 250 });
    const otherClan = npc(1003, { clanName: 'Demonic', locX: 150 });
    const farHelper = npc(1004, { clanName: 'Goblin', locX: 301 });
    const busyHelper = npc(1005, { clanName: 'Goblin', locX: 100, combat: true });

    World.fetchNpcsInRadius = (x, y, radius) => {
        assert.strictEqual(x, attacked.fetchLocX(), 'social aggro lookup should start from the attacked NPC');
        assert.strictEqual(y, attacked.fetchLocY(), 'social aggro lookup should start from the attacked NPC');
        assert.strictEqual(radius, attacked.fetchClanHelpRadius(), 'social aggro lookup should use attacked NPC help radius');
        return [attacked, helper, otherClan, farHelper, busyHelper];
    };

    const helpers = SocialAggro.notifyClan({ name: 'player session' }, attacked, attacker());
    assert.deepStrictEqual(helpers.map((candidate) => candidate.fetchId()), [helper.fetchId()]);
    assert.strictEqual(helper.assists.length, 1, 'same-clan idle helper inside radius should assist');
    assert.strictEqual(helper.assists[0].attackerId, 2000001, 'helper should attack the same attacker');
    assert.strictEqual(otherClan.assists.length, 0, 'different clan should not assist');
    assert.strictEqual(farHelper.assists.length, 0, 'same clan outside help radius should not assist');
    assert.strictEqual(busyHelper.assists.length, 0, 'helper already in combat should not be retargeted');

    const blankClan = npc(1006, { clanName: '', helpRadius: 300 });
    const blankHelper = npc(1007, { clanName: '', locX: 100 });
    World.fetchNpcsInRadius = () => [blankClan, blankHelper];
    assert.deepStrictEqual(SocialAggro.notifyClan({}, blankClan, attacker()), [], 'blank clan should not make all nameless mobs social');
    assert.strictEqual(blankHelper.assists.length, 0, 'blank-clan helper should stay passive');
} finally {
    World.fetchNpcsInRadius = originalFetchNpcsInRadius;
}

console.log('NPC social aggro checks passed');
