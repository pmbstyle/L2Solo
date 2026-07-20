function gatekeeper(selfId, name) {
    return {
        selfId,
        template: { kind: 'Teleporter', name, title: 'Gatekeeper', level: 70, hostile: false },
        base: { str: 40, dex: 30, con: 43, int: 21, wit: 20, men: 10 },
        stats: { pAtk: 688.863725587608, pAtkRnd: 30, pDef: 295.91597408024, mAtk: 470.404627426724, mDef: 216.538467292763, accur: 4.75, atkSpd: 253, castSpd: 333, atkRadius: 40 },
        speed: { walk: 80, run: 120 },
        vitals: { maxHp: 2444.46818899627, maxMp: 1345.8, revHp: 7.5, revMp: 2.7, corpseTime: 7000 },
        collision: { radius: 8, size: 25 },
        equipment: { weapon: 0, shield: 0, reuseTime: 0 },
        clan: { clanName: '', helpRadius: 300 },
        rewards: { exp: 0.1, sp: 10 }
    };
}

const npcs = [gatekeeper(8275, 'Tatiana'), gatekeeper(8320, 'Ilyana')];
const spawns = [{
    selfId: 'c4_late_town_gatekeepers',
    bounds: [{ locX: 43700, locY: -55300, minZ: -2800, maxZ: -700 }],
    spawns: [
        { selfId: 8275, name: 'Tatiana', coords: [{ locX: 147966, locY: -55228, locZ: -2728, head: 48000 }], total: 1, respawn: 60, bias: 0 },
        { selfId: 8320, name: 'Ilyana', coords: [{ locX: 43824, locY: -47664, locZ: -792, head: 50000 }], total: 1, respawn: 60, bias: 0 }
    ]
}];

module.exports = { npcs, spawns };
