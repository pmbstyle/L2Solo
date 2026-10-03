const assert = require('node:assert/strict');
require('../src/Global');

const Automation = invoke('GameServer/Automation');
const State = invoke('GameServer/Model/State');
const Timer = invoke('GameServer/Timer');
const World = invoke('GameServer/World/World');
const Generics = invoke(path.actor);
const Manager = invoke('GameServer/Bot/BotManager');
const AfkTrade = invoke('GameServer/AfkTrade/AfkTradeService');
const Party = invoke('GameServer/Bot/AI/PartyCompanionService');
const Geo = invoke('GameServer/Geodata/GeodataEngine');
const Select = invoke('GameServer/Actor/Generics/Select');
const Validate = invoke('GameServer/Network/Request/ValidatePosition');
const Update = invoke('GameServer/Actor/Generics/UpdatePosition');

(async () => {
    const saved = { now: Date.now, timeout: global.setTimeout, clearTimeout: global.clearTimeout,
        start: Timer.start, clear: Timer.clear, npc: World.fetchNpc, talk: World.npcTalk,
        sessions: Manager.sessions, projection: AfkTrade.findProjection, hasGeo: Geo.hasGeo,
        environment: Generics.updateEnvironment, underwater: Generics.underwaterCheck, party: Party.updatePosition };
    let now = 10000;
    try {
        Date.now = () => now;
        global.setTimeout = (callback, ms) => ({ callback, ms });
        global.clearTimeout = () => {};
        Timer.start = (handler, callback, ms) => { handler.timer = { callback, due: now + ms }; };
        Timer.clear = handler => { delete handler.timer; };
        Manager.sessions = [];
        AfkTrade.findProjection = () => null;
        Geo.hasGeo = () => true;
        Generics.updateEnvironment = Generics.underwaterCheck = Party.updatePosition = () => {};

        function encounter(targetZ, attackable = true, accountId = 'player_height') {
            let actions = 0;
            const target = { z: targetZ, fetchId: () => 1000001, fetchLevel: () => 40,
                fetchLocX: () => 500, fetchLocY: () => 0, fetchLocZ() { return this.z; },
                setLocZ(z) { this.z = z; }, fetchRadius: () => 9, fetchAttackable: () => attackable };
            const actor = { x: 0, y: 0, z: -4000, hp: 1000, destId: null,
                effects: {}, state: new State(), automation: new Automation(),
                fetchId: () => 2000001, fetchLevel: () => 40,
                fetchLocX() { return this.x; }, fetchLocY() { return this.y; }, fetchLocZ() { return this.z; },
                fetchDestId() { return this.destId; }, setDestId(id) { this.destId = id; },
                fetchHead: () => 0, fetchRadius: () => 9, fetchCollectiveRunSpd: () => 120,
                isDead: () => false, isBlocked: () => false, statusUpdateVitals() {},
                fetchHp() { return this.hp; }, fetchMaxHp: () => 1000, setHp(hp) { this.hp = hp; },
                setLocXYZ(c) { this.x = c.locX; this.y = c.locY; this.z = c.locZ; },
                setLocXYZH(c) { this.setLocXYZ(c); },
                backpack: { fetchTotalWeaponKind: () => 'Weapon.Blunt' },
                attack: { meleeHit() { actions++; } }, updatePosition(c) { Update(session, this, c); } };
            const session = { actor, accountId, persistenceMode: 'ephemeral', dataSendToMe() {}, dataSendToMeAndOthers() {} };
            actor.session = session;
            World.fetchNpc = async () => target;
            World.npcTalk = () => { actions++; };
            return { actor, session, target, actions: () => actions };
        }

        function report(e, z, x = e.actor.x, y = e.actor.y) {
            const packet = Buffer.alloc(21);
            [x, y, z, 0, 0].forEach((value, index) => packet.writeInt32LE(value, 1 + index * 4));
            return Validate(e.session, packet);
        }

        async function approach(e) {
            Select(e.session, e.actor, { id: e.target.fetchId() });
            await new Promise(setImmediate);
            Select(e.session, e.actor, { id: e.target.fetchId() });
            await new Promise(setImmediate);
            assert(e.actor.automation.timer.action.timer, 'Second click must schedule the approach');
        }

        function arrive(e) {
            const timer = e.actor.automation.timer.action.timer;
            now = timer.due;
            timer.callback();
        }

        // A delayed/final C4 report still describes the player's floor even
        // when the target's spawn belongs to another layer. Cover talk too.
        for (const targetZ of [-3400, -4600]) {
            for (const attackable of [true, false]) {
                const e = encounter(targetZ, attackable);
                await approach(e);
                assert.equal(e.target.z, targetZ);
                arrive(e);
                assert.equal(e.actions(), 1, 'Fallback must still complete the attack or NPC talk');
                assert(e.actor.x > 400, 'Fallback must still complete the horizontal approach');
                assert.equal(e.actor.z, -4000, 'Player arrival must preserve the accepted floor instead of the NPC height');
                assert.equal(report(e, -4000), true);
                assert.equal(e.actor.hp, 1000, 'Approaching a target must not manufacture fall damage');
                assert.equal(e.actor.fallingUntil, undefined, 'A correction must not block later position reports');
            }
        }

        // A real slope report must remain authoritative, even if it arrives
        // after the fallback point was computed and before the attack deadline.
        const slope = encounter(-3400);
        await approach(slope);
        now += 100;
        assert.equal(report(slope, -3880, 200), true);
        arrive(slope);
        assert.equal(slope.actor.z, -3880, 'Fallback must preserve the latest accepted height');
        assert.equal(report(slope, -3880), true);
        assert.equal(slope.actor.hp, 1000);

        // Non-weapon actions use the same arrival callback without the
        // playerAttackApproach object (for example, an out-of-range spell).
        const spell = encounter(-3400);
        spell.actor.automation.scheduleAction(spell.session, spell.actor, spell.target, 100, () => {});
        arrive(spell);
        assert.equal(spell.actor.z, -4000, 'Spell arrival must not borrow the target height');
        assert.equal(report(spell, -4000), true);
        assert.equal(spell.actor.hp, 1000);

        // pmb / Monster Eye Gazer: the live spawn is 565 units above
        // the player's floor. Walking distance and melee range are planar;
        // the unrelated spawn Z must not add seconds to the first attack.
        const gazer = encounter(-2996);
        gazer.actor.setLocXYZ({ locX: 42141, locY: 132330, locZ: -3561 });
        gazer.actor.fetchCollectiveRunSpd = () => 135;
        gazer.target.fetchLocX = () => 42016.727625727915;
        gazer.target.fetchLocY = () => 132275.09420545356;
        gazer.target.fetchRadius = () => 21;
        await approach(gazer);
        const gazeArrival = gazer.actor.automation.timer.action.timer;
        assert(gazeArrival.due - now < 750, 'Spawn height must not turn a short approach into a four-second wait');
        const gazeStop = gazer.actor.automation.playerAttackApproach.stopCoords;
        const gazeGap = Math.hypot(gazeStop.locX - gazer.target.fetchLocX(), gazeStop.locY - gazer.target.fetchLocY());
        assert(Math.abs(gazeGap - 60) < 1, 'Player approach must stop at the horizontal collision margin');
        now += 16;
        assert.equal(report(gazer, -3561, 42100), true);
        assert(gazer.actor.automation.timer.action.timer.due < gazeArrival.due,
            'Accepted progress must shorten the horizontal deadline even when the spawn Z differs');
        arrive(gazer);
        assert.equal(gazer.actions(), 1);
        assert.equal(gazer.actor.z, -3561);
        assert.equal(report(gazer, -3561), true);
        assert.equal(gazer.actor.hp, 1000);

        // Recorded click: the old timer lasted 7.77 seconds and ignored
        // accepted progress, while C4 reached melee range in about two.
        const delayed = encounter(-2468);
        delayed.actor.setLocXYZ({ locX: 41834, locY: 132900, locZ: -3516 });
        delayed.actor.fetchCollectiveRunSpd = () => 135;
        delayed.target.fetchLocX = () => 41967.11116708096;
        delayed.target.fetchLocY = () => 133191.15722183837;
        delayed.target.fetchRadius = () => 21;
        await approach(delayed);
        const delayedArrival = delayed.actor.automation.timer.action.timer;
        assert(delayedArrival.due - now < 2100, 'The recorded approach must finish after walking, not after a synthetic climb');
        now += 1730;
        assert.equal(report(delayed, -3472, 41924, 133096), true);
        arrive(delayed);
        assert.equal(delayed.actions(), 1);
        assert.equal(delayed.actor.z, -3472);
        assert.equal(delayed.actor.hp, 1000);

        const near = encounter(-2468);
        near.actor.setLocXYZ({ locX: 41942, locY: 133136, locZ: -3459 });
        near.target.fetchLocX = () => 41967.11116708096;
        near.target.fetchLocY = () => 133191.15722183837;
        near.target.fetchRadius = () => 21;
        Select(near.session, near.actor, { id: near.target.fetchId() });
        await new Promise(setImmediate);
        Select(near.session, near.actor, { id: near.target.fetchId() });
        await new Promise(setImmediate);
        assert.equal(near.actions(), 1, 'An already reachable target must be attacked immediately despite its spawn Z');
        assert.equal(near.actor.automation.timer.action.timer, undefined, 'A nearby attack needs no arrival timer');
        assert.equal(near.actor.z, -3459);

        const fall = encounter(-3400);
        await approach(fall);
        assert.equal(report(fall, -4500, 200), true);
        assert.equal(fall.actor.hp, 500, 'A real 500-unit client fall must still deal damage');
        arrive(fall);
        assert.equal(fall.actor.z, -4500, 'Fallback must not undo an accepted landing');
        assert.equal(report(fall, -4500), false, 'Existing fall cooldown must remain active');
        assert.equal(fall.actor.hp, 500);

        const bot = encounter(-3400, true, 'bot_height');
        bot.actor.automation.scheduleAction(bot.session, bot.actor, bot.target, 40, () => {});
        const botDestination = bot.actor.automation.actionStopCoords(bot.actor, bot.target, 40);
        arrive(bot);
        assert.deepEqual({ locX: bot.actor.x, locY: bot.actor.y, locZ: bot.actor.z }, botDestination,
            'Server-driven bot arrival must retain its target height');
    } finally {
        Date.now = saved.now; global.setTimeout = saved.timeout; global.clearTimeout = saved.clearTimeout;
        Timer.start = saved.start; Timer.clear = saved.clear; World.fetchNpc = saved.npc; World.npcTalk = saved.talk;
        Manager.sessions = saved.sessions; AfkTrade.findProjection = saved.projection; Geo.hasGeo = saved.hasGeo;
        Generics.updateEnvironment = saved.environment; Generics.underwaterCheck = saved.underwater; Party.updatePosition = saved.party;
    }
    console.log('Player approach height, fall damage and bot arrival checks passed');
})().catch(error => { console.error(error); process.exitCode = 1; });
