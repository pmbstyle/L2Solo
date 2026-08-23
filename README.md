<p align="center">
<img width="500" height="500" alt="Lineage II Solo" src="l2solo-logo.png" />
</p>



# L2Solo (C4: Scions of Destiny)

Old-school Lineage 2 solo play, locally in a live world with over 1500 bot population.

L2Solo is a local-first Lineage II C4 server emulator, tuned for a solo MMO experiment: one real player, a live world, and bots with AI that makes the server feel alive.

🏗️ Work in progress. Playable.

💬 [Discord](https://discord.gg/dXsQ8SJA7k)
support and communication

⚔️ [Game client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing)
Clean C4 client protocol 656

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
- Communication in chat (LFP, LFG, PK alert, etc)
- Cost parties and friends system
- Reputation system - bots will reject player party if you treated them badly or become friends and const party members if good
- Bots ask for loot if you have something they need
- Bots go for NPC (Nobie guide) buff
- Bots change their farming location based on lvl, number of mobs around, or a crafting goal
- Bots join and fight in a party with a player
- Bots have a memory about interaction with a player; they act correspondingly 
- Bot persona traits: Sociability, Commitment, Caution, Ambition, Assertiveness, Empathy, Resilience

### ✴️ Will be added

- Clans, including bot clans
- Clan halls
- Clan wars
- Wars for a farm spot
- Olympiad, heroes
- Sieges (bot- or player -driven)
- World bosses
- Full quests, including profession change
- Better bot AI brain
- Complete Lineage 2 C4 experience


## 🎮 Wanna play now?

You will need:

- Node.js 22.5+
- A [Lineage II C4 client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing) using protocol 656

## Quick Start

```bash
npm start
```

That command will start the L2Solo Launcher.

Press `Start` in the launcher to run the server. 

On the first server start, L2Solo checks `data/Geodata`. If the region files are missing, it downloads the verified C4 geodata pack from `https://l2solo.com/files/geodata.zip` and installs it before opening the game server. The archive is about 209 MiB and expands to about 900 MiB. You can prepare it without starting the server with:

```bash
npm run geodata
```

Custom mirrors and external geodata directories can be configured with `L2NODE_GEODATA_URL`, `L2NODE_GEODATA_SHA256`, and `L2NODE_GEODATA_DIR`.

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
debug = true
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

## In-Game Commands

- `.admin` - open the admin menu.
- `.sell` - sell all unequipped non-Adena items for 50% item value.
- `.bot` / `.b` - open companion controls.
- `.botparty` / `.bp` - search active bots to join the player party; distant companions catch up after joining.
- `.botfriends` / `.bf` - friend list and const party management.
- `.botstatus` / `.bs` - show a bot overview panel.
- `.botstatus <name>` / `.bs <name>` - show detailed status for a specific bot.
- `.botpath` / `.bpath` (optionally with `<name>`) - inspect bot movement, town-route waypoints, and geodata path diagnostics.
- `.trade` or `/trade` - open the bot trade window with the targeted SimPlayer, useful as a fallback to the native client trade action.
- `.leave` - dismiss all companion bots.
- `.kick <name>` - dismiss one companion bot.
- `/invite` while targeting a bot - recruit that bot as a companion.
- `/dismiss <name>` and `/leave` also work through the party request path.

Nearby bots also react to plain chat lines such as `hi`, `follow`, `wait`, `hunt`, `heal`, and `buff`.

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.

Crafting with ❤️ by a player for players 🤘

<img width="600"  alt="L2solo hit the star" src="https://github.com/user-attachments/assets/5e22564f-fe8e-4956-af21-1158f1849a31" />

