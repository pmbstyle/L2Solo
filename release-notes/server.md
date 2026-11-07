⚔️ **Combat & C4 rules**

- Base HP, MP and CP now follow C4 values for each class and level.
- Fixed PvP flags, karma and kill credit, including attacks by pets and summons. CP absorbs PvP damage before HP.
- Corrected PK death drops. Characters with karma and at least 5 PKs are eligible; the initial drop roll is now 70% by default, followed by separate item rolls.
- Resurrection and returning to town after death now restore 70% HP. MP and CP keep their remaining values instead of being refilled.
- Hostile skills such as Hex and Power Break now show success or resistance feedback and provoke monster retaliation. Stun, sleep and other control effects no longer make monsters forget their target and aggression.
- Fixed poison success chances, magic skill classifications and missing Over-hit bonuses on eligible skills. Wind Shackle now has a 1.5-second cast and an 8-second reuse.
- Resurrection on a living target and undead-only skills on an invalid target are rejected before movement, MP use or cooldown.

🤖 **Bots & hunting**

- Bots choose hunting grounds using their class, equipment, supplies and survival chances, and keep a suitable spot instead of constantly reconsidering the same plan.
- Bots away from players use the same combat rules as nearby bots, including skill costs, shots, potions, healing and summons. Their EXP comes from fights, with no extra progression scaling based on the player's level.
- Summoners heal their pets during and between fights. Bots recover enough HP and MP before continuing, fixing repeated stand-up/sit-down loops and premature returns to combat.
- Travel time now accounts for distance, Scroll of Escape casts and gatekeeper hops for bots away from players too. Fixed interrupted shopping trips, trade arrivals and returns to party hunting.

🛠️ **Trade & crafting**

- Crafters consider demand from several buyers together when choosing what to produce, including higher-grade equipment and shots.
- Bots keep equipment reserved for upgrades and materials needed for planned crafts when selling or unloading their inventory. Crafting can use materials stored in the warehouse.
- Fixed repeated Luxury Shop exchanges and purchases of dual-sword components that had already been obtained. NPC purchases use the prices in the destination town.
- Overweight party companions can unload items at a warehouse and sell surplus arrows. Trades and party loot distribution respect inventory space and weight limits.

🔧 **Fixes & stability**

- Updated monster drop and spoil tables to C4 data. Spoil rates now increase each item's chance first; only chances above 100% produce extra quantities.
- Weapons, armor and other non-stackable rewards are created as separate items. Existing equipment stacks in inventories and personal warehouses are repaired while preserving enchant levels.
- Spoil can be applied to monsters without a regular spoil list, fixing quest steps such as Path of the Scavenger and Trial of the Guildsman.
- Monsters give up a chase after two minutes without an attack and walk back home after combat. Attacks already in progress can still land when the target steps out of melee range.
- Fixed stalled bot clan progression, duplicate contributions and clan tasks blocking one another.
- Party finder, name lookup and World Observer can find bots beyond the previous 2,000-bot limit. Logging in no longer refills a character's starter shots.
- Reduced CPU work, memory use and unnecessary database writes. Improved recovery after restarts and pathfinding failures, and cleanup during long-running sessions.
