require('../src/Global');
const assert=require('node:assert/strict');
const DataCache=invoke('GameServer/DataCache');
const Spawn=invoke('GameServer/World/Generics/SpawnNpcs');
DataCache.init();
const source=DataCache.npcSpawns;
try {
    const duelIds=[5102,5103,5104,5105,5106,5107];
    assert(duelIds.every(id=>source.some(g=>g.spawns.some(s=>s.selfId===id))), 'C4 imported shared duel spawns exist');
    DataCache.npcSpawns=[{bounds:[],spawns:[...duelIds,7106].map(selfId=>({selfId,total:1,respawn:0,bias:0,
        coords:[{locX:100,locY:200,locZ:-300,head:0}]}))}];
    const world={npc:{nextId:8000000,spawns:[],periodMode:'day'},user:{sessions:[]}};
    Spawn.call(world);
    assert.deepEqual(world.npc.spawns.map(n=>n.fetchSelfId()),[7106], 'personal duels suppress only their six legacy shared opponents');
    console.log('Summoner quest: legacy shared duel spawns suppressed and ordinary world NPC preserved');
}finally {DataCache.npcSpawns=source;}
