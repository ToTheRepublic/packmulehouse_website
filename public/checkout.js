/**
 * Pack Mule House — cart, shipping address, Square order checkout
 */
(function () {
  "use strict";

  const CART_KEY = "pmh_cart_v1";

  const grid = document.getElementById("product-grid");
  const envBadge = document.getElementById("env-badge");
  const modal = document.getElementById("checkout-modal");
  const form = document.getElementById("checkout-form");
  const payButton = document.getElementById("pay-button");
  const payStatus = document.getElementById("pay-status");
  const cartBadge = document.getElementById("cart-badge");
  const cartLinesEl = document.getElementById("cart-lines");
  const cartSubtotalEl = document.getElementById("cart-subtotal");
  const cartShippingEl = document.getElementById("cart-shipping");
  const cartDiscountRow = document.getElementById("cart-discount-row");
  const cartDiscountEl = document.getElementById("cart-discount");
  const cartDiscountLabelEl = document.getElementById("cart-discount-label");
  const cartTaxEl = document.getElementById("cart-tax");
  const cartTaxLabelEl = document.getElementById("cart-tax-label");
  const cartTotalEl = document.getElementById("cart-total");
  const panelCart = document.getElementById("panel-cart");
  const panelPay = document.getElementById("panel-pay");
  const paySummary = document.getElementById("pay-summary");
  const checkoutTitle = document.getElementById("checkout-title");
  const checkoutSubtitle = document.getElementById("checkout-subtitle");
  const cartCheckoutBtn = document.getElementById("cart-checkout-btn");
  const toastEl = document.getElementById("cart-toast");
  const sandboxHint = document.getElementById("sandbox-card-hint");
  const panelConfirm = document.getElementById("panel-confirm");
  const confirmMessage = document.getElementById("confirm-message");
  const confirmOrder = document.getElementById("confirm-order");
  const confirmMto = document.getElementById("confirm-mto");
  const confirmReceipt = document.getElementById("confirm-receipt");
  const announcer = document.getElementById("cart-announcer");
  // The server leaves the cart and checkout markup out when checkout is off.
  const shopOnly = !modal;
  const US_STATES = new Set(
    "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP".split(
      " "
    )
  );
  const ZIP_RE = /^\d{5}(-\d{4})?$/;

  let config = null;
  const CHECKOUT_OFF_FALLBACK =
    "Online ordering opens soon. Message us at packmulehouse@gmail.com to order.";
  let shippingCents = 1000;
  let shippingPhrase = "$10 flat-rate shipping";
  let taxInfo = {
    mode: "included",
    included: true,
    chargesTax: false,
    percent: 6,
    name: "Sales Tax",
    appliesToShipping: true,
    label: "Included",
    note: "Prices include tax",
  };
  /** Square catalog promos (display only; amounts from /api/quote) */
  let discountInfo = { promos: [], summary: "" };
  let mtoInfo = {
    open: true,
    promise: "Ships within 1 week (all items together)",
  };
  /**
   * Totals for display. Prefer instant local estimate from Square promo list;
   * optional Square CalculateOrder only to confirm (cart open / checkout).
   */
  let quote = null; // last server quote (authoritative when present)
  let quoteSeq = 0;
  let productsById = new Map();
  let variationsById = new Map();
  let card = null;
  let payments = null;
  let paymentRequest = null;
  let payInFlight = false;
  const wallets = { applePay: null, googlePay: null, cashAppPay: null, giftCard: null };
  let cashAppRef = "";
  // Square freezes these objects, so a marker property throws and used to abort
  // gift-card setup. Track listeners here instead of on the SDK instance.
  const cashAppBound = new WeakSet();
  const walletClickBound = new Set();
  let lastFocus = null;
  /** Reused when a pay request never gets a response, so Square is not charged twice. */
  let checkoutAttempt = null;
  /** @type {{ variationId: string, quantity: number }[]} */
  let cart = loadCart();
  let toastTimer = null;

  function phraseFromCents(cents) {
    const amount = Math.round(Number(cents) || 0);
    const dollars = amount / 100;
    const text = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
    return `${text} flat-rate shipping`;
  }

  function syncShippingCopy() {
    const phrase = shippingPhrase || phraseFromCents(shippingCents);
    const label = document.getElementById("cart-shipping-label");
    if (label) label.textContent = phrase;
    const note = document.getElementById("shipping-note");
    if (note) note.textContent = `${phrase} on US orders`;
  }

  function moneyLabel(amountCents, currency) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: currency || "USD",
      }).format((amountCents || 0) / 100);
    } catch {
      return `$${((amountCents || 0) / 100).toFixed(2)}`;
    }
  }

  function loadCart() {
    try {
      const raw = localStorage.getItem(CART_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((l) => l && l.variationId)
        .map((l) => ({
          variationId: String(l.variationId),
          quantity: Math.max(1, Math.min(20, Number(l.quantity) || 1)),
        }));
    } catch {
      return [];
    }
  }

  function saveCart() {
    checkoutAttempt = null;
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* ignore */
    }
    updateCartBadge();
  }

  function announce(message) {
    if (!announcer || !message) return;
    announcer.textContent = "";
    announcer.textContent = message;
  }

  function cartCount() {
    return cart.reduce((n, l) => n + l.quantity, 0);
  }

  function cartSubtotalCents() {
    let total = 0;
    for (const line of cart) {
      const v = variationsById.get(line.variationId);
      if (v) total += v.amount * line.quantity;
    }
    return total;
  }

  function cartCurrency() {
    for (const line of cart) {
      const v = variationsById.get(line.variationId);
      if (v) return v.currency || "USD";
    }
    return "USD";
  }

  /** Best volume-style promo from Square catalog list (minItems + percent). */
  function bestLocalPromo() {
    const count = cartCount();
    if (!count) return null;
    const promos = (discountInfo.promos || [])
      .filter((p) => p.minItems != null && p.percent != null)
      .slice()
      .sort((a, b) => a.minItems - b.minItems);
    let best = null;
    for (const p of promos) {
      if (count >= p.minItems) best = p;
    }
    return best;
  }

  /**
   * Instant local estimate (no network). Matches simple Square volume % rules.
   * Complex promos (BOGO, fixed $, time windows) may differ until server quote.
   */
  function localTotals() {
    const currency = cartCurrency();
    const subtotal = cartSubtotalCents();
    if (!cart.length) {
      return {
        subtotal: 0,
        discount: 0,
        discountLabel: null,
        shipping: 0,
        tax: 0,
        taxLabel: taxLabelTextFallback(),
        amount: 0,
        currency,
        local: true,
      };
    }
    const promo = bestLocalPromo();
    const discount = promo
      ? Math.round((subtotal * Number(promo.percent)) / 100)
      : 0;
    const merch = Math.max(0, subtotal - discount);
    const ship = shippingCents;
    const tax = separateTaxCents(merch, ship);
    return {
      subtotal,
      discount,
      discountLabel: promo
        ? promo.name || `${promo.percent}% off ${promo.minItems}+ items`
        : null,
      shipping: ship,
      tax,
      taxLabel: chargesTaxNow() ? taxLabelTextFallback() : null,
      taxNote: pricesIncludeTax() ? taxInfo.note || "Prices include tax" : "",
      amount: merch + ship + tax,
      currency,
      local: true,
    };
  }

  function pricesIncludeTax() {
    return taxInfo.mode !== "added";
  }

  function chargesTaxNow() {
    return taxInfo.mode === "added" && Number(taxInfo.percent) > 0;
  }

  function separateTaxCents(merch, ship) {
    if (!chargesTaxNow()) return 0;
    const taxBase = merch + (taxInfo.appliesToShipping !== false ? ship : 0);
    return Math.round((taxBase * Number(taxInfo.percent)) / 100);
  }

  function syncTaxNote() {
    const note = document.getElementById("prices-tax-note");
    if (!note) return;
    const show = pricesIncludeTax();
    note.hidden = !show;
    if (show) note.textContent = taxInfo.note || "Prices include tax";
  }

  function taxLabelTextFallback() {
    const name = taxInfo.name || "Sales Tax";
    const label = taxInfo.label || `${taxInfo.percent || 0}%`;
    return `${name} (${label})`;
  }

  /** Display totals: prefer last matching server quote, else local. */
  function displayTotals() {
    const local = localTotals();
    if (!cart.length) return local;
    // Use server quote only if it still matches current cart item count + subtotal
    if (
      quote &&
      quote.itemCount === cartCount() &&
      quote.subtotal === local.subtotal
    ) {
      return {
        subtotal: quote.subtotal,
        discount: quote.discount || 0,
        discountLabel: quote.discountLabel || null,
        shipping: quote.shipping != null ? quote.shipping : shippingCents,
        tax: chargesTaxNow() ? quote.tax || 0 : 0,
        taxLabel: chargesTaxNow() ? quote.taxLabel || taxLabelTextFallback() : null,
        taxNote: pricesIncludeTax() ? quote.taxNote || taxInfo.note || "Prices include tax" : "",
        amount: quote.amount,
        currency: quote.currency || local.currency,
        local: false,
      };
    }
    return local;
  }

  function cartDiscountCents() {
    return displayTotals().discount || 0;
  }

  function discountLabelText() {
    return displayTotals().discountLabel || "Discount";
  }

  function cartTaxCents() {
    return displayTotals().tax || 0;
  }

  function cartGrandTotalCents() {
    return displayTotals().amount || 0;
  }

  function taxLabelText() {
    return displayTotals().taxLabel || taxLabelTextFallback();
  }

  /**
   * Confirm totals with Square (network). Used on cart open / checkout, not every click.
   */
  async function refreshQuote() {
    if (!cart.length) {
      quote = null;
      return null;
    }
    const seq = ++quoteSeq;
    const snapSub = cartSubtotalCents();
    const snapCount = cartCount();
    try {
      const res = await fetch("/api/quote", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: cart.map((l) => ({
            variationId: l.variationId,
            quantity: l.quantity,
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      // Ignore stale responses if cart changed mid-flight
      if (seq !== quoteSeq) return null;
      if (!res.ok || data.error) {
        console.warn("quote failed", data.error || res.status);
        return null;
      }
      // Only adopt if still matches cart
      if (cartSubtotalCents() === snapSub && cartCount() === snapCount) {
        quote = data;
      }
      return data;
    } catch (e) {
      console.warn("quote error", e);
      return null;
    }
  }

  /** Instant UI update; optional background Square confirm. */
  function scheduleQuoteAndRender(opts) {
    const confirm = !!(opts && opts.confirm);
    // Always paint immediately from local promo math
    renderCartLines();
    if (panelPay && !panelPay.hidden) renderPaySummary();
    if (!confirm || !cart.length) return;
    // Soft confirm with Square (does not block UI)
    refreshQuote().then(() => {
      renderCartLines();
      if (panelPay && !panelPay.hidden) renderPaySummary();
    });
  }

  function updateCartBadge() {
    if (!cartBadge) return;
    const n = cartCount();
    cartBadge.textContent = String(n);
    cartBadge.dataset.count = String(n);
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
  }

  function setStatus(message, type) {
    payStatus.textContent = message || "";
    payStatus.classList.remove("error", "success");
    if (type) payStatus.classList.add(type);
  }

  function loadSquareSdk(environment) {
    const src =
      environment === "production"
        ? "https://web.squarecdn.com/v1/square.js"
        : "https://sandbox.web.squarecdn.com/v1/square.js";

    return new Promise((resolve, reject) => {
      if (window.Square) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load Square Web Payments SDK"));
      document.head.appendChild(s);
    });
  }

  function indexCatalog(products) {
    productsById = new Map();
    variationsById = new Map();
    for (const p of products) {
      productsById.set(p.id, p);
      for (const v of p.variations || []) {
        variationsById.set(v.id, {
          ...v,
          productId: p.id,
          productName: p.name,
          lowStock: v.lowStock != null ? v.lowStock : null,
          availability: v.availability || p.availability,
          trackInventory:
            v.trackInventory != null ? v.trackInventory : p.trackInventory,
          maxQty: v.maxQty != null ? v.maxQty : p.maxQty,
        });
      }
    }
    cart = cart.filter((l) => variationsById.has(l.variationId));
    // Cap cart lines to current max (stock + MTO)
    for (const line of cart) {
      const max = lineMaxQty(variationsById.get(line.variationId));
      if (line.quantity > max) line.quantity = Math.max(1, max);
      if (max <= 0) {
        cart = cart.filter((l) => l.variationId !== line.variationId);
      }
    }
    saveCart();
  }

  function lineMaxQty(variation) {
    if (!variation) return 20;
    if (variation.maxQty != null) return Math.max(0, variation.maxQty);
    return 20;
  }

  /**
   * When an item's variations (sizes, styles) have different prices, return
   * the lowest one so the card can say "Starting at $22.00". Null when every
   * variation costs the same.
   */
  /**
   * One sentence per line, and the email as a mailto link that never breaks,
   * so the notice wraps cleanly on narrow cards.
   */
  function fillCheckoutOffNote(el, message) {
    // Split only where punctuation is followed by a space, so the dot in
    // an email address stays put.
    const sentences = String(message).split(/(?<=[.!?])\s+/).filter(Boolean);
    for (const sentence of sentences) {
      const line = document.createElement("span");
      const text = sentence.trim();
      const m = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
      if (m) {
        const a = document.createElement("a");
        a.href = `mailto:${m[0]}`;
        a.textContent = m[0];
        line.append(text.slice(0, m.index), a, text.slice(m.index + m[0].length));
      } else {
        line.textContent = text;
      }
      el.appendChild(line);
    }
  }

  function priceRange(product) {
    const amounts = (product.variations || [])
      .map((v) => Number(v.amount))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (new Set(amounts).size < 2) return null;
    const min = Math.min(...amounts);
    const cheapest = product.variations.find((v) => Number(v.amount) === min);
    const currency = cheapest?.currency || "USD";
    const label =
      cheapest?.priceLabel ||
      new Intl.NumberFormat("en-US", { style: "currency", currency }).format(min / 100);
    return { min, label };
  }

  function addToCart(product, quantity) {
    const variation =
      product.variations.find((v) => v.id === product.defaultVariationId) ||
      product.variations[0];
    if (!variation) {
      showToast("This product can’t be added right now.");
      return;
    }

    const max = lineMaxQty({
      ...variation,
      maxQty: product.maxQty,
      trackInventory: variation.trackInventory ?? product.trackInventory,
    });

    if (max <= 0) {
      showToast(
        mtoInfo.open
          ? "Unavailable right now"
          : "Unavailable (made-to-order on standby)"
      );
      return;
    }

    const qty = Math.max(1, Math.min(max, quantity || 1));
    const existing = cart.find((l) => l.variationId === variation.id);
    const nextQty = existing ? existing.quantity + qty : qty;

    if (nextQty > max) {
      showToast(`You can order up to ${max}`);
      if (existing) {
        existing.quantity = max;
        saveCart();
      }
      return;
    }

    if (existing) {
      existing.quantity = nextQty;
    } else {
      cart.push({ variationId: variation.id, quantity: qty });
    }
    saveCart();
    scheduleQuoteAndRender();

    const shelf =
      variation.availability === "mto"
        ? 0
        : variation.lowStock != null
          ? variation.lowStock
          : null;
    const mtoPart = shelf == null ? 0 : Math.max(0, nextQty - shelf);
    const added =
      variation.availability === "mto" || mtoPart > 0
        ? `Added ${product.name}${mtoPart ? ` (${mtoPart} made to order)` : " (made to order)"}`
        : `Added ${product.name} to cart`;
    showToast(added);
  }

  function setLineQty(variationId, quantity) {
    const v = variationsById.get(variationId);
    const max = lineMaxQty(v);
    let qty = Math.max(0, Math.min(max || 0, Number(quantity) || 0));
    if (v && quantity > max) showToast(`You can order up to ${max}`);
    if (qty <= 0) {
      cart = cart.filter((l) => l.variationId !== variationId);
      announce("Item removed from cart");
    } else {
      const line = cart.find((l) => l.variationId === variationId);
      if (line) line.quantity = qty;
      announce(`Quantity ${qty}`);
    }
    saveCart();
    scheduleQuoteAndRender();
  }

  function cartMtoUnits() {
    const local = localTotals();
    if (
      quote &&
      quote.itemCount === cartCount() &&
      quote.subtotal === local.subtotal &&
      quote.mtoUnits != null
    ) {
      return quote.mtoUnits;
    }
    let n = 0;
    for (const line of cart) {
      const v = variationsById.get(line.variationId);
      if (!v || !v.trackInventory) continue;
      if (v.availability === "mto") n += line.quantity;
      else if (v.lowStock != null) n += Math.max(0, line.quantity - v.lowStock);
    }
    return n;
  }

  function cartHasMto() {
    return cartMtoUnits() > 0;
  }

  function lineIsMto(line, variation) {
    if (!variation?.trackInventory) return false;
    if (variation.availability === "mto") return true;
    return variation.lowStock != null && line.quantity > variation.lowStock;
  }

  /**
   * Same wording as src/payments.js mtoConfirmationLine.
   * "1 item is made to order." / "2 items are made to order."
   */
  function mtoConfirmationLine(count, lead) {
    const n = Math.max(0, Math.round(Number(count) || 0));
    const sentence = n === 1 ? "1 item is made to order." : `${n} items are made to order.`;
    const extra = String(lead || "").trim();
    return extra ? `${sentence} ${extra}` : sentence;
  }

  function mtoBanner() {
    const banner = document.createElement("div");
    banner.className = "mto-banner";
    const count = cartMtoUnits();
    const labels = cartMtoLabels();
    const countText = `${count} made-to-order unit${count === 1 ? "" : "s"}.`;
    banner.textContent = labels.length ? `${countText} ${labels.join(" ")}` : countText;
    return banner;
  }

  function cartMtoLabels() {
    const labels = [];
    for (const line of cart) {
      const v = variationsById.get(line.variationId);
      if (!lineIsMto(line, v)) continue;
      const label = v.leadTimeLabel || "Made to order: ships in about 1 week";
      if (!labels.includes(label)) labels.push(label);
    }
    return labels;
  }

  function removeLine(variationId) {
    cart = cart.filter((l) => l.variationId !== variationId);
    announce("Item removed from cart");
    saveCart();
    scheduleQuoteAndRender();
  }

  function renderCatalog(products, sections) {
    const heading = document.getElementById("products-heading");
    const mount = document.getElementById("product-mount");
    const list = products || [];
    if (Array.isArray(sections)) {
      if (heading) heading.hidden = true;
      if (!mount) return;
      mount.replaceChildren();
      if (!sections.length) {
        const status = document.createElement("div");
        status.className = "products-status";
        status.textContent = "No products in the shop categories yet.";
        mount.appendChild(status);
        return;
      }
      sections.forEach((section, index) => {
        const block = document.createElement("section");
        block.className = "product-section";
        const h2 = document.createElement("h2");
        h2.id = `shop-category-${index}`;
        h2.textContent = section.name || "";
        block.setAttribute("aria-labelledby", h2.id);
        const gridEl = document.createElement("div");
        gridEl.className = "product-grid";
        block.append(h2, gridEl);
        mount.appendChild(block);
        fillProductGrid(gridEl, section.products || []);
      });
      return;
    }
    if (heading) heading.hidden = false;
    const target = mount || grid;
    if (mount) {
      mount.replaceChildren();
      const gridEl = document.createElement("div");
      gridEl.className = "product-grid";
      gridEl.id = "product-grid";
      mount.appendChild(gridEl);
      fillProductGrid(gridEl, list);
      return;
    }
    fillProductGrid(target, list);
  }

  function fillProductGrid(target, products) {
    if (!products.length) {
      target.replaceChildren();
      const status = document.createElement("div");
      status.className = "products-status";
      status.textContent = "No products found in the Square catalog yet.";
      target.appendChild(status);
      return;
    }

    target.replaceChildren();

    for (const p of products) {
      const variation =
        p.variations.find((v) => v.id === p.defaultVariationId) || p.variations[0];
      const unavailable = p.availability === "unavailable" || (p.maxQty || 0) <= 0;

      const article = document.createElement("article");
      article.className = "product-card";

      const image = document.createElement("div");
      image.className = "product-image";
      if (p.imageUrl) {
        const img = document.createElement("img");
        img.src = p.imageUrl;
        img.alt = p.name;
        img.loading = "lazy";
        image.appendChild(img);
      } else {
        const ph = document.createElement("div");
        ph.className = "product-image-placeholder";
        ph.textContent = p.name;
        image.appendChild(ph);
      }

      const body = document.createElement("div");
      body.className = "product-body";

      const h3 = document.createElement("h3");
      h3.textContent = p.name;

      const desc = document.createElement("p");
      desc.textContent = p.description || "Designed and made by Pack Mule House.";

      const footer = document.createElement("div");
      footer.className = "product-footer";

      const price = document.createElement("div");
      price.className = "product-price";
      const range = priceRange(p);
      if (range) {
        const from = document.createElement("span");
        from.className = "price-from";
        from.textContent = "Starting at";
        price.append(from, range.label);
      } else {
        price.textContent = p.priceLabel;
      }
      if (pricesIncludeTax()) {
        const note = document.createElement("span");
        note.className = "tax-note";
        note.textContent = taxInfo.note || "Prices include tax";
        price.appendChild(note);
      }
      const shipNote = document.createElement("span");
      shipNote.className = "product-ship";
      shipNote.textContent = `${shippingPhrase || phraseFromCents(shippingCents)} on US orders`;
      price.appendChild(shipNote);

      const actions = document.createElement("div");
      actions.className = "product-actions";

      let pickQty = 1;
      const maxQty = Math.max(1, p.maxQty || 20);

      const qty = document.createElement("div");
      qty.className = "qty-controls";
      qty.setAttribute("aria-label", `Quantity for ${p.name}`);

      const qtyLabel = document.createElement("span");
      qtyLabel.textContent = "1";

      const minus = document.createElement("button");
      minus.type = "button";
      minus.setAttribute("aria-label", "Decrease quantity");
      minus.textContent = "−";
      minus.disabled = unavailable;
      minus.addEventListener("click", () => {
        pickQty = Math.max(1, pickQty - 1);
        qtyLabel.textContent = String(pickQty);
        announce(`Quantity ${pickQty} for ${p.name}`);
      });

      const plus = document.createElement("button");
      plus.type = "button";
      plus.setAttribute("aria-label", "Increase quantity");
      plus.textContent = "+";
      plus.disabled = unavailable;
      plus.addEventListener("click", () => {
        pickQty = Math.min(maxQty, pickQty + 1);
        qtyLabel.textContent = String(pickQty);
        announce(`Quantity ${pickQty} for ${p.name}`);
      });

      qty.append(minus, qtyLabel, plus);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-primary btn-sm";
      btn.textContent = unavailable
        ? "Unavailable"
        : p.availability === "mto"
          ? "Order (made to order)"
          : "Add to cart";
      btn.disabled = unavailable;
      btn.addEventListener("click", () => addToCart(p, pickQty));

      if (config && config.checkoutEnabled === false) {
        const note = document.createElement("p");
        note.className = "checkout-off-note";
        fillCheckoutOffNote(note, config.checkoutOffMessage || CHECKOUT_OFF_FALLBACK);
        actions.append(note);
      } else {
        actions.append(qty, btn);
      }
      footer.append(price, actions);
      body.append(h3, desc, footer);

      // FOMO / MTO label only when server provides stockDisplay
      if (p.stockDisplay) {
        const stock = document.createElement("div");
        stock.className =
          "product-stock" + (p.stockTone ? ` ${p.stockTone}` : "");
        stock.textContent =
          p.stockTone === "mto"
            ? p.leadTimeLabel || "Made to order: ships in about 1 week"
            : p.stockDisplay;
        body.appendChild(stock);
      }

      article.append(image, body);
      target.appendChild(article);
    }
  }

  function renderCartLines() {
    syncShippingCopy();
    cartLinesEl.innerHTML = "";
    const currency = cartCurrency();
    const sub = cartSubtotalCents();
    const grand = cartGrandTotalCents();
    cartSubtotalEl.textContent = moneyLabel(sub, currency);
    const disc = cart.length ? cartDiscountCents() : 0;
    if (cartDiscountRow) {
      cartDiscountRow.hidden = disc <= 0;
      if (cartDiscountLabelEl) cartDiscountLabelEl.textContent = discountLabelText();
      if (cartDiscountEl) cartDiscountEl.textContent = `−${moneyLabel(disc, currency)}`;
    }
    cartShippingEl.textContent = cart.length
      ? moneyLabel(shippingCents, currency)
      : moneyLabel(0, currency);
    const taxRow = document.getElementById("cart-tax-row");
    const showTax = chargesTaxNow();
    if (taxRow) taxRow.hidden = !showTax;
    if (showTax) {
      if (cartTaxLabelEl) cartTaxLabelEl.textContent = taxLabelText();
      if (cartTaxEl) {
        cartTaxEl.textContent = moneyLabel(
          cart.length ? cartTaxCents() : 0,
          currency
        );
      }
    } else {
      if (cartTaxLabelEl) cartTaxLabelEl.textContent = "";
      if (cartTaxEl) cartTaxEl.textContent = "";
    }
    const cartTaxNote = document.getElementById("cart-tax-note");
    if (cartTaxNote) {
      cartTaxNote.hidden = !pricesIncludeTax();
      if (pricesIncludeTax()) cartTaxNote.textContent = taxInfo.note || "Prices include tax";
    }
    cartTotalEl.textContent = moneyLabel(cart.length ? grand : 0, currency);

    if (!cart.length) {
      const empty = document.createElement("p");
      empty.className = "cart-empty";
      empty.textContent = "Your cart is empty. Add an X-Frame kit from the shop.";
      cartLinesEl.appendChild(empty);
      cartCheckoutBtn.disabled = true;
      return;
    }

    if (cartHasMto()) {
      cartLinesEl.appendChild(mtoBanner());
    }

    cartCheckoutBtn.disabled = false;

    for (const line of cart) {
      const v = variationsById.get(line.variationId);
      if (!v) continue;

      const row = document.createElement("div");
      row.className = "cart-line";

      const name = document.createElement("div");
      name.className = "cart-line-name";
      name.textContent = v.productName;

      const linePrice = document.createElement("div");
      linePrice.className = "cart-line-price";
      linePrice.textContent = moneyLabel(v.amount * line.quantity, v.currency);

      const meta = document.createElement("div");
      meta.className = "cart-line-meta";

      const qty = document.createElement("div");
      qty.className = "qty-controls";

      const minus = document.createElement("button");
      minus.type = "button";
      minus.setAttribute("aria-label", "Decrease quantity");
      minus.textContent = "−";
      minus.addEventListener("click", () =>
        setLineQty(line.variationId, line.quantity - 1)
      );

      const qtyLabel = document.createElement("span");
      qtyLabel.textContent = String(line.quantity);

      const plus = document.createElement("button");
      plus.type = "button";
      plus.setAttribute("aria-label", "Increase quantity");
      plus.textContent = "+";
      plus.addEventListener("click", () =>
        setLineQty(line.variationId, line.quantity + 1)
      );

      qty.append(minus, qtyLabel, plus);

      const unit = document.createElement("span");
      unit.style.color = "var(--text-muted)";
      unit.style.fontSize = "0.85rem";
      unit.textContent = `${moneyLabel(v.amount, v.currency)} each`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "cart-line-remove";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => removeLine(line.variationId));

      meta.append(qty, unit, remove);
      row.append(name, linePrice, meta);
      cartLinesEl.appendChild(row);
    }
  }

  function summaryRow(label, value, className) {
    const row = document.createElement("div");
    row.className = "modal-summary-row" + (className ? ` ${className}` : "");
    const left = document.createElement("span");
    left.textContent = label;
    const right = document.createElement("span");
    right.textContent = value;
    row.append(left, right);
    return row;
  }

  function renderPaySummary() {
    const currency = cartCurrency();
    paySummary.replaceChildren();

    for (const line of cart) {
      const v = variationsById.get(line.variationId);
      if (!v) continue;
      let label = `${v.productName} × ${line.quantity}`;
      if (v.trackInventory && v.availability === "mto") label += " (made to order)";
      else if (v.trackInventory && v.lowStock != null && line.quantity > v.lowStock) {
        label += ` (${line.quantity - v.lowStock} MTO)`;
      }
      paySummary.appendChild(
        summaryRow(label, moneyLabel(v.amount * line.quantity, v.currency))
      );
    }

    const disc = cartDiscountCents();
    if (disc > 0) {
      paySummary.appendChild(
        summaryRow(discountLabelText(), `−${moneyLabel(disc, currency)}`)
      );
    }
    paySummary.appendChild(
      summaryRow(shippingPhrase || phraseFromCents(shippingCents), moneyLabel(shippingCents, currency))
    );
    if (chargesTaxNow()) {
      paySummary.appendChild(
        summaryRow(taxLabelText(), moneyLabel(cartTaxCents(), currency))
      );
    }
    paySummary.appendChild(
      summaryRow("Total", moneyLabel(cartGrandTotalCents(), currency), "total")
    );
    if (pricesIncludeTax()) {
      const note = document.createElement("p");
      note.className = "tax-note";
      note.textContent = taxInfo.note || "Prices include tax";
      paySummary.appendChild(note);
    }

    if (cartHasMto()) {
      const banner = mtoBanner();
      banner.style.marginTop = "0.75rem";
      banner.style.marginBottom = "0";
      paySummary.appendChild(banner);
    }

    const count = cartCount();
    const promos = (discountInfo.promos || [])
      .filter((p) => p.minItems != null && p.percent != null)
      .slice()
      .sort((a, b) => a.minItems - b.minItems);
    const next = promos.find((p) => p.minItems > count);
    if (next) {
      const need = next.minItems - count;
      const hint = document.createElement("p");
      hint.className = "field-hint";
      hint.style.marginTop = "0.65rem";
      hint.textContent = `Add ${need} more item${need === 1 ? "" : "s"} for ${next.percent}% off (Square promo)`;
      paySummary.appendChild(hint);
    }
  }

  function focusableIn(root) {
    return [...root.querySelectorAll(
      "a[href], button:not([disabled]), input:not([disabled]), select, textarea, iframe, [tabindex]:not([tabindex='-1'])"
    )].filter((el) => !el.closest("[hidden]"));
  }

  function openModal(step) {
    lastFocus = document.activeElement;
    modal.hidden = false;
    requestAnimationFrame(() => {
      modal.classList.add("open");
      // The overlay stays visibility:hidden until .open is painted.
      requestAnimationFrame(() => {
        const closeBtn = document.getElementById("checkout-close");
        (closeBtn || modal).focus();
      });
    });
    document.body.style.overflow = "hidden";
    if (step === "pay") showPayStep();
    else showCartStep();
  }

  function closeModal() {
    modal.classList.remove("open");
    document.body.style.overflow = "";
    const returnTo = lastFocus;
    setTimeout(() => {
      modal.hidden = true;
      if (returnTo && typeof returnTo.focus === "function") returnTo.focus();
    }, 200);
  }

  async function showCartStep() {
    panelCart.hidden = false;
    panelPay.hidden = true;
    if (panelConfirm) panelConfirm.hidden = true;
    checkoutTitle.textContent = "Your cart";
    checkoutSubtitle.textContent =
      discountInfo.summary &&
      discountInfo.summary !== "None" &&
      !String(discountInfo.summary).startsWith("None")
        ? discountInfo.summary
        : "Add kits, then checkout when you’re ready";
    setStatus("");
    // Instant totals first, then confirm with Square in background
    scheduleQuoteAndRender({ confirm: true });
  }

  async function showPayStep() {
    if (!cart.length) {
      showCartStep();
      return;
    }
    panelCart.hidden = true;
    panelPay.hidden = false;
    if (panelConfirm) panelConfirm.hidden = true;
    checkoutTitle.textContent = "Checkout";
    checkoutSubtitle.textContent = `${shippingPhrase || phraseFromCents(shippingCents)} · US addresses`;
    setStatus("");
    setPayBusy(false);
    if (sandboxHint) {
      sandboxHint.hidden = config?.environment === "production";
    }
    renderPaySummary();
    try {
      await refreshQuote();
    } catch {
      /* local totals stay on screen */
    }
    renderPaySummary();
    const nameField = document.getElementById("ship-name");
    if (nameField) nameField.focus();

    try {
      await ensureCard();
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Could not load card form", "error");
    }
    try {
      await mountWallets();
    } catch (e) {
      console.info("wallet setup skipped", e?.message || e);
    }
  }

  async function ensurePayments() {
    if (!window.Square) throw new Error("Square.js is not loaded");
    if (!payments) {
      payments = window.Square.payments(config.applicationId, config.locationId);
    }
    return payments;
  }

  function ensureAttempt() {
    const signature = cartSignature();
    if (!checkoutAttempt || checkoutAttempt.signature !== signature) {
      checkoutAttempt = {
        id: crypto.randomUUID(),
        signature,
        method: null,
        sourceId: null,
        verificationToken: null,
        submitted: false,
        networkRetry: false,
      };
    }
    return checkoutAttempt;
  }

  async function ensureCard() {
    await ensurePayments();
    if (card) {
      try {
        await card.destroy();
      } catch {
        /* ignore */
      }
      card = null;
    }
    const container = document.getElementById("card-container");
    container.innerHTML = "";

    const cardStyle = {
      ".input-container": { borderColor: "#2a2a2a", borderRadius: "10px" },
      ".input-container.is-focus": { borderColor: "#5c8a8a" },
      ".input-container.is-error": { borderColor: "#e07070" },
      // Helper copy such as "Enter the zip code" stays invisible. Real
      // validation uses .is-error ("Enter a valid ZIP code") and stays visible.
      ".message-text": { color: "transparent" },
      ".message-icon": { color: "transparent" },
      ".message-text.is-error": { color: "#e07070" },
      ".message-icon.is-error": { color: "#e07070" },
      input: {
        backgroundColor: "#1c1c1c",
        color: "#eae6dc",
        fontFamily: "helvetica neue, sans-serif",
      },
      "input::placeholder": { color: "#6b675f" },
      "input.is-error": { color: "#e07070" },
    };

    try {
      card = await payments.card({ style: cardStyle });
      await card.attach("#card-container");
      bindCardField(card);
    } catch (styleErr) {
      console.warn("Styled card form failed, falling back:", styleErr);
      try {
        if (card) await card.destroy();
      } catch {
        /* ignore */
      }
      card = await payments.card();
      await card.attach("#card-container");
      bindCardField(card);
    }
  }

  function bindCardField(instance) {
    const clearStale = () => {
      if (payStatus.classList.contains("error")) setStatus("");
    };
    try {
      instance.addEventListener("errorClassRemoved", clearStale);
      instance.addEventListener("focusClassAdded", clearStale);
    } catch {
      /* older SDK builds omit these events */
    }
  }

  function setPayBusy(busy) {
    payInFlight = busy;
    if (payButton) payButton.disabled = busy;
    const giftBtn = document.getElementById("gift-card-pay");
    if (giftBtn) giftBtn.disabled = busy;
    const back = document.getElementById("pay-back-btn");
    if (back) back.disabled = busy;
    const walletsEl = document.getElementById("wallet-buttons");
    if (walletsEl) {
      walletsEl.classList.toggle("is-busy", busy);
      walletsEl.setAttribute("aria-disabled", busy ? "true" : "false");
    }
    const giftField = document.getElementById("gift-card-field");
    if (giftField) giftField.classList.toggle("is-busy", busy);
    if (form) form.setAttribute("aria-busy", busy ? "true" : "false");
  }

  /** Card payments need verifyBuyer. Wallets and gift cards verify inside the SDK. */
  function methodNeedsBuyerVerification(method) {
    return method === "card";
  }

  function tokenFromResult(result, fallback) {
    if (result?.status === "OK" && result.token) return result.token;
    const detail = result?.errors
      ? result.errors.map((e) => e.message).join(" ")
      : result?.status;
    throw new Error(detail || fallback || "Payment could not be started.");
  }

  async function tokenize() {
    if (!card) throw new Error("Card form is not ready. Go back and try again.");
    return tokenFromResult(await card.tokenize(), "Card tokenization failed");
  }

  function paymentRequestDetails() {
    const totals = displayTotals();
    return {
      countryCode: "US",
      currencyCode: totals.currency || "USD",
      total: {
        amount: ((totals.amount || 0) / 100).toFixed(2),
        label: "Total",
      },
    };
  }

  async function syncPaymentRequest() {
    await ensurePayments();
    const details = paymentRequestDetails();
    if (!paymentRequest) {
      paymentRequest = payments.paymentRequest(details);
      return paymentRequest;
    }
    if (typeof paymentRequest.update === "function") {
      paymentRequest.update(details);
    }
    return paymentRequest;
  }

  function syncWalletChrome() {
    const ids = ["apple-pay-button", "google-pay-button", "cash-app-button"];
    const anyWallet = ids.some((id) => {
      const el = document.getElementById(id);
      return el && !el.hidden;
    });
    const gift = document.getElementById("gift-card-field");
    const any = anyWallet || (gift && !gift.hidden);
    const divider = document.getElementById("pay-divider");
    if (divider) divider.hidden = !any;
  }

  function bindWalletClick(key, el) {
    if (!el || walletClickBound.has(key)) return;
    walletClickBound.add(key);
    el.addEventListener("click", (event) => {
      event.preventDefault();
      startWalletPay(key);
    });
  }

  function bindCashApp(method) {
    if (!method || cashAppBound.has(method)) return;
    method.addEventListener("ontokenization", (event) => {
      const { tokenResult, error } = event.detail || {};
      if (payInFlight) return;
      if (error || tokenResult?.status !== "OK" || !tokenResult.token) {
        setStatus(error?.message || "Cash App Pay could not be completed.", "error");
        return;
      }
      payWithSource(tokenResult.token, "cashapp");
    });
    cashAppBound.add(method);
  }

  async function mountOne(key, selector, factory) {
    const el = document.querySelector(selector);
    if (!el) return;
    if (wallets[key]) {
      el.hidden = false;
      return;
    }
    try {
      const method = await factory();
      if (!method) throw new Error("unavailable");
      await method.attach(selector);
      wallets[key] = method;
      el.hidden = false;
      if (key !== "cashAppPay") bindWalletClick(key, el);
    } catch (e) {
      console.info(`${key} unavailable`, e?.name || e?.message || e);
      el.hidden = true;
      wallets[key] = null;
    }
  }

  async function mountDigitalWallets() {
    await syncPaymentRequest();
    const attempt = ensureAttempt();
    if (wallets.cashAppPay && cashAppRef !== attempt.id) {
      try {
        await wallets.cashAppPay.destroy();
      } catch {
        /* ignore */
      }
      wallets.cashAppPay = null;
      const cashEl = document.getElementById("cash-app-button");
      if (cashEl) cashEl.replaceChildren();
    }
    await mountOne("applePay", "#apple-pay-button", () => payments.applePay(paymentRequest));
    await mountOne("googlePay", "#google-pay-button", () => payments.googlePay(paymentRequest));
    await mountOne("cashAppPay", "#cash-app-button", () =>
      payments.cashAppPay(paymentRequest, {
        redirectURL: `${window.location.origin}${window.location.pathname}`,
        referenceId: attempt.id.slice(0, 40),
      })
    );
    if (!wallets.cashAppPay) return;
    cashAppRef = attempt.id;
    try {
      bindCashApp(wallets.cashAppPay);
    } catch (e) {
      console.info("cashAppPay listener skipped", e?.name || e?.message || e);
    }
  }

  async function mountWallets() {
    try {
      await ensurePayments();
    } catch (e) {
      console.info("payments unavailable", e?.name || e?.message || e);
      return;
    }
    try {
      await mountDigitalWallets();
    } catch (e) {
      console.info("digital wallets skipped", e?.name || e?.message || e);
    }
    try {
      await mountGiftCard();
    } catch (e) {
      console.info("gift card unavailable", e?.name || e?.message || e);
    }
    try {
      syncWalletChrome();
    } catch (e) {
      console.info("wallet chrome skipped", e?.name || e?.message || e);
    }
  }

  async function mountGiftCard() {
    const field = document.getElementById("gift-card-field");
    if (!field || wallets.giftCard) {
      if (field && wallets.giftCard) field.hidden = false;
      return;
    }
    try {
      const giftCard = await payments.giftCard();
      await giftCard.attach("#gift-card-container");
      wallets.giftCard = giftCard;
      field.hidden = false;
    } catch (e) {
      console.info("gift card unavailable", e?.name || e?.message || e);
      field.hidden = true;
    }
  }

  async function startWalletPay(key) {
    const method = wallets[key];
    if (!method || payInFlight) return;
    const shippingError = validateShipping(readShipping());
    if (shippingError) {
      setStatus(shippingError, "error");
      document.getElementById("ship-name")?.focus();
      return;
    }
    setPayBusy(true);
    try {
      setStatus("Confirming total…");
      const quoted = await fetchAuthoritativeQuote();
      renderPaySummary();
      await syncPaymentRequest();
      setStatus("Processing payment…");
      const token = tokenFromResult(await method.tokenize());
      await payWithSource(token, key, { quoted, continueBusy: true });
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Payment could not be completed. Please try again.", "error");
      setPayBusy(false);
    }
  }

  async function verifyBuyer(token, amountCents, currency) {
    const details = {
      amount: (amountCents / 100).toFixed(2),
      currencyCode: currency || "USD",
      intent: "CHARGE",
      billingContact: {
        email: document.getElementById("ship-email").value.trim() || undefined,
        givenName: document.getElementById("ship-name").value.trim() || undefined,
      },
    };
    try {
      const verification = await payments.verifyBuyer(token, details);
      return verification?.token || undefined;
    } catch (e) {
      console.warn("verifyBuyer skipped:", e);
      return undefined;
    }
  }

  function readShipping() {
    return {
      displayName: document.getElementById("ship-name").value.trim(),
      email: document.getElementById("ship-email").value.trim(),
      phone: document.getElementById("ship-phone").value.trim(),
      addressLine1: document.getElementById("ship-line1").value.trim(),
      addressLine2: document.getElementById("ship-line2").value.trim(),
      city: document.getElementById("ship-city").value.trim(),
      state: document.getElementById("ship-state").value.trim().toUpperCase(),
      postalCode: document.getElementById("ship-postal").value.trim(),
      country: "US",
    };
  }

  function validateShipping(shipping) {
    if (
      !shipping.displayName ||
      !shipping.email ||
      !shipping.addressLine1 ||
      !shipping.city
    ) {
      return "Please fill in all required shipping fields.";
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(shipping.email)) {
      return "Enter a valid email address.";
    }
    if (shipping.country !== "US") return "We only ship to US addresses.";
    if (!US_STATES.has(shipping.state)) return "Enter a 2-letter US state code.";
    if (!ZIP_RE.test(shipping.postalCode)) return "Enter a 5-digit ZIP code.";
    return "";
  }

  function cartSignature() {
    return cart.map((l) => `${l.variationId}:${l.quantity}`).join("|");
  }

  async function fetchAuthoritativeQuote() {
    const data = await refreshQuote();
    if (!data || data.amount == null || !data.currency) {
      throw new Error("Could not confirm the order total. Please try again.");
    }
    if (data.itemCount !== cartCount() || data.subtotal !== cartSubtotalCents()) {
      throw new Error("Your cart changed. Review the total and try again.");
    }
    return data;
  }

  function showConfirmation(data, mtoLabels) {
    panelCart.hidden = true;
    panelPay.hidden = true;
    if (panelConfirm) panelConfirm.hidden = false;
    checkoutTitle.textContent = "Order confirmed";
    checkoutSubtitle.textContent = "Keep this reference until your order ships";
    if (confirmMessage) {
      confirmMessage.textContent = data.amountLabel
        ? `${data.amountLabel} paid. Thank you — your order is in.`
        : "Thank you — your order is in.";
    }
    if (confirmOrder) confirmOrder.textContent = data.orderId || "";
    if (confirmMto) {
      if (data.mtoUnits > 0) {
        confirmMto.hidden = false;
        const lead = (mtoLabels && mtoLabels.length ? mtoLabels.join(" ") : "") || data.mtoPromise || "Made to order: ships in about 1 week";
        confirmMto.textContent = mtoConfirmationLine(data.mtoUnits, lead);
      } else {
        confirmMto.hidden = true;
        confirmMto.textContent = "";
      }
    }
    const receiptNote = document.getElementById("confirm-receipt-note");
    if (confirmReceipt) {
      if (data.receiptUrl) {
        confirmReceipt.href = data.receiptUrl;
        confirmReceipt.hidden = false;
        if (receiptNote) {
          const sandbox = config?.environment !== "production";
          receiptNote.hidden = !sandbox;
          receiptNote.textContent = sandbox
            ? "Sandbox receipt previews usually show Square’s page-not-found. Production uses this same link from Square, and those receipts open."
            : "";
        }
      } else {
        confirmReceipt.hidden = true;
        confirmReceipt.removeAttribute("href");
        if (receiptNote) receiptNote.hidden = true;
      }
    }
    setStatus("");
    const done = document.getElementById("confirm-done");
    if (done) done.focus();
    announce("Order confirmed");
  }

  async function resetPaymentMethods() {
    const pending = [];
    const drop = (method) => {
      if (method && typeof method.destroy === "function") {
        pending.push(Promise.resolve(method.destroy()).catch(() => {}));
      }
    };
    drop(card);
    card = null;
    drop(wallets.applePay);
    drop(wallets.googlePay);
    drop(wallets.cashAppPay);
    drop(wallets.giftCard);
    wallets.applePay = null;
    wallets.googlePay = null;
    wallets.cashAppPay = null;
    wallets.giftCard = null;
    cashAppRef = "";
    paymentRequest = null;
    await Promise.all(pending);
    const cardContainer = document.getElementById("card-container");
    if (cardContainer) cardContainer.innerHTML = "";
    const giftContainer = document.getElementById("gift-card-container");
    if (giftContainer) giftContainer.innerHTML = "";
    const giftField = document.getElementById("gift-card-field");
    if (giftField) giftField.hidden = true;
    for (const id of ["apple-pay-button", "google-pay-button", "cash-app-button"]) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.hidden = true;
      el.replaceChildren();
    }
    const divider = document.getElementById("pay-divider");
    if (divider) divider.hidden = true;
  }

  async function payWithSource(sourceId, method, opts) {
    const continueBusy = !!(opts && opts.continueBusy);
    if ((payInFlight && !continueBusy) || !cart.length || !sourceId) return;
    const shipping = readShipping();
    const shippingError = validateShipping(shipping);
    if (shippingError) {
      setStatus(shippingError, "error");
      document.getElementById("ship-name")?.focus();
      if (continueBusy) setPayBusy(false);
      return;
    }

    const attempt = ensureAttempt();
    if (attempt.submitted && attempt.method && attempt.method !== method && !attempt.networkRetry) {
      setStatus("Checkout is already processing. Wait a moment and try again.", "error");
      if (continueBusy) setPayBusy(false);
      return;
    }
    if (attempt.method === method && attempt.sourceId && attempt.networkRetry) {
      sourceId = attempt.sourceId;
    } else {
      attempt.sourceId = sourceId;
      attempt.method = method;
      attempt.verificationToken = null;
    }

    setPayBusy(true);
    const mtoLabels = cartMtoLabels();
    setStatus("Confirming total…");

    try {
      const quoted =
        opts?.quoted && opts.quoted.amount != null ? opts.quoted : await fetchAuthoritativeQuote();
      if (!quoted || quoted.amount == null || !quoted.currency) {
        throw new Error("Could not confirm the order total. Please try again.");
      }
      if (quoted.itemCount !== cartCount() || quoted.subtotal !== cartSubtotalCents()) {
        throw new Error("Your cart changed. Review the total and try again.");
      }
      renderPaySummary();
      // Gift cards and wallets already authenticated the buyer. verifyBuyer on a
      // gift-card token waits on a card challenge that never starts (about 30s)
      // and then continues. Only cards call it.
      if (methodNeedsBuyerVerification(method) && !attempt.verificationToken) {
        setStatus("Verifying your card…");
        attempt.verificationToken = await verifyBuyer(
          attempt.sourceId,
          quoted.amount,
          quoted.currency
        );
      }

      setStatus("Processing payment…");
      let res;
      try {
        attempt.submitted = true;
        res = await fetch("/api/pay", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceId: attempt.sourceId,
            verificationToken: attempt.verificationToken,
            checkoutAttemptId: attempt.id,
            items: cart.map((l) => ({
              variationId: l.variationId,
              quantity: l.quantity,
            })),
            shippingAddress: shipping,
            buyerEmail: shipping.email,
          }),
        });
      } catch (networkErr) {
        console.error(networkErr);
        attempt.networkRetry = true;
        setStatus(
          "Network error. You can try again — this attempt will not be charged twice.",
          "error"
        );
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && /already processing/i.test(data.error || "")) {
        setStatus(data.error, "error");
        return;
      }
      checkoutAttempt = null;
      if (!res.ok || data.error) {
        throw new Error(data.error || "Payment could not be completed. Please try again.");
      }

      cart = [];
      saveCart();
      renderCartLines();
      // Drop the card, gift card, and wallet instances. Shipping fields stay.
      await resetPaymentMethods();
      showConfirmation(data, mtoLabels);

      try {
        const cat = await fetch("/api/catalog").then((r) => r.json());
        if (cat.products) {
          indexCatalog(cat.products);
          renderCatalog(cat.products, cat.sections);
        }
      } catch {
        /* ignore */
      }
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Payment failed", "error");
    } finally {
      setPayBusy(false);
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (!cart.length || !card || payInFlight) return;
    const shippingError = validateShipping(readShipping());
    if (shippingError) {
      setStatus(shippingError, "error");
      return;
    }
    setPayBusy(true);
    try {
      setStatus("Preparing your card…");
      const attempt = ensureAttempt();
      const token =
        attempt.method === "card" && attempt.sourceId && attempt.networkRetry
          ? attempt.sourceId
          : await tokenize();
      await payWithSource(token, "card", { continueBusy: true });
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Payment failed", "error");
      setPayBusy(false);
    }
  }

  async function init() {
    updateCartBadge();

    try {
      const [configRes, catalogRes] = await Promise.all([
        fetch("/api/config"),
        fetch("/api/catalog"),
      ]);

      if (!configRes.ok) throw new Error("Could not load payment config");
      config = await configRes.json();
      shippingCents = Number(config.shippingCents) || 1000;
      if (config.shippingPhrase) shippingPhrase = config.shippingPhrase;
      syncShippingCopy();
      if (config.tax) taxInfo = { ...taxInfo, ...config.tax };
      syncTaxNote();
      if (config.discounts) discountInfo = { ...discountInfo, ...config.discounts };
      if (config.mto) mtoInfo = { ...mtoInfo, ...config.mto };

      const checkoutOn = config.checkoutEnabled !== false && !shopOnly;
      if (!checkoutOn) config.checkoutEnabled = false;
      if (!checkoutOn) {
        const cartBtn = document.getElementById("cart-open");
        if (cartBtn) cartBtn.hidden = true;
      }

      if (checkoutOn && config.environment !== "production" && envBadge) {
        envBadge.hidden = false;
      }

      if (checkoutOn) await loadSquareSdk(config.environment);

      if (!catalogRes.ok) {
        const err = await catalogRes.json().catch(() => ({}));
        throw new Error(err.error || "Could not load catalog");
      }
      const catalog = await catalogRes.json();
      if (catalog.shippingCents != null) {
        shippingCents = Number(catalog.shippingCents) || shippingCents;
      }
      if (catalog.shippingPhrase) shippingPhrase = catalog.shippingPhrase;
      syncShippingCopy();
      if (catalog.tax) taxInfo = { ...taxInfo, ...catalog.tax };
      syncTaxNote();
      if (catalog.discounts) discountInfo = { ...discountInfo, ...catalog.discounts };
      if (catalog.mto) mtoInfo = { ...mtoInfo, ...catalog.mto };
      const products = catalog.products || [];
      indexCatalog(products);
      renderCatalog(products, catalog.sections);
    } catch (e) {
      console.error(e);
      const status = document.createElement("div");
      status.className = "products-status error";
      status.textContent = e.message || "Failed to load products";
      grid.replaceChildren(status);
    }
  }

  if (!shopOnly) {
    document.getElementById("gift-card-pay")?.addEventListener("click", async () => {
      if (!wallets.giftCard || payInFlight) return;
      const shippingError = validateShipping(readShipping());
      if (shippingError) {
        setStatus(shippingError, "error");
        document.getElementById("ship-name")?.focus();
        return;
      }
      setPayBusy(true);
      try {
        setStatus("Reading gift card…");
        const token = tokenFromResult(
          await wallets.giftCard.tokenize(),
          "Gift card could not be read."
        );
        await payWithSource(token, "giftcard", { continueBusy: true });
      } catch (e) {
        console.error(e);
        setStatus(e.message || "Gift card payment could not be completed.", "error");
        setPayBusy(false);
      }
    });

    document.getElementById("cart-open").addEventListener("click", () => openModal("cart"));
    document.getElementById("checkout-close").addEventListener("click", closeModal);
    document.getElementById("cart-continue-btn").addEventListener("click", closeModal);
    document.getElementById("pay-back-btn").addEventListener("click", showCartStep);
    document.getElementById("confirm-done").addEventListener("click", closeModal);
    cartCheckoutBtn.addEventListener("click", () => {
      if (!cart.length) return;
      showPayStep();
    });
    form.addEventListener("submit", onSubmit);
    for (const id of [
      "ship-name",
      "ship-email",
      "ship-phone",
      "ship-line1",
      "ship-line2",
      "ship-city",
      "ship-state",
      "ship-postal",
    ]) {
      document.getElementById(id)?.addEventListener("input", () => {
        if (payStatus.classList.contains("error")) setStatus("");
      });
    }

    // Don't close on outside click — too easy to lose checkout progress.
    // Escape: step back from payment → cart; only close fully from the cart view.
    document.addEventListener("keydown", (e) => {
      if (!modal.classList.contains("open")) return;
      if (e.key === "Escape") {
        if (panelConfirm && !panelConfirm.hidden) {
          closeModal();
          return;
        }
        if (panelPay && !panelPay.hidden) {
          if (payInFlight) return;
          showCartStep();
          return;
        }
        closeModal();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = focusableIn(modal);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
