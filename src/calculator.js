const asFiniteNumber = (value, fallback = 0) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function effectiveReturnChance(ingredient) {
  if (ingredient?.return_chance_percent !== undefined && ingredient?.return_chance_percent !== null) {
    return clamp(asFiniteNumber(ingredient.return_chance_percent), 0, 100);
  }
  return ingredient?.return_after_craft ? 100 : 0;
}

export function normalizeOutput(result) {
  const type = result?.type === "rand" ? "rand" : "const";
  const itemId = asFiniteNumber(result?.value);

  if (type === "rand") {
    const min = Math.max(0, asFiniteNumber(result?.min));
    const max = Math.max(min, asFiniteNumber(result?.max, min));
    return {
      type,
      itemId,
      min,
      max,
      expected: (min + max) / 2,
    };
  }

  const count = Math.max(0, asFiniteNumber(result?.count, 1));
  return { type, itemId, min: count, max: count, expected: count };
}

function normalizeIngredient(ingredient) {
  return {
    itemId: asFiniteNumber(ingredient?.item_id),
    quantity: Math.max(0, asFiniteNumber(ingredient?.quantity)),
    returnChance: effectiveReturnChance(ingredient),
  };
}

function recipeSignature(ingredients, outputs) {
  return JSON.stringify({
    ingredients: [...ingredients].sort((a, b) => a.itemId - b.itemId),
    outputs: [...outputs].sort((a, b) => a.itemId - b.itemId),
  });
}

export function createItemIndex(items = []) {
  return new Map(
    items
      .filter((item) => Number.isFinite(Number(item?.type_id)))
      .map((item) => [Number(item.type_id), item]),
  );
}

export function extractCraftCatalog(config = {}, options = {}) {
  const groupedByOutput = new Map();
  const enabledReceiptIds = new Set((options.enabledReceiptIds ?? []).map(Number));

  for (const building of config.buildings_craft ?? []) {
    for (const receipt of building.receipts ?? []) {
      if (receipt.disabled && !enabledReceiptIds.has(Number(receipt.id))) continue;

      const ingredients = (receipt.consume ?? [])
        .map(normalizeIngredient)
        .filter((ingredient) => ingredient.itemId > 0 && ingredient.quantity > 0);
      const outputs = (receipt.result ?? [])
        .map(normalizeOutput)
        .filter((output) => output.itemId > 0 && output.max > 0);

      if (!ingredients.length || !outputs.length) continue;

      const signature = recipeSignature(ingredients, outputs);
      for (const selectedOutput of outputs) {
        if (!groupedByOutput.has(selectedOutput.itemId)) {
          groupedByOutput.set(selectedOutput.itemId, new Map());
        }

        const recipes = groupedByOutput.get(selectedOutput.itemId);
        const duplicate = recipes.get(signature);
        if (duplicate) {
          if (!duplicate.sourceBuildingIds.includes(Number(building.id))) {
            duplicate.sourceBuildingIds.push(Number(building.id));
          }
          continue;
        }

        recipes.set(signature, {
          key: `${selectedOutput.itemId}:${building.id}:${receipt.id}`,
          outputItemId: selectedOutput.itemId,
          selectedOutput,
          outputs,
          ingredients,
          recipeId: Number(receipt.id),
          recipeName: receipt.name || `recipe_${receipt.id}`,
          iconUrl: receipt.icon || "",
          sourceBuildingIds: [Number(building.id)],
        });
      }
    }
  }

  return new Map(
    [...groupedByOutput.entries()].map(([itemId, recipes]) => [itemId, [...recipes.values()]]),
  );
}

export function createPriceIndex(market) {
  return new Map(
    (market?.items ?? []).map((item) => [Number(item.item_type_id), {
      buy: item.best_buy_price === undefined ? null : asFiniteNumber(item.best_buy_price),
      sell: item.best_sell_price === undefined ? null : asFiniteNumber(item.best_sell_price),
    }]),
  );
}

export function calculateRecipe(recipe, runs, prices) {
  const safeRuns = clamp(Math.trunc(asFiniteNumber(runs, 1)), 1, 1_000_000);
  let expectedCost = 0;
  let purchaseCost = 0;
  let expectedRevenue = 0;
  let costComplete = true;
  let purchaseComplete = true;
  let revenueComplete = true;

  const ingredients = recipe.ingredients.map((ingredient) => {
    const quantity = ingredient.quantity * safeRuns;
    const expectedConsumed = quantity * (1 - ingredient.returnChance / 100);
    const unitPrice = prices.get(ingredient.itemId)?.sell ?? null;
    const linePurchaseCost = unitPrice === null ? null : quantity * unitPrice;
    const lineExpectedCost = unitPrice === null ? null : expectedConsumed * unitPrice;

    if (lineExpectedCost === null) costComplete = false;
    else expectedCost += lineExpectedCost;
    if (linePurchaseCost === null) purchaseComplete = false;
    else purchaseCost += linePurchaseCost;

    return {
      ...ingredient,
      quantity,
      expectedConsumed,
      unitPrice,
      purchaseCost: linePurchaseCost,
      expectedCost: lineExpectedCost,
    };
  });

  const outputs = recipe.outputs.map((output) => {
    const min = output.min * safeRuns;
    const max = output.max * safeRuns;
    const expected = output.expected * safeRuns;
    const unitPrice = prices.get(output.itemId)?.buy ?? null;
    const revenue = unitPrice === null ? null : expected * unitPrice;

    if (revenue === null) revenueComplete = false;
    else expectedRevenue += revenue;

    return { ...output, min, max, expected, unitPrice, revenue };
  });

  const selectedOutput = outputs.find((output) => output.itemId === recipe.outputItemId);
  const readyItemUnitPrice = prices.get(recipe.outputItemId)?.sell ?? null;
  const readyItemPurchaseCost = readyItemUnitPrice === null || !selectedOutput
    ? null
    : selectedOutput.expected * readyItemUnitPrice;
  const unitCost = costComplete && selectedOutput?.expected > 0
    ? expectedCost / selectedOutput.expected
    : null;
  const profit = costComplete && revenueComplete ? expectedRevenue - expectedCost : null;
  const savingsVsBuying = costComplete && readyItemPurchaseCost !== null
    ? readyItemPurchaseCost - expectedCost
    : null;

  return {
    runs: safeRuns,
    ingredients,
    outputs,
    selectedOutput,
    expectedCost: costComplete ? expectedCost : null,
    coveredExpectedCost: expectedCost,
    purchaseCost: purchaseComplete ? purchaseCost : null,
    coveredPurchaseCost: purchaseCost,
    expectedRevenue: revenueComplete ? expectedRevenue : null,
    coveredExpectedRevenue: expectedRevenue,
    readyItemUnitPrice,
    readyItemPurchaseCost,
    savingsVsBuying,
    unitCost,
    profit,
    costComplete,
    purchaseComplete,
    revenueComplete,
  };
}

export function calculateCraftChain(recipe, runs, prices, catalog, options = {}) {
  const maxDepth = Math.max(1, Math.trunc(asFiniteNumber(options.maxDepth, 12)));
  const direct = calculateRecipe(recipe, runs, prices);

  function marketNode(itemId, quantity, reason = "raw") {
    const unitPrice = prices.get(itemId)?.sell ?? null;
    const cost = unitPrice === null ? null : quantity * unitPrice;
    return {
      kind: "market",
      itemId,
      quantity,
      unitPrice,
      cost,
      coveredCost: cost ?? 0,
      complete: cost !== null,
      missingItemIds: cost === null ? [itemId] : [],
      reason,
      children: [],
    };
  }

  function craftNode(targetRecipe, craftRuns, path, depth) {
    const selectedOutput = targetRecipe.selectedOutput;
    const quantity = selectedOutput.expected * craftRuns;
    const marketUnitPrice = prices.get(targetRecipe.outputItemId)?.sell ?? null;
    const marketPurchaseCost = marketUnitPrice === null ? null : quantity * marketUnitPrice;
    const children = targetRecipe.ingredients
      .map((ingredient) => {
        const quantity = ingredient.quantity * craftRuns * (1 - ingredient.returnChance / 100);
        if (quantity <= 0) return null;
        return expandItem(ingredient.itemId, quantity, path, depth + 1);
      })
      .filter(Boolean);

    const complete = children.every((child) => child.complete);
    const coveredCost = children.reduce((sum, child) => sum + child.coveredCost, 0);
    const missingItemIds = [...new Set(children.flatMap((child) => child.missingItemIds))];

    return {
      kind: "craft",
      itemId: targetRecipe.outputItemId,
      quantity,
      craftRuns,
      recipe: targetRecipe,
      marketUnitPrice,
      marketPurchaseCost,
      cost: complete ? coveredCost : null,
      coveredCost,
      complete,
      missingItemIds,
      children,
    };
  }

  function expandItem(itemId, quantity, path, depth) {
    if (depth >= maxDepth) return marketNode(itemId, quantity, "depth_limit");
    if (path.includes(itemId)) return marketNode(itemId, quantity, "cycle");

    const recipes = catalog.get(itemId) ?? [];
    if (!recipes.length) return marketNode(itemId, quantity);

    const candidates = recipes
      .filter((candidate) => candidate.selectedOutput.expected > 0)
      .map((candidate) => {
        const craftRuns = quantity / candidate.selectedOutput.expected;
        return craftNode(candidate, craftRuns, [...path, itemId], depth);
      });
    const completeCandidates = candidates
      .filter((candidate) => candidate.complete)
      .sort((a, b) => a.cost - b.cost);

    if (completeCandidates.length) return completeCandidates[0];

    const marketFallback = marketNode(itemId, quantity, "recipe_incomplete");
    if (marketFallback.complete) return marketFallback;

    if (!candidates.length) return marketFallback;
    return candidates.sort((a, b) => (
      a.missingItemIds.length - b.missingItemIds.length
      || b.coveredCost - a.coveredCost
    ))[0];
  }

  const root = craftNode(recipe, direct.runs, [recipe.outputItemId], 0);
  const rawByItem = new Map();
  let craftSteps = 0;

  function collect(node) {
    if (node.kind === "craft") {
      craftSteps += 1;
      node.children.forEach(collect);
      return;
    }

    const current = rawByItem.get(node.itemId) ?? {
      itemId: node.itemId,
      quantity: 0,
      unitPrice: node.unitPrice,
      cost: node.unitPrice === null ? null : 0,
      missing: node.unitPrice === null,
    };
    current.quantity += node.quantity;
    if (current.cost !== null && node.cost !== null) current.cost += node.cost;
    else current.cost = null;
    current.missing ||= node.unitPrice === null;
    rawByItem.set(node.itemId, current);
  }

  collect(root);
  const rawMaterials = [...rawByItem.values()].sort((a, b) => a.itemId - b.itemId);
  const expectedCost = root.complete ? root.coveredCost : null;
  const unitCost = expectedCost !== null && direct.selectedOutput?.expected > 0
    ? expectedCost / direct.selectedOutput.expected
    : null;
  const profit = expectedCost !== null && direct.expectedRevenue !== null
    ? direct.expectedRevenue - expectedCost
    : null;
  const savingsVsBuying = expectedCost !== null && direct.readyItemPurchaseCost !== null
    ? direct.readyItemPurchaseCost - expectedCost
    : null;

  return {
    ...direct,
    expectedCost,
    coveredExpectedCost: root.coveredCost,
    purchaseCost: expectedCost,
    coveredPurchaseCost: root.coveredCost,
    unitCost,
    profit,
    savingsVsBuying,
    costComplete: root.complete,
    purchaseComplete: root.complete,
    root,
    rawMaterials,
    craftSteps,
  };
}
