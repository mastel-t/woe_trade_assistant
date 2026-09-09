# Craft Ledger

A small standalone crafting cost calculator for World of Egg. It does not
bundle copies of the game configuration. Every time the app opens, it loads
the latest data from two read-only Egg Public API endpoints:

- `GET /api/public/v1/configs` — items and crafting recipes;
- `GET /api/public/v1/marketplace/items` — the best prices in each city.

Ingredient costs use `best_sell_price`, which is the price at which an item can
be bought immediately. Instant-sale revenue for the crafted output uses
`best_buy_price`. The expected crafting cost accounts for
`return_chance_percent`; the full initial purchase cost is displayed alongside
it.

The calculator also shows how much the finished item would cost to buy using
its `best_sell_price`. “Crafting savings” is the difference between the market
purchase price of the finished item and its calculated crafting cost.

The `Craft / Harvest` selector switches between crafting recipes and harvest
receipts. In Harvest mode, each receipt option includes its result item names.
Every harvest result is kept in a result table; selectable results can be
included or excluded there, while non-selectable results remain visible.

The `Market / Chain` switch changes how ingredient costs are calculated:

- `Market` buys every ingredient of the selected recipe directly from the
  marketplace;
- `Chain` recursively expands craftable ingredients down to raw materials,
  selects the cheapest fully calculable recipe, and displays a collapsible
  tree of crafting steps.

The chain is an economic estimate: random output and ingredient returns use
their expected average values. If a nested recipe cannot be fully calculated
but its intermediate item is available on the marketplace, the calculator
uses its marketplace price as a fallback.

In Harvest mode, choose the characters and equipment for the selected receipt.
Runs defaults to the receipt's maximum parallel count when entering Harvest or
changing receipts. You can adjust it manually. Shard consumption per selected slot
is `(harvest duration / shard duration / max_parallel) × ceil(Runs / max_parallel)`.
Cost uses this quantity. With a maximum parallel count of 12, Runs 1–12 use the same
Shard quantity, Runs 13–24 use twice that quantity, and Runs 25–36 use three times.
Choose **Shards** in the same section, or select **None** to remove one.
The available choices and slots depend on the receipt. The same shard can be
selected in multiple slots. Selected shards appear
in the material list with estimated consumption and update the affected
material damage and rewards. Experience bonuses are not shown in this calculator.
In Harvest materials, **BROKEN** shows the consumed percentage: 0% means no
consumption, 100% means the listed quantity, and 200% means twice that quantity.
Use the reward perk checkboxes in the header to enable bonuses and extra
rewards in Harvest mode. Craft mode shows only the acquired recipe perks.
Choose the perks you have unlocked. Each reward perk applies only to its matching Harvest
receipts and rewards. Other effects such as speed or material consumption
are not included.

The reward table separates **CHANCE** (the reward probability), **QUANTITY**
(the amount per successful reward, including equipment bonuses), and
**EXPECTED QUANTITY** (the estimated total for the selected number of runs).
CHANCE and QUANTITY show both the effective value and the base value.
Select or clear reward checkboxes to choose your target rewards.

Use **Market / Chain** to inspect material costs. Enter an **Assumed price**
to try a custom material or reward price, or clear it to use the market price.

## Local setup

Node.js 22 LTS and an internet connection are required. You do not need to run
a backend server or database: the browser loads current data from the public
API.

Verify your Node.js installation with:

```bash
node --version
npm --version
```

### Windows

1. Install [Node.js 22 LTS](https://nodejs.org/) or run this command in
   PowerShell:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   ```

2. Reopen PowerShell, navigate to the application directory, and start it:

   ```powershell
   cd "C:\path\to\egg-craft-calculator"
   npm install
   npm run dev
   ```

   If PowerShell blocks `npm.ps1`, use `npm.cmd install` and
   `npm.cmd run dev` instead.

### macOS

Install [Node.js 22 LTS](https://nodejs.org/) using the `.pkg` installer or
Homebrew, then start the application:

```bash
brew install node@22
cd "/path/to/egg-craft-calculator"
npm install
npm run dev
```

### Linux

Install Node.js 22 LTS from the [official website](https://nodejs.org/) or with
a Node.js version manager, then run:

```bash
cd /path/to/egg-craft-calculator
npm install
npm run dev
```

On every platform, open the URL printed by Vite, usually
`http://localhost:5173`. Press `Ctrl+C` to stop the development server.

## GitHub Pages preview

The `.github/workflows/deploy-pages.yml` workflow automatically runs the tests,
builds the app, and publishes it after every push to `main`.

The source code is hosted in
[`SQRT-Games/woe_trade_assistant`](https://github.com/SQRT-Games/woe_trade_assistant).
The preview is available at
[`https://sqrt-games.github.io/woe_trade_assistant/`](https://sqrt-games.github.io/woe_trade_assistant/).

If Pages has not been enabled yet, open **Settings → Pages** in the GitHub
repository and select **GitHub Actions** under **Source**. After the
**Deploy to GitHub Pages** workflow completes, the URL will also appear in the
workflow results and under **Settings → Pages**.

The preview uses live data: the static site calls the public API directly, so
visitors need an internet connection.

## Tests and production build

```bash
npm test
npm run build
npm run preview
```

By default, the app connects to `https://woe-idle.com/api/public/v1`. You can
provide a different server at build time:

```bash
VITE_API_BASE_URL=https://example.com/api/public/v1 npm run build
```

For local diagnostics, the same address can be supplied through the `api`
query parameter:

```text
http://localhost:5173/?api=https://example.com/api/public/v1
```
