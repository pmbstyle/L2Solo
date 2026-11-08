'use strict';

// A player finds a background party at its spot and stays within view of it: the party turns hot
// (HotPartyLifecycle.activate, near_player), its members are bodies near the player, and what they
// raise there (a death, a full bag, a new grade, their need of the party ended) rides their bags
// to the worker. A member's stay is its party step's decision (ColdSimulationKernel.partyStay), which
// a hot party does not run: the raises wait on the members' rows, and the party's first cold step
// after the player leaves takes them. So the player stays STAY_MS (or until the party breaks up),
// goes back to town, waits for the party to cool and finds the next one. The window's --minutes ends it.
// Run: node scripts/perf.js run --save=<id> --scenario=script --script=tests/e2e/party-watcher.js --minutes=45 --keep-world

const HUNTERS_VILLAGE = { locX: 117088, locY: 76928, locZ: -2688 };
// Where the player stands from the party's leader: inside the view and activation radius, off its pull.
const BESIDE = 1500;
// The leader farther than this from the player: the player goes back beside it.
const LOST = 3000;
// How long the player watches one party.
const STAY_MS = 10 * 60000;

module.exports = {
    name: 'party-watcher',
    players: 1,
    areas: ['GameServer/Bot/Population/HotPartyLifecycle.js', 'GameServer/Bot/Population/BackgroundPartyState.js',
        'GameServer/Bot/Population/ColdSimulationKernel.js', 'GameServer/Bot/Population/PartyStay.js',
        'GameServer/Bot/AI/DecisionEvents.js', 'GameServer/Actor/Generics/TeleportTo.js'],
    needs: { towns: ["Hunter's Village"] },
    place() {
        const { locX, locY, locZ } = HUNTERS_VILLAGE;
        return invoke('GameServer/World/TownRespawn').getClosestTown(locX, locY, locZ) || HUNTERS_VILLAGE;
    },

    async run({ player, step, within, setup }) {
        const Parties = invoke('GameServer/Bot/Population/BackgroundPartyState');
        const Life = invoke('GameServer/Bot/Population/BotLifeState');
        const World = invoke('GameServer/World/World');
        // A member's place: its body's while it is near, else its row's.
        const locOf = id => {
            const actor = World.registeredActorById?.(Number(id));
            return actor?.fetchLocX ? { locX: actor.fetchLocX(), locY: actor.fetchLocY(), locZ: actor.fetchLocZ() } : Life.cachedState(Number(id))?.loc;
        };
        const away = (a, b) => Math.hypot(a.locX - b.locX, a.locY - b.locY);
        const beside = loc => ({ locX: loc.locX + BESIDE, locY: loc.locY, locZ: loc.locZ });
        const hot = party => party?.status === 'hot' || (party?.memberIds || []).length > 0
            && party.memberIds.every(id => Life.cachedState(Number(id))?.phase === 'hot');
        for (let watched = 1; ; watched++) {
            const party = await step(`an active background party at its spot (${watched})`, () => within(20 * 60000,
                () => Parties.active().find(row => row.spotId != null && (row.memberIds || []).length >= 2 && locOf(row.leaderId)) || null,
                { everyMs: 5000, what: 'an active background party of 2+ at a spot' }));
            await step(`the player goes beside it (${watched})`, async () => {
                const target = beside(locOf(party.leaderId));
                if (setup.teleport(player, target) === false) throw new Error('teleport refused');
                await within(10000, () => away(player.loc(), target) < 500, { what: 'the player beside the party' });
            });
            await step(`its members turn hot near the player (${watched})`, () => within(90000, () => hot(Parties.find(party.partyId)),
                { everyMs: 1000, what: `party ${party.partyId} hot` }));
            // Within view while it is hot: its members' situations are a body's, their stays wait.
            await step(`the player stays with it while it is near (${watched})`, async () => {
                for (const end = Date.now() + STAY_MS; Date.now() < end;) {
                    await new Promise(resolve => setTimeout(resolve, 15000));
                    const now = Parties.find(party.partyId);
                    if (!hot(now)) return;
                    const leader = locOf(now.leaderId);
                    if (leader && away(player.loc(), leader) > LOST) setup.teleport(player, beside(leader));
                }
            });
            // Its first cold step takes the stays its members' raises woke while near.
            await step(`the player leaves and the party cools (${watched})`, async () => {
                // The town farthest from the party: past the cooldown radius.
                const from = locOf(party.leaderId) || player.loc();
                const town = Object.values(invoke('GameServer/World/TownRespawn').towns)
                    .reduce((best, row) => !best || away(row, from) > away(best, from) ? row : best, null);
                if (setup.teleport(player, town) === false) throw new Error('teleport refused');
                await within(300000, () => !hot(Parties.find(party.partyId)), { everyMs: 5000, what: `party ${party.partyId} cold again` });
            });
        }
    }
};
