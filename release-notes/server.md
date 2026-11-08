🌊 **Garden of Eva**

- Added all 24 timed C4 water walls. They start closed and alternate between seven minutes closed and seven minutes open.
- Wall states are visible in the client and respected by movement and pathfinding, including when entering the area or logging in nearby.

🤖 **Bot travel & starter progression**

- Fixed bots getting stuck while shopping in towns such as Gludio or trying to leave town afterward. Interrupted shopping and hunting trips now recover their navigation more reliably.
- Starter bots such as Orc Mystics now recognize when their equipment cannot support safe solo hunting and can form a safe melee party instead of waiting indefinitely.

🛠️ **Trade & economy**

- Fixed player-to-bot Adena payments being limited to 10,000. Trades now accept the client's normal Adena range, including larger purchases and buff payments.
- Permanent resource buyers now purchase raw materials only. Crafted materials need actual buyer demand, removing guaranteed buyback that was drawing crafters away from shot production.

🛡️ **Clan progression**

- Clan tasks now take turns more fairly, so one busy clan cannot monopolize progression work.
- Removed duplicate background review chains from saved queues in player-managed clans while preserving player orders.
- Fixed stalled equipment-gathering parties. When a party cannot assemble, bots are released from the wait and the clan can reconsider its plan.

💾 **Backups & update recovery**

- Fixed Windows world backups failing with a file-lock error while copying the world and history databases.
- Improved recovery after a failed server update and startup with copied or moved world databases.
