const fs = require('fs');

const npcs = JSON.parse(fs.readFileSync('./data/Npcs/npcs.json', 'utf-8'));

// Filter all Gatekeepers
const results = npcs.filter(npc => 
    npc.template && 
    npc.template.title === 'Gatekeeper'
);

console.log("=== Gatekeepers in Game ===");
results.forEach(npc => {
    console.log(`ID: ${npc.selfId} | Name: ${npc.template.name} | Title: ${npc.template.title} | Kind: ${npc.template.kind}`);
});
