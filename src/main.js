import "./styles.css";
import {
  calculateCraftChain,
  calculateRecipe,
  createItemIndex,
  createPriceIndex,
  extractCraftCatalog,
} from "./calculator.js";

const DEFAULT_API_BASE = "https://woe-idle.com/api/public/v1";
const queryApi = new URLSearchParams(window.location.search).get("api");
const API_BASE = (queryApi || import.meta.env.VITE_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, "");

const state = {
  config: null,
  marketplace: null,
  translations: {},
  items: new Map(),
  catalog: new Map(),
  prices: new Map(),
  perkIds: new Set(),
  selectedMarket: null,
  visibleItemIds: [],
  costMode: "direct",
};

const elements = Object.fromEntries(
  [
    "calculator", "loadingPanel", "results", "errorPanel", "errorMessage",
    "errorRetryButton", "refreshButton", "liveBadge", "liveLabel", "citySelect",
    "itemSearch", "itemSelect", "recipeField", "recipeSelect",
    "runsInput", "decreaseRuns", "increaseRuns", "perkList", "selectedItemImage", "itemTierBadge",
    "selectedItemName", "selectedRecipeName", "outputAmount", "expectedCost", "unitCost",
    "unitCostHint", "instantRevenue", "marketPurchaseCost", "profitMetric", "expectedProfit",
    "profitHint", "savingsMetric", "craftSavings", "savingsHint",
    "costFootnote", "purchaseTotal", "purchaseLabel", "ingredientsTitle", "ingredientsBody",
    "missingPriceNote", "coProducts", "directModeButton", "chainModeButton", "chainTree",
    "chainSteps", "chainTreeBody",
  ].map((id) => [id, document.getElementById(id)]),
);

const moneyFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const quantityFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const smallQuantityFormatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 5 });
const dateFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  day: "2-digit",
  month: "short",
});

function deepGet(object, path) {
  return String(path).split(".").reduce((value, key) => value?.[key], object);
}

function humanizeKey(key) {
  if (!key) return "Untitled";
  const leaf = String(key).includes(".") ? String(key).split(".").at(-2) || key : key;
  return leaf
    .replace(/^(item|craft_craft|craft|building)_/, "")
    .replace(/_(name|title|description)$/, "")
    .replaceAll("_", " ")
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

function translate(key) {
  const translated = deepGet(state.translations, key);
  return typeof translated === "string" ? translated : humanizeKey(key);
}

function itemName(itemId) {
  const item = state.items.get(Number(itemId));
  return item ? translate(item.name) : `Item #${itemId}`;
}

function formatMoney(value) {
  return value === null || !Number.isFinite(value) ? "—" : `${moneyFormatter.format(value)} ◈`;
}

function formatQuantity(value) {
  return Math.abs(value) > 0 && Math.abs(value) < 0.01
    ? smallQuantityFormatter.format(value)
    : quantityFormatter.format(value);
}

function setOption(select, value, label) {
  const option = document.createElement("option");
  option.value = String(value);
  option.textContent = label;
  select.append(option);
}

function marketById(id) {
  return state.marketplace?.markets?.find((market) => market.city.uuid === id) ?? null;
}

function recipeByKey(key) {
  const itemId = Number(elements.itemSelect.value);
  return state.catalog.get(itemId)?.find((recipe) => recipe.key === key) ?? null;
}

function selectedRecipe() {
  return recipeByKey(elements.recipeSelect.value);
}

function setLoading(loading) {
  elements.calculator.setAttribute("aria-busy", String(loading));
  elements.loadingPanel.hidden = !loading;
  elements.refreshButton.disabled = loading;
  elements.refreshButton.classList.toggle("is-loading", loading);
  elements.liveBadge.classList.toggle("is-loading", loading);
  elements.liveLabel.textContent = loading ? "Refreshing…" : "Data is up to date";
}

function showError(error) {
  elements.errorMessage.textContent = error instanceof Error ? error.message : String(error);
  elements.errorPanel.hidden = false;
  elements.results.hidden = true;
  elements.liveBadge.classList.add("has-error");
  elements.liveLabel.textContent = "No data";
}

async function fetchJson(url, label) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${label}: server returned ${response.status}`);
  return response.json();
}

async function loadData() {
  setLoading(true);
  elements.errorPanel.hidden = true;
  elements.liveBadge.classList.remove("has-error");

  try {
    const [config, marketplace] = await Promise.all([
      fetchJson(`${API_BASE}/configs`, "Configuration"),
      fetchJson(`${API_BASE}/marketplace/items`, "Marketplace"),
    ]);

    if (!Array.isArray(config.items) || !Array.isArray(config.buildings_craft)) {
      throw new Error("The configuration API returned an unknown data format");
    }
    if (!Array.isArray(marketplace.markets) || marketplace.markets.length === 0) {
      throw new Error("The marketplace response contains no cities");
    }

    state.config = config;
    state.marketplace = marketplace;
    state.items = createItemIndex(config.items);
    state.perkIds = new Set();

    elements.liveBadge.title = `Configuration ${config.version || "unversioned"} · prices as of ${dateFormatter.format(new Date(marketplace.server_now_unix_ms))}`;
    populatePerks();
    rebuildCatalog();
    populateCities();
    selectMarket(elements.citySelect.value);
    enableControls();
    elements.results.hidden = false;
    renderCalculation();
  } catch (error) {
    showError(error);
  } finally {
    setLoading(false);
  }
}

function populateCities() {
  const previous = elements.citySelect.value;
  elements.citySelect.replaceChildren();
  for (const market of state.marketplace.markets) {
    setOption(elements.citySelect, market.city.uuid, translate(market.city.name));
  }
  if (marketById(previous)) elements.citySelect.value = previous;
}

function enableControls() {
  for (const element of [elements.citySelect, elements.itemSearch, elements.itemSelect, elements.runsInput]) {
    element.disabled = false;
  }
}

function recipeUnlockPerks() {
  return (state.config?.technology_tree?.nodes ?? []).filter((perk) => (
    (perk.effects ?? []).some((effect) => Number.isFinite(Number(
      effect.Target?.BuildingTarget?.receipt_id,
    )) && effect.Effect?.CraftEnableReceipt !== undefined)
  ));
}

function enabledReceiptIds() {
  return recipeUnlockPerks()
    .filter((perk) => state.perkIds.has(Number(perk.id)))
    .flatMap((perk) => (perk.effects ?? [])
      .filter((effect) => effect.Effect?.CraftEnableReceipt !== undefined)
      .map((effect) => Number(effect.Target?.BuildingTarget?.receipt_id)))
    .filter(Number.isFinite);
}

function populatePerks() {
  elements.perkList.replaceChildren();
  for (const perk of recipeUnlockPerks()) {
    const label = document.createElement("label");
    label.className = "perk-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(perk.id);
    checkbox.checked = state.perkIds.has(Number(perk.id));
    checkbox.addEventListener("change", () => {
      const perkId = Number(checkbox.value);
      if (checkbox.checked) state.perkIds.add(perkId);
      else state.perkIds.delete(perkId);
      rebuildCatalog();
    });
    const name = document.createElement("span");
    name.textContent = translate(perk.name);
    label.append(checkbox, name);
    elements.perkList.append(label);
  }
}

function rebuildCatalog() {
  const previousItemId = Number(elements.itemSelect.value);
  state.catalog = extractCraftCatalog(state.config, { enabledReceiptIds: enabledReceiptIds() });
  populateItems(elements.itemSearch.value, state.catalog.has(previousItemId) ? previousItemId : null);
}

function selectMarket(marketId) {
  const previousItemId = Number(elements.itemSelect.value);
  state.selectedMarket = marketById(marketId) ?? state.marketplace.markets[0];
  elements.citySelect.value = state.selectedMarket.city.uuid;
  state.prices = createPriceIndex(state.selectedMarket);
  populateItems(
    elements.itemSearch.value,
    state.catalog.has(previousItemId) ? previousItemId : null,
  );
}

function availableItemIds() {
  return [...state.catalog.keys()].filter((itemId) => state.items.has(itemId));
}

function bestInitialItemId() {
  const candidates = availableItemIds()
    .map((itemId) => {
      const completeRecipes = (state.catalog.get(itemId) ?? []).filter((recipe) => {
        const calculation = calculateRecipe(recipe, 1, state.prices);
        return calculation.costComplete && calculation.revenueComplete;
      });
      return {
        itemId,
        label: itemName(itemId),
        ingredientCount: Math.min(...completeRecipes.map((recipe) => recipe.ingredients.length)),
      };
    })
    .filter((candidate) => Number.isFinite(candidate.ingredientCount))
    .sort((a, b) => a.ingredientCount - b.ingredientCount || a.label.localeCompare(b.label, "en"));

  return candidates[0]?.itemId ?? availableItemIds()[0] ?? null;
}

function populateItems(search = "", preferredItemId = null) {
  const needle = search.trim().toLocaleLowerCase("en");
  const matching = availableItemIds()
    .map((itemId) => ({ itemId, label: itemName(itemId) }))
    .filter(({ itemId, label }) => !needle || label.toLocaleLowerCase("en").includes(needle) || String(itemId).includes(needle))
    .sort((a, b) => a.label.localeCompare(b.label, "en"));

  state.visibleItemIds = matching.map(({ itemId }) => itemId);
  elements.itemSelect.replaceChildren();
  if (!matching.length) {
    setOption(elements.itemSelect, "", "No items found");
    elements.itemSelect.disabled = true;
    elements.recipeSelect.replaceChildren();
    setOption(elements.recipeSelect, "", "—");
    elements.recipeSelect.disabled = true;
    elements.results.hidden = true;
    return;
  }

  for (const { itemId, label } of matching) {
    const priceMarker = state.prices.has(itemId) ? "" : " · no price";
    setOption(elements.itemSelect, itemId, `${label} · #${itemId}${priceMarker}`);
  }
  elements.itemSelect.disabled = false;
  const initialItemId = search ? null : bestInitialItemId();
  const target = matching.some(({ itemId }) => itemId === preferredItemId)
    ? preferredItemId
    : matching.some(({ itemId }) => itemId === initialItemId)
      ? initialItemId
      : matching[0].itemId;
  elements.itemSelect.value = String(target);
  populateRecipes();
  elements.results.hidden = false;
}

function populateRecipes() {
  const recipes = state.catalog.get(Number(elements.itemSelect.value)) ?? [];
  const previous = elements.recipeSelect.value;
  elements.recipeSelect.replaceChildren();

  recipes.forEach((recipe, index) => {
    const buildings = recipe.sourceBuildingIds.length > 1
      ? `${recipe.sourceBuildingIds.length} buildings`
      : `building #${recipe.sourceBuildingIds[0]}`;
    setOption(elements.recipeSelect, recipe.key, `${translate(recipe.recipeName)} · ${buildings}${recipes.length > 1 ? ` · variant ${index + 1}` : ""}`);
  });

  if (recipes.some((recipe) => recipe.key === previous)) {
    elements.recipeSelect.value = previous;
  } else {
    const completeRecipe = recipes.find((recipe) => {
      const calculation = calculateRecipe(recipe, elements.runsInput.value, state.prices);
      return calculation.costComplete && calculation.revenueComplete;
    });
    if (completeRecipe) elements.recipeSelect.value = completeRecipe.key;
  }
  elements.recipeSelect.disabled = recipes.length <= 1;
  elements.recipeField.classList.toggle("is-muted", recipes.length <= 1);
  renderCalculation();
}

function renderOutputAmount(output) {
  if (!output) return "—";
  if (output.min === output.max) return `${formatQuantity(output.expected)} items`;
  return `${formatQuantity(output.min)}–${formatQuantity(output.max)} items · ${formatQuantity(output.expected)} average`;
}

function renderItemHeader(recipe, calculation) {
  const item = state.items.get(recipe.outputItemId) ?? {};
  const imageUrl = item.icon_url_large || item.icon_url || recipe.iconUrl;
  elements.selectedItemImage.src = imageUrl || "";
  elements.selectedItemImage.hidden = !imageUrl;
  elements.selectedItemImage.onerror = () => { elements.selectedItemImage.hidden = true; };
  elements.selectedItemImage.alt = itemName(recipe.outputItemId);
  elements.itemTierBadge.textContent = item.tier ? `T${item.tier}` : `#${recipe.outputItemId}`;
  elements.selectedItemName.textContent = itemName(recipe.outputItemId);
  elements.selectedRecipeName.textContent = translate(recipe.recipeName);
  elements.outputAmount.textContent = renderOutputAmount(calculation.selectedOutput);
}

function renderMetrics(calculation) {
  elements.expectedCost.textContent = formatMoney(calculation.expectedCost);
  elements.unitCost.textContent = formatMoney(calculation.unitCost);
  elements.instantRevenue.textContent = formatMoney(calculation.expectedRevenue);
  elements.marketPurchaseCost.textContent = formatMoney(calculation.readyItemPurchaseCost);
  elements.purchaseTotal.textContent = formatMoney(calculation.purchaseCost);
  elements.expectedProfit.textContent = formatMoney(calculation.profit);
  elements.craftSavings.textContent = formatMoney(calculation.savingsVsBuying);

  elements.profitMetric.classList.remove("is-positive", "is-negative", "is-unknown");
  if (calculation.profit === null) {
    elements.profitMetric.classList.add("is-unknown");
    elements.profitHint.textContent = "requires all market prices";
  } else if (calculation.profit >= 0) {
    elements.profitMetric.classList.add("is-positive");
    elements.profitHint.textContent = "profit before fees";
  } else {
    elements.profitMetric.classList.add("is-negative");
    elements.profitHint.textContent = "loss before fees";
  }

  elements.savingsMetric.classList.remove("is-positive", "is-negative", "is-unknown");
  if (calculation.savingsVsBuying === null) {
    elements.savingsMetric.classList.add("is-unknown");
    elements.savingsHint.textContent = "finished item has no price";
  } else if (calculation.savingsVsBuying >= 0) {
    elements.savingsMetric.classList.add("is-positive");
    elements.savingsHint.textContent = "crafting is cheaper than buying";
  } else {
    elements.savingsMetric.classList.add("is-negative");
    elements.savingsHint.textContent = "crafting is more expensive than buying";
  }

  const selected = calculation.selectedOutput;
  elements.unitCostHint.textContent = selected?.min === selected?.max
    ? "based on actual output"
    : "based on average output";

  if (state.costMode === "chain") {
    elements.costFootnote.textContent = "The chain automatically expands craftable ingredients into raw materials and selects the cheapest complete recipe. Quantities use average output and expected consumption after returns.";
  } else {
    const reusableCount = calculation.ingredients.filter((item) => item.returnChance > 0).length;
    elements.costFootnote.textContent = reusableCount
      ? `Expected cost includes returns for ${reusableCount} ingredient${reusableCount === 1 ? "" : "s"}. “Required upfront” shows the full initial purchase cost.`
      : "Cost is calculated from the best sell orders: the amount required to buy every ingredient immediately on the marketplace.";
  }
}

function makeIngredientRow(ingredient) {
  const row = document.createElement("tr");
  const item = state.items.get(ingredient.itemId) ?? {};

  const itemCell = document.createElement("td");
  const itemWrap = document.createElement("div");
  itemWrap.className = "ingredient-item";
  const image = document.createElement("img");
  image.src = item.icon_url || "";
  image.alt = "";
  image.hidden = !image.src;
  image.onerror = () => { image.hidden = true; };
  const labels = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = itemName(ingredient.itemId);
  const id = document.createElement("small");
  id.textContent = `#${ingredient.itemId}`;
  labels.append(name, id);
  itemWrap.append(image, labels);
  itemCell.append(itemWrap);

  const quantityCell = document.createElement("td");
  quantityCell.textContent = formatQuantity(ingredient.quantity);
  const priceCell = document.createElement("td");
  priceCell.textContent = formatMoney(ingredient.unitPrice);
  const returnCell = document.createElement("td");
  returnCell.textContent = ingredient.returnChance ? `${formatQuantity(ingredient.returnChance)}%` : "—";
  const costCell = document.createElement("td");
  costCell.className = "line-cost";
  costCell.textContent = formatMoney(ingredient.expectedCost);

  if (ingredient.unitPrice === null) row.classList.add("has-missing-price");
  row.append(itemCell, quantityCell, priceCell, returnCell, costCell);
  return row;
}

function renderIngredients(calculation) {
  const rows = state.costMode === "chain"
    ? calculation.rawMaterials.map((material) => ({
        itemId: material.itemId,
        quantity: material.quantity,
        returnChance: 0,
        unitPrice: material.unitPrice,
        expectedCost: material.cost,
      }))
    : calculation.ingredients;
  elements.ingredientsBody.replaceChildren(...rows.map(makeIngredientRow));
  const missing = rows.filter((ingredient) => ingredient.unitPrice === null);
  elements.missingPriceNote.hidden = missing.length === 0;
  elements.missingPriceNote.textContent = missing.length
    ? `No active sell orders for: ${missing.map((item) => itemName(item.itemId)).join(", ")}. The total is hidden to avoid understating the cost.`
    : "";

  elements.ingredientsTitle.textContent = state.costMode === "chain" ? "Market raw materials" : "Ingredients";
  elements.purchaseLabel.textContent = state.costMode === "chain" ? "Raw material cost" : "Required upfront";
}

function renderCoProducts(recipe, calculation) {
  const coProducts = calculation.outputs.filter((output) => output.itemId !== recipe.outputItemId);
  elements.coProducts.hidden = coProducts.length === 0;
  elements.coProducts.replaceChildren();
  if (!coProducts.length) return;

  const title = document.createElement("strong");
  title.textContent = "Additional output";
  const list = document.createElement("span");
  list.textContent = coProducts
    .map((output) => `${itemName(output.itemId)} — ${renderOutputAmount(output)}`)
    .join("; ");
  elements.coProducts.append(title, list);
}

function makeChainNode(node, depth = 0) {
  if (node.kind === "market") {
    const leaf = document.createElement("div");
    leaf.className = "chain-leaf";

    const marker = document.createElement("span");
    marker.className = "chain-marker";
    marker.textContent = "M";
    const label = document.createElement("strong");
    label.textContent = itemName(node.itemId);
    const meta = document.createElement("span");
    meta.textContent = `${formatQuantity(node.quantity)} items · ${formatMoney(node.cost)}`;
    if (node.reason === "recipe_incomplete") meta.title = "A recipe exists, but the complete chain cannot currently be calculated";

    leaf.append(marker, label, meta);
    return leaf;
  }

  const details = document.createElement("details");
  details.className = "chain-node";
  details.open = depth === 0;

  const summary = document.createElement("summary");
  const labelWrap = document.createElement("span");
  labelWrap.className = "chain-node-label";
  const marker = document.createElement("span");
  marker.className = "chain-marker is-craft";
  marker.textContent = "C";
  const labels = document.createElement("span");
  const label = document.createElement("strong");
  label.textContent = itemName(node.itemId);
  const recipeLabel = document.createElement("small");
  recipeLabel.textContent = translate(node.recipe.recipeName);
  labels.append(label, recipeLabel);
  labelWrap.append(marker, labels);

  const meta = document.createElement("span");
  meta.className = "chain-node-meta";
  const quantity = document.createElement("span");
  quantity.textContent = `${formatQuantity(node.quantity)} items · ${formatQuantity(node.craftRuns)} crafts`;
  const comparison = document.createElement("span");
  comparison.className = "chain-cost-compare";
  comparison.textContent = `Craft ${formatMoney(node.cost)} · buy ${formatMoney(node.marketPurchaseCost)}`;
  if (node.cost !== null && node.marketPurchaseCost !== null) {
    comparison.classList.add(node.cost <= node.marketPurchaseCost ? "is-cheaper" : "is-expensive");
  }
  meta.append(quantity, comparison);
  summary.append(labelWrap, meta);

  const children = document.createElement("div");
  children.className = "chain-children";
  children.append(...node.children.map((child) => makeChainNode(child, depth + 1)));
  details.append(summary, children);
  return details;
}

function renderChain(calculation) {
  const isChain = state.costMode === "chain";
  elements.chainTree.hidden = !isChain;
  elements.chainTreeBody.replaceChildren();
  if (!isChain) return;

  elements.chainSteps.textContent = `${calculation.craftSteps} step${calculation.craftSteps === 1 ? "" : "s"}`;
  elements.chainTreeBody.append(makeChainNode(calculation.root));
}

function renderCalculation() {
  const recipe = selectedRecipe();
  if (!recipe || !state.selectedMarket) return;
  const calculation = state.costMode === "chain"
    ? calculateCraftChain(recipe, elements.runsInput.value, state.prices, state.catalog)
    : calculateRecipe(recipe, elements.runsInput.value, state.prices);
  elements.runsInput.value = String(calculation.runs);
  renderItemHeader(recipe, calculation);
  renderMetrics(calculation);
  renderIngredients(calculation);
  renderCoProducts(recipe, calculation);
  renderChain(calculation);
}

function setCostMode(mode) {
  state.costMode = mode === "chain" ? "chain" : "direct";
  const isChain = state.costMode === "chain";
  elements.directModeButton.classList.toggle("is-active", !isChain);
  elements.chainModeButton.classList.toggle("is-active", isChain);
  elements.directModeButton.setAttribute("aria-pressed", String(!isChain));
  elements.chainModeButton.setAttribute("aria-pressed", String(isChain));
  renderCalculation();
}

function changeRuns(delta) {
  const value = Number(elements.runsInput.value) || 1;
  elements.runsInput.value = String(Math.min(1_000_000, Math.max(1, value + delta)));
  renderCalculation();
}

elements.citySelect.addEventListener("change", () => selectMarket(elements.citySelect.value));
elements.itemSearch.addEventListener("input", () => populateItems(elements.itemSearch.value, Number(elements.itemSelect.value)));
elements.itemSelect.addEventListener("change", populateRecipes);
elements.recipeSelect.addEventListener("change", renderCalculation);
elements.runsInput.addEventListener("input", renderCalculation);
elements.runsInput.addEventListener("blur", renderCalculation);
elements.decreaseRuns.addEventListener("click", () => changeRuns(-1));
elements.increaseRuns.addEventListener("click", () => changeRuns(1));
elements.directModeButton.addEventListener("click", () => setCostMode("direct"));
elements.chainModeButton.addEventListener("click", () => setCostMode("chain"));
elements.refreshButton.addEventListener("click", loadData);
elements.errorRetryButton.addEventListener("click", loadData);

loadData();
