🤖 **Bot decisions & hunting grounds**

- Reworked bot decisions around changes in supplies, equipment, market offers, party needs and clan duties. Bots keep pursuing a chosen task while it remains useful, with fewer empty town trips and repeated attempts at unavailable purchases or crafts.
- Bots choose a hunting ground and discover its competition on arrival. Visible strength and personality influence whether they share, retreat or contest the spot; displaced bots remember who drove them away.
- Hunting choices account for dangerous monster groups, available potions and the cost of deaths. Improved recovery when a bot loses its spot, outgrows it or cannot find suitable monsters there.
- New population waves use a configurable class mix with more damage dealers and proportionate healer, buffer and dwarf support. Existing characters keep their classes.

⚔️ **Parties & resurrection**

- Bots evaluate parties by leveling speed, survival, expenses and loot share. Healers can make a party worthwhile, starter supports can join a safe group without suitable solo ground, and parties made entirely of healers are avoided.
- Party formation continues while players are online. Background combat uses members' combined damage and the danger of the whole monster pull; bots with karma can remain with their party while working it off.
- Fixed companions getting stuck on the way to a corpse or waiting indefinitely for another member to resurrect it. Failed approaches can pass the task to another provider, and an accepted resurrection is protected through casting and the stand-up animation.

🏰 **Clans & raid expeditions**

- Added clan raid expeditions with a core party of nine and up to nine additional damage dealers. Each group keeps its own party buffs and healing, while the expedition shares one boss encounter and reward accounting.
- Clan and opportunistic raids assess damage, boss regeneration, minions, healing, defenses and consumable needs together. Improved target selection and paced forecasting help groups find a boss they can defeat.
- Selected raiders can buy missing shots before assembly, with actual stock, travel costs and available money checked before admission. Improved recovery of helpers and clan members whose previous assignment has ended.
- A bot's own clan leader now has priority when inviting it to a party. Bots can leave autonomous, constant or other player parties, interrupt errands and travel to their leader.
- Clan equipment planning counts materials in each beneficiary's personal warehouse before withdrawing from clan storage, including components used by intermediate recipes. Clan warehouse weapons stay available for members whose role can use them.
- Fixed clan crests colliding with images retained in the C4 client's cache. Existing crest identifiers are migrated and new crests receive distinct identifiers.
- Melee couriers on the clan alliance quest continue hunting with basic attacks when mana is low; classes that depend on mana still recover before continuing.

🛠️ **Crafting, trade & shot supply**

- Improved missing shot recipe requests, preservation and learning of purchased recipes, and valuation of public buy orders. Recipe data now loads correctly through different server startup paths.
- Configured D–S grade shot merchants provide a paid fallback alongside public crafters. Raid preparation and ordinary purchases use the same availability and pricing rules.
- Corrected Blessed Spiritshot consumption forecasts and fallback to ordinary Spiritshots when blessed charges run short.
- Bought crafting inputs remain reserved through purchases and town visits. Bots collect banked materials before improvements, preserve useful equipped weapon copies and avoid repeatedly retrying refused crafts or unaffordable shopping steps.
- Purchase plans and buy advertisements survive travel and goal changes while their funding remains valid. Improved seller stock checks, warehouse transfers and trade meeting budgets, including the seller's gatekeeper fare.

🧭 **Movement, visibility & loot**

- Movement now supports C4-style steps down ledges while keeping idle monsters from wandering into places they cannot walk back from. Monster sight over trees and low walls is handled separately from walkable routes.
- Improved routes through town corridors, walled yards and gatekeepers. NPC approach points stay on the NPC's floor, unreachable town trips stop repeating, and the Talking Island magic shop transition waits for the client's floor report.
- Drops land on reachable ground, pickup runs stop at obstacles, and bots can collect a kill's loot as their attack finishes.
- Fixed walking speed under movement buffs and client updates when switching between walking and running. Effect changes refresh the affected character's own information correctly.
- Bots appear sooner after login or teleport, with hunters placed near their monsters and travelers shown on their roads. Ongoing trips and tasks survive transitions between visible and background simulation.
- Town peace zones follow C4 outlines, including Floran, where AFK shops can open.

🔧 **Stability & diagnostics**

- Fixed a server crash when poison continued after its caster left the world. The remaining effect stops at 1 HP without awarding a kill to a departed caster.
- Reduced repeated decision work and improved background scheduling while a player is online. Party, trade and clan task handoffs retain their progress when concurrent updates need a retry.
- Added an optional decision trace for server troubleshooting, covering bot choices, deaths, raids and task lifecycles with 48-hour retention. Enable `BotPopulation.decisionTrace` in `config/local.ini` and inspect it with `scripts/trace.js`.
