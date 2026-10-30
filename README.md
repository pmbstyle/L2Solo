<a href="https://l2solo.com">
<img alt="Lineage2 Solo local server" src="https://github.com/user-attachments/assets/a75ad34c-6371-46f5-8f78-0447ccc333a3" />
</a>


# L2Solo (C4: Scions of Destiny)

Old-school Lineage 2 solo play, locally in a live world with over 1700 bot population.

L2Solo is a local-first Lineage II C4 server emulator, tuned for a solo MMO experiment: one real player, a live world, and bots with AI that makes the server feel alive.
Nothing is auto-generated. Everything in the world is the result of a player's or a bot's actions.

**Project status:** PUBLIC ALPHA

🏗️ Work in progress. Playable.


💬 [Discord](https://discord.gg/dXsQ8SJA7k)
Support, updates, and communication. Join the Discord to stay up to date with development.

⚔️ [Game client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing)
Clean C4 client protocol 656

🧩 [L2Solo client mod](https://drive.google.com/file/d/16snZK_8KQOzGfgEO6hmAoXOtkL4iMhM8/view?usp=sharing)
Optional but recommended for a better experience


💻 Simulation - everything that is happening in the game world besides player actions.

🧊 Cold bots - bots in the background, everywhere on the server where the player cannot see. Works like a less detailed simulation but keeps base bot abilities, stats, and goals, including cold bot parties, clans, etc. Bots become cold when goes out of the player's view range. Can communicate, including with the player (optional LLM integration). Uses much less compute.

🔥 Hot bots - bots that the player can see, or within maximum client view range. Any cold bot can become hot if the player is nearby. Highest detail level, uses much more compute for realistic movement, actions, etc.

🌳 Static bots - static traders in towns and crafting stations in Giran. Needed only for a specific function, no brain, no communication or goals.


## Latest updates
- **2026-10-30** Clan wars, geodata, bug fixes
- **2026-10-26** Server stability, better AI, spoil, hunting, bug fixes
- **2026-10-18** A living world economy, market board, better bot progression
- **2026-10-03** Bot and performance fixes, player-led raids, better observer, quests and more
- **2026-09-29** Market, recipes, bot shoulshots craft, paid buffs, fixes and improvements
- **2026-09-26** Bot raid boss farm, player bot party join, SA, fixes and updates
- **2026-09-22** Bot progression, clan party, craft, trading fixes; realistic bot and clan names
- **2026-09-21** L2Solo client mod, server-side mod support, in-game items db
- **2026-09-20** Clan halls, clan craft goals, clan WH resources collection, fixes and improvements
- **2026-09-17** Death exp penalties, overhit bonus, max level setting, bot lucky protection
- **2026-09-17** Gameplay fixes, clan progression, skills, and town services
- **2026-09-14** Better class-specific bot gameplay, fixes, and improvements
- **2026-09-12** Bot persistent social memory and hot/cold PvP
- **2026-09-08** Pets, striders, clan lvl 4, fixes and updates
- **2026-09-06** Bot PvP, save game, save TP location, optimization, chat, navigation
- **2026-09-04** Player clan warehouse use for equipment exchange, bug fixes
- **2026-09-02** AFK trade, market observer, xN mob fix
- **2026-08-31** Expand bot world simulation, arena duels, and server knowledge tools
- **2026-08-28** Skills, bot behavior, gear planning, and seeder fixes and improvements
- **2026-08-27** Add LLM-driven clan management
- **2026-08-26** Observer update, better and faster, player clan crest control, player clan goal control

<details>
<summary>Earlier</summary>

- **2026-08-25** Bot clans update follow-up, bug fixes
- **2026-08-24** Bot clans, better cold/hot performance, bug fixes, and more
- **2026-08-20** Loot and mob skills bug fixes, bot social graph base
- **2026-08-19** Runtime optimization, cold bot progression bottlenecks fix, bot equipment enchantment
- **2026-08-18** Fixes, cold bots progression, better AI compatibility
- **2026-08-17** Fix cold bot progression, melee and polearm attack range, raid minion party fear
- **2026-08-16** Summoners, BD, SWS, agro skills and Observer update
- **2026-08-15** Blade Dancers and Sword Singers bot progression update
- **2026-08-15** Raid Encounter and Gameplay Stability Update
- **2026-08-15** Server stability and performance update
- **2026-08-13** Fix hot party performance issues, fix raid boss atk freeze
- **2026-08-13** Raid bosses, better bot progression and market use, skill fixes, party finder update
- **2026-08-11** Expand C4 world content and bot progression systems
- **2026-08-09** Expand C4 world content and runtime fidelity

</details>

See the full update log on our [Discord](https://discord.gg/dXsQ8SJA7k) server.

## Game Checklist

### ✅ What's done

**Server:**
- Server launcher
- Authentication: create account, login (C4 client, protocol 656)
- Character creation
- Variable server rates for each server start: (x1/x10/x50) XP, SP, party XP/SP, drop/adena/spoil multipliers
- Real-time player web map that shows bots and players
- Partial or full wipe anytime

**World:**
- Complete geodata for all locations
- Complete live economy
- Teleports via NPC or .admin menu
- Live world / local / party / trade chats
- NPC shops in towns
- Profession change (first to third)
- Auto-learn skills (no books or NPC needed)
- Quests (0-20lvl + 1st profession change)
- Private trade or craft
- Clans, including bot clans
- PK system
- Save game
- Clan halls
- SA

**Character:**
- Progression depending on chosen rates
- Full C4 skill coverage: self, targeted, AoE, effects, items, and class skills
- Potions, scrolls, spoil, SA, manor, etc
- Party with bots with native (/invite, /leave), plus `.botparty` / `.bp` to find bots and invite them to the party
- All armor sets
- Soulshots/Spiritshots
- Death, respawn

**Mobs:**
- Attack
- Skill usage
- Drop table (scales from server rates)
- Social agro
- AoE agro
- Party loot
- Raid bosses

**Bots:**
- Dynamic bot population with a smart new bot seeding up to 1700
- Bots are farming solo and in party
- In-party roles (tank, dps, healer, buffer, etc)
- In-party buff control
- Bot goals: equipment craft/drop/purchase, gain wealth, lvl-up faster, etc
- Craft using recipes and craft stations
- Selling loot in towns using a private store
- Buying needed resources or equipment
- PK bots
- Bots attack a PK or run away
- Bots will argue, then attack if a bot or a player hits the same mob
- Communication in chat (LFP, LFG, PK alert, etc)
- Cost parties and friends system
- Reputation system - bots will reject player party if you treat them badly or become friends and const party members if good
- Bots ask for loot if you have something they need
- Bots go for NPC (Nobie guide) buff
- Bots change their farming location based on lvl, number of mobs around, or a crafting goal
- Bots join and fight in a party with a player
- Bots have a memory about interaction with a player; they act correspondingly 
- Bot persona traits: Sociability, Commitment, Caution, Ambition, Assertiveness, Empathy, Resilience
- Bots create clans, level clans up, form clan farm parties
- Bots will fight over mobs on a farm spot
- Bot clans can form raid boss farm parties
- Players can join bot parties
- Clan wars, including autonomous clan wars

### ✴️ Will be added

- Olympiad, heroes
- Sieges (bot- or player -driven)
- World bosses
- Full quests, including profession change
- Better bot AI brain
- Complete Lineage 2 C4 experience

<p align="center">
<img src="https://github.com/user-attachments/assets/99695c45-80e8-4300-afa6-cada58ccd3bd" />
</p>

## 🎮 Wanna play now?

You will need:

- Node.js v22.15+
- A [Lineage II C4 client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing) using protocol 656

## Quick Start

```bash
git clone https://github.com/pmbstyle/L2Solo.git
cd L2Solo
npm install
npm start
```

This command starts the L2Solo Launcher.

Press `Start` in the launcher to run the server. 

Use **Saved Games** while the server is stopped to save a full copy of your world database. Enter a name or leave it blank for a generated one. Saves are stored in `tmp/saves` (or `saves` inside a custom runtime directory), with no limit on their number beyond available disk space. The list shows each save's name, date, time, and size in GB.

**Load** replaces the current database with the selected save and leaves the server stopped. **Delete** permanently removes that save. Both actions ask for confirmation. All saves are manual: loading never creates an automatic backup. Configuration files and launcher settings are not part of a save.

Before opening the game server, L2Solo verifies `data/Geodata` against the pinned release in `scripts/geodata-release.json`: the exact region set, file sizes and SHA-256 checksums must match. Missing, outdated or damaged packs are downloaded and verified in a separate directory. The starter then preserves the entire previous directory as `Geodata.backup-*` and installs the new pack without mixing regions. The C4 pack generated from the local client contains 141 regions (about 681 MiB). See [client geodata](docs/client-geodata.md) for installation and rollback.

```bash
npm run geodata
npm run test:geodata
```
Manual download links:

https://l2solo.com/files/geodata-c4-client-20261027.zip

or

https://drive.google.com/file/d/1P6ZCuSfCPS381zQLTXuce6wbiWc7BL50/view?usp=sharing



## Configuration

Committed defaults live in `config/default.ini`.

Private local overrides go in ignored `config/local.ini`. This is where API keys and a machine-specific SQLite path belong.

Example:

```ini
[OpenRouter]
enabled = true
apiKey = <your-OpenRouter-key-here>
apiUrl = https://openrouter.ai/api/v1/chat/completions
model = openai/gpt-5.6-luna
partyRouterModel = openai/gpt-5.6-luna
# Leave empty if the selected model does not accept temperature.
temperature =
completionLimitParam = max_tokens
strictSchema = true
providerOrder = OpenAI
providerSort = price
allowFallbacks = false
requireParameters = true
debug = false
```

OpenRouter can also read the key/model from environment variables:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here npm start
```

The bot simulation can also use a local or remote provider that exposes the
OpenAI-compatible Chat Completions API. Use an `[AI]` section instead of
`[OpenRouter]` and provide the complete endpoint URL:

```ini
[AI]
enabled = true
apiUrl = http://127.0.0.1:1234/v1/chat/completions
apiKey = lm-studio
model = <model-id-from-the-provider>
partyRouterModel = <model-id-from-the-provider>
# Model-specific request parameters are configured explicitly.
# temperature = 0.35
# completionLimitParam = max_tokens
# strictSchema = false
# Optional for thinking models: off (default), low, medium, or high.
# reasoningEffort = off
```

For Ollama, use `http://127.0.0.1:11434/v1/chat/completions` and a pulled model
tag such as `llama3.2`. The API key can be empty for local providers; a value
like `ollama` or `lm-studio` is also accepted when the server expects an
OpenAI-compatible client key. Thinking is disabled by default for `[AI]`,
which keeps the bounded bot response budget available for the required JSON;
set `reasoningEffort` to `low`, `medium`, or `high` when the selected model
benefits from explicit reasoning.

Clan chat uses the same `model` and `partyRouterModel` settings. Names, roles,
selected clanmates, and follow-up messages are routed first; ambiguous messages
use the routing model to choose one responder or ask for clarification. Both
active and background clan bots can reply in the clan channel.

## In-Game Commands

- `.admin` - open the admin menu.
- `.sell` - sell all unequipped non-Adena items for 50% item value.
- `.afksell` - open the native private-sale window and leave a persistent AFK shop at the current peace-zone location.
- `.afkbuy` - open the native private-purchase window and reserve its Adena budget in a persistent AFK shop.
- `.afkstop` - close the active AFK shop remotely and return all remaining reserved items or Adena.
- `.bot` / `.b` - open companion controls.
- `.botparty` / `.bp` - search active bots to join the player party; distant companions catch up after joining.
- `.joinparty [name]` - ask to take over the named bot's autonomous party, or the nearest eligible bot party when no name is given; if accepted, the player becomes leader and the bots resume their autonomous party after the player leaves.
- `.botfriends` / `.bf` - friend list and const party management.
- `.botstatus` / `.bs` - show a bot overview panel.
- `.botstatus <name>` / `.bs <name>` - show detailed status for a specific bot.
- `.botpath` / `.bpath` (optionally with `<name>`) - inspect bot movement, town-route waypoints, and geodata path diagnostics.
- `.trade` or `/trade` - open the bot trade window with the targeted SimPlayer, useful as a fallback to the native client trade action.
- `.leave` - dismiss all companion bots.
- `.kick <name>` - dismiss one companion bot.
- `/invite` while targeting a bot - recruit that bot as a companion.
- `/dismiss <name>` and `/leave` also work through the party request path.
- `.go` to start arena PvP
- `.buff` target a bot to ask for a paid buff service

Nearby bots also react to plain chat lines such as `hi`, `follow`, `wait`, `hunt`, `heal`, and `buff`.

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.

Crafting with ❤️ by players for players 🤘

<img width="600"  alt="L2solo hit the star" src="https://github.com/user-attachments/assets/5e22564f-fe8e-4956-af21-1158f1849a31" />
