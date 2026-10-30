/* Pack Mule House — variation (size) picker helpers. Pure functions, shared
   by checkout.js and the Node tests. Everything shown comes from the Square
   catalog the Worker serves at /api/catalog. */
(function (root) {
  "use strict";

  function sellable(product) {
    return (product && product.variations ? product.variations : []).filter(
      (v) => v && v.id && Number.isFinite(Number(v.amount))
    );
  }

  /** "Size" for frame kits, "Option" for anything else. */
  function pickerLabel(product) {
    const keys = [product && product.name]
      .concat((product && product.categoryNames) || [])
      .join(" ");
    return /x-?frame/i.test(keys) ? "Size" : "Option";
  }

  /** Drop words every option shares with the product name ("Complete Kit"). */
  function optionLabels(product) {
    const vars = sellable(product);
    const words = (s) => String(s || "").split(/\s+/).filter(Boolean);
    const productWords = new Set(words(product && product.name).map((w) => w.toLowerCase()));
    const shared = new Set(
      words(vars[0] && vars[0].name)
        .map((w) => w.toLowerCase())
        .filter(
          (w) =>
            productWords.has(w) &&
            vars.every((v) => words(v.name).some((x) => x.toLowerCase() === w))
        )
    );
    const out = new Map();
    for (const v of vars) {
      const short = words(v.name)
        .filter((w) => !shared.has(w.toLowerCase()))
        .join(" ");
      out.set(v.id, short || v.name);
    }
    return out;
  }

  function needsPicker(product) {
    return sellable(product).length > 1;
  }

  function selectedVariation(product, selectedId) {
    const vars = sellable(product);
    if (vars.length === 1) return vars[0];
    return vars.find((v) => v.id === selectedId) || null;
  }

  function fmt(amount, currency) {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(Number(amount) / 100);
  }

  /**
   * Card price: the selected option's price; before a pick, "Starting at"
   * the lowest price (or the shared price when every option costs the same).
   */
  function priceDisplay(product, selectedId) {
    const vars = sellable(product);
    const picked = selectedVariation(product, selectedId);
    if (picked) {
      return { from: false, label: picked.priceLabel || fmt(picked.amount, picked.currency) };
    }
    if (!vars.length) return { from: false, label: (product && product.priceLabel) || "" };
    const min = Math.min.apply(null, vars.map((v) => Number(v.amount)));
    const cheapest = vars.find((v) => Number(v.amount) === min);
    const varies = new Set(vars.map((v) => Number(v.amount))).size > 1;
    return {
      from: varies,
      label: cheapest.priceLabel || fmt(cheapest.amount, cheapest.currency),
    };
  }

  const api = { sellable, pickerLabel, optionLabels, needsPicker, selectedVariation, priceDisplay };
  root.PMHPicker = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
