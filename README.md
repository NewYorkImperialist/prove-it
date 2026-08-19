# 🎯 Prove It!

### ▶ Play now → **https://proveit.fly.dev**

**The bluffing game Scattergories wishes it was.** You get a category — *Football Players, Programming Languages, Famous Mathematicians, Minecraft Mobs, Countries* — and instead of just listing answers, you **brag about how many you can name.** Your opponent doesn't know if you're bluffing. Neither do you, really, until the clock is running and you're sweating out #7.

You trade raises ("I can name 7"… "make it 8") until someone calls **"Prove it!"** — and the bluffer has to back it up before time runs out. Nail it and you take the round. Choke and they do.

**No install, no sign-up, no ads.** Click the link, you're in a round in seconds.

## How to play
**Multiplayer** is a bluffing duel:
1. You're shown a category.
2. Declare a number — *"I can name 6."*
3. Trade raises back and forth with your opponent.
4. Someone calls **🗣️ Prove it!** — the claimant must name that many before the timer runs out.
5. Back it up → you take the round. Choke → they do. First to the target score wins.

**Solo** and **Daily Challenge** drop the bluffing — it's just you against the clock, naming as many as you can per category before time runs out.

## Modes
- 👥 **Multiplayer** — create a room, share the link, and play head-to-head in real time. Friends can also **spectate** live.
- 🕹️ **Solo** — pick a category, or build a custom multi-round run, and race the clock alone. No opponent needed.
- 📅 **Daily Challenge** — the same puzzle for everyone each day, with a shared leaderboard. Share your score and challenge friends to beat it.

## Why it hits different
- **The bluff is the game.** Most naming games end when you run out of answers. Here, the tension is deciding *when to stop raising* — pure "chicken" energy, not trivia recall.
- **250+ categories, ~11,000 verified answers** — deep enough that regulars still get surprised, wide enough that non-nerds can hang.
- **Real-time, not turn-based.** Raises and calls happen live over Socket.IO — no refreshing, no waiting on someone's turn.
- **A few secrets** hidden in the category list that we're not going to spoil here.

## Share it
This is built to be passed around — drop the link in your group chat, Discord, or subreddit and anyone can click and play instantly:

> **https://proveit.fly.dev**

To play a friend specifically: open the site, hit **Create a room**, and share the room link/code — or copy a `?room=CODE` invite link straight from the lobby.

## Content
**250+ categories, ~11,000 verified answers**, spanning Sports, Geography, History, Entertainment, Food, Animals, Music, Brands, Computer Science, Math, Science, Art, Mythology, Games & Puzzles, and Pop Culture (yes, including memes and Italian brainrot).

Want to add your own? Edit **`data/categories.js`** — each entry is `"Name"` or `["Canonical","alias", …]` (aliases all match but count once). The header comment in that file explains the format; no code changes needed.

## Tech
**Next.js (App Router) + React + Tailwind CSS** on the front end. **Node + Express + Socket.IO** for realtime multiplayer, deployed on **Fly.io**, with persistent game analytics via **Turso (libSQL)**.

One process serves both: `server.js` keeps Express for the JSON API, the owner dashboard and the crawler-facing share stub, runs the Socket.IO layer, and hands every other request to Next.

```
app/, components/, hooks/   the client (React + Tailwind)
lib/                        shared logic, plain CommonJS, covered by node:test
lib/browser/                browser-only client modules (sound, storage, the D3 geo board)
data/                       game content + generated data
game-engine.js              the multiplayer duel
race-engine.js              the live Challenge Race
rooms.js, matchmaking.js    lobbies, reconnection, quick match
routes/, stats.js           JSON API, owner dashboard, analytics
```

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # node:test
npm run lint
npm run build   # the production client bundle (then `npm start`)
```

## Deploying
Pushing to `main` deploys to Fly.io on its own (`.github/workflows/deploy.yml`) once lint, tests
and the client build all pass. You can also trigger it by hand from the repo's **Actions** tab →
**Deploy** → **Run workflow**, which is the easy way to redeploy without a new commit.

It needs one repository secret, set once: `fly tokens create deploy`, then save the output (the
`FlyV1 …` string) under **Settings → Secrets and variables → Actions** as **`FLY_API_TOKEN`**.
The running server wants that same token as a *Fly* secret too — that's what lets its cost guard
scale the machine down; see the note in `fly.toml`.

```bash
fly deploy      # or deploy straight from your machine, bypassing CI
```

— Built by [NewYorkImperialist](https://github.com/NewYorkImperialist)
