'use strict';

// A real player stays online and idle in a quiet town for the whole window: real play always has one
// online, and the server takes some paths only then (party forming budget, the near-player scan).
// The window's --minutes ends it (the step never resolves on its own).
// Run: node scripts/perf.js run --save=<id> --scenario=script --script=tests/e2e/online-player.js --minutes=60 --keep-world

const HUNTERS_VILLAGE = { locX: 117088, locY: 76928, locZ: -2688 };

module.exports = {
    name: 'online-player',
    players: 1,
    // The code only a player online reaches: the near-player scan and party forming's player budget.
    areas: ['GameServer/Bot/Population/PopulationService.js', 'GameServer/Bot/Population/HotActivation.js'],
    needs: { towns: ["Hunter's Village"] },
    place() {
        const { locX, locY, locZ } = HUNTERS_VILLAGE;
        return invoke('GameServer/World/TownRespawn').getClosestTown(locX, locY, locZ) || HUNTERS_VILLAGE;
    },

    async run({ step }) {
        await step('the player stays online', () => new Promise(() => {}));
    }
};
