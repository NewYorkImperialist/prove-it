# 🎯 Prove It!

### ▶ Play now → **https://proveit.fly.dev**

A fast, free browser **bluffing word game**. You get a category — *Football Players, Programming Languages, Famous Mathematicians, Minecraft Mobs, Countries* — and you brag about how many you can name. You and your opponent trade raises ("I can name 7"… "make it 8") until someone calls **"Prove it!"** — and the bluffer has to back it up against the clock.

**No install, no sign-up.** Click the link and you're playing.

## How to play
1. You're shown a category.
2. Declare a number — *"I can name 6."*
3. Trade raises back and forth with your opponent.
4. Someone calls **🗣️ Prove it!** — the claimant must name that many before the timer runs out.
5. Back it up → you take the round. Choke → they do. First to the target score wins.

## Modes
- 👥 **Multiplayer** — create a room, share the link, and play head-to-head in real time. Friends can also **spectate** live.
- 🤖 **Single-player** — play the bot any time (**Easy / Medium / Hard**), no opponent needed. The bot scales its skill to each category and actually reads your bluffs.

## Share it
This is built to be passed around — drop the link in your group chat, Discord, or subreddit and anyone can click and play instantly:

> **https://proveit.fly.dev**

To play a friend specifically: open the site, hit **Create a room**, and share the room link/code — or copy a `?room=CODE` invite link straight from the lobby.

## Content
Thousands of verified answers across dozens of categories — Sports, Geography, History, Entertainment, Food, Animals, Music, Brands, Computer Science, Math, Science, Art, and Pop Culture (yes, including memes and Italian brainrot).

Want to add your own? Edit **`categories.js`** — each entry is `"Name"` or `["Canonical","alias", …]` (aliases all match but count once). The header comment in that file explains the format; no code changes needed.

## Tech
Vanilla HTML/CSS/JS on the front end. **Node + Express + Socket.IO** for realtime multiplayer, deployed on **Fly.io**, with persistent game analytics via **Turso (libSQL)**.

— Built by [NewYorkImperialist](https://github.com/NewYorkImperialist)
