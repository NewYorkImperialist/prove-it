# 🎯 Prove It!

A fast browser word-game. The game gives you a category — *Football Players*, *US States*, *Car Brands* — and you brag about how many you can name. Then you trade raises with the bot until someone calls **"Prove it!"** and the bluffer has to back it up against the clock.

## Play

It's a static site — no install, no server. Open `index.html` in a browser, or visit the hosted version.

## How it works

- **`index.html`** — markup + styles (the UI shell)
- **`categories.js`** — all game content; the only file you edit to add categories/answers
- **`game.js`** — game logic

### Adding categories

Edit `categories.js`. Each item is a plain string, or `["Canonical Name", "alias", …]` where every alias is accepted but counts as one. See the header comment in that file for details.
