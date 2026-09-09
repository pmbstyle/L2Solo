const InteractionMemory = require('./InteractionMemory');
const Repository = invoke('GameServer/Social/InteractionMemoryRepository');

// The main-process instance. Cold workers create repository-free instances.
module.exports = new InteractionMemory(Repository);
