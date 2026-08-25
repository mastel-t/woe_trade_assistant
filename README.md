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
