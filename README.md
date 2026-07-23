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
- Party with bots with native (/invite, /leave), plus .botpaty to find nearby bots and invite to the party
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

**Bots:**
- Dynamic bot population with a smart new bot seeding up to 1700
- Bots are farming solo and in party
- In-party roles (tank, dps, healer, buffer, etc)
- In-party buff control
- Bot farm goals: craft or drop equipment for bot progression
- Craft using recipes and craft stations
- Selling loot in towns using a private store
- Buying needed resources or equipment
- PK bots
- Bots attack a PK or run away
- Communication in chat (LFP, LFG, PK alert, etc)
- Bots ask for loot if you have something they need
- Bots go for NPC (Nobie guide) buff
- Bots changing their farming location based on lvl, number of mobs around, or a crafting goal
- Bots join and fight in a party with a player
- Bots have a memory about interaction with a player; they act correspondingly 


### ✴️ Will be added

- Clans, including bot clans
- Clan halls
- Clan wars
- Wars for a farm spot
- Olympiad, heroes
- Siages (bot or player -driven)
- Raids (Raid/World bosses)
- Complete live economy
- Full quests, including profession change
- Better bot AI brain
- Complete Lineage 2 C4 experience
- One-click installer


## 🎮 Wanna play now?

You will need:

- Node.js LTS
- Docker, unless you run MariaDB yourself
- A [Lineage II C4 client](https://drive.google.com/file/d/1u0nW3m9c6Hql8sR9POQAcvglxIno23lv/view?usp=sharing) using protocol 656

## Quick Start

```bash
npm start
```

That command will:

- open the local launcher at `http://127.0.0.1:8090/`;
- show the current server state;
- start and stop the server from the launcher;
- open the world observer map when the server is running.

The launcher keeps the latest server session log at `tmp/logs/latest-server.log` and rotates the prior one to `tmp/logs/previous-server.log`.

Press `Start` in the launcher to run the normal server bootstrap. That start action will:

- install Node dependencies if `node_modules` is missing;
- create or start a local `nodel2-mariadb` Docker container when the configured database host is `127.0.0.1` or `localhost`;
- import `database/sql/database.sql` on first boot if database `nodel2` does not exist;
- start the auth server on `2106`, the game server on `7777`, and the world observer on `8088`.

If you run MariaDB yourself, set:

```bash
L2NODE_SKIP_DOCKER=1 npm start
```

The old direct server command still works:

```bash
npm run NodeL2
```

Use it when dependencies and the database are already prepared, and you want no bootstrap behavior.

## Configuration

Committed defaults live in `config/default.ini`.

Private local overrides go in ignored `config/local.ini`. This is where API keys and machine-specific database settings belong.

Example:

```ini
[OpenRouter]
enabled = true
apiKey = sk-or-v1-your-key-here
model = google/gemini-2.5-flash-lite
debug = true
```

If you use your own database instead of the local Docker container, override the `Database` section there as well.

OpenRouter can also read the key/model from environment variables:

```bash
OPENROUTER_API_KEY=sk-or-v1-your-key-here npm start
```

Useful startup variables:

- `L2NODE_SKIP_DOCKER=1` - skip Docker bootstrap and use the configured database.
- `L2NODE_DB_CONTAINER=some-name` - override the Docker container name.
- `L2NODE_DB_IMAGE=mariadb:10.6` - override the MariaDB image.
- `BOT_STATUS_LOGS=0` - disable periodic bot status log lines.

## In-Game Commands

- `.admin` - open the admin menu.
- `.sell` - sell all unequipped non-Adena items for 50% item value.
- `.bot` or `.companion` - open the companion control panel.
- `.botstatus` - show a bot overview panel.
- `.botstatus <name>` - show detailed status for a specific bot.
- `.botpath` / `.botpath <name>` - inspect bot movement, town-route waypoints, and geodata path diagnostics.
- `.trade` or `/trade` - open the bot trade window with the targeted SimPlayer, useful as a fallback to the native client trade action.
- `.leave` - dismiss all companion bots.
- `.kick <name>` - dismiss one companion bot.
- `/invite` while targeting a bot - recruit that bot as a companion.
- `/dismiss <name>` and `/leave` also work through the party request path.

Nearby bots also react to plain chat lines such as `hi`, `follow`, `wait`, `hunt`, `heal`, and `buff`. Healing and buff help depends on the bot's class and current plan.

## Bot Systems

SimPlayers are normal server sessions backed by database characters. On startup, `BotManager` loads them, assigns plans, and ticks their behavior.

Main bot modes:

- `hunting` - find monsters, fight, loot, and move between spots.
- `resting` - recover HP/MP.
- `getting_buffed` - visit newbie buff flow when low-level buffs expire.
- `shopping` - return to town, sell junk, and restock consumables.
- `following` - assist a real player as a companion.
- `merchant` - stand in town with private buy/sell store state.
- `pk_hunting` / `pk_fleeing` - hostile player-killer loop and safety recovery.

Companion behavior is role-aware. `BotRoles` infers healer, buffer, tank, dagger, archer, mage, or generic DPS from class id. In party mode, tanks can protect the leader and avoid unsafe pulls, healers heal while conserving MP, buffers apply `Might`, `Shield`, `Haste`, and `Wind Walk`, daggers close-assist, and ranged roles keep ranged assist intent.

Bot status is meant to be inspectable. Use `.botparty` to find available nearby SimPlayers, `.botstatus` for state, social memory, role decisions, buff timers, and loot requests, `.botpath` for movement and town-route diagnostics, companion panel `Status` links, or watch `BotStatus :: ...`, `BotSocial :: ...`, `BotRole :: ...`, and `BotLoot :: ...` lines in the server logs.

To reset generated SimPlayer accounts and characters while keeping the rest of the database intact:

```bash
npm run wipe:bots
```

## Development

Run the focused tests:

```bash
node tests/test_pathfinder_astar.js
node tests/test_path_obstacle.js
node tests/test_summon_runtime.js
node tests/test_item_skill_use.js
npm run check
```

Run a full boot check:

```bash
npm start
```

Then press `Start` in the launcher.

Expected healthy boot signs:

- `DB :: connected`
- `Datapack :: cached`
- `SpawnsGrid :: Indexed ... npcs in 2D spatial grid`
- `AuthServer :: successful init for 0.0.0.0:2106`
- `GameServer :: successful init for 0.0.0.0:7777`
- `BotManager :: ... is active in World`
- `BotStatus :: ...`, `BotRole :: ...`, `BotLoot :: ...`, or `BotSocial :: ...` when the corresponding bot paths are active

## Credits

This project is a heavily modified solo-MMO fork of the original [NodeL2 Server Emulator](https://github.com/NodeL2/NodeL2).

L2Solo is licensed under the Apache 2.0 license.

Crafting with ❤️ by a player for players 🤘
