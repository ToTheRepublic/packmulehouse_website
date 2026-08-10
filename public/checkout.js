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
  const cartTotalEl = document.getElementById("cart-total");
  const panelCart = document.getElementById("panel-cart");
  const panelPay = document.getElementById("panel-pay");
  const paySummary = document.getElementById("pay-summary");
  const checkoutTitle = document.getElementById("checkout-title");
  const checkoutSubtitle = document.getElementById("checkout-subtitle");
  const cartCheckoutBtn = document.getElementById("cart-checkout-btn");
  const toastEl = document.getElementById("cart-toast");
  const sandboxHint = document.getElementById("sandbox-card-hint");

  let config = null;
  let shippingCents = 1000;
  let productsById = new Map();
  let variationsById = new Map();
  let card = null;
  let payments = null;
  /** @type {{ variationId: string, quantity: number }[]} */
  let cart = loadCart();
  let toastTimer = null;

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
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(cart));
    } catch {
      /* ignore */
    }
    updateCartBadge();
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

  function cartGrandTotalCents() {
    if (!cart.length) return 0;
    return cartSubtotalCents() + shippingCents;
  }

  function updateCartBadge() {
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
        });
      }
    }
    cart = cart.filter((l) => variationsById.has(l.variationId));
    saveCart();
  }

  function addToCart(product, quantity) {
    const variation =
      product.variations.find((v) => v.id === product.defaultVariationId) ||
      product.variations[0];
    if (!variation) {
      showToast("This product can’t be added right now.");
      return;
    }

    if (variation.trackInventory && variation.stock != null && variation.stock <= 0) {
      showToast("Out of stock");
      return;
    }

    const qty = Math.max(1, Math.min(20, quantity || 1));
    const existing = cart.find((l) => l.variationId === variation.id);
    const nextQty = existing ? existing.quantity + qty : qty;

    if (
      variation.trackInventory &&
      variation.stock != null &&
      nextQty > variation.stock
    ) {
      showToast(`Only ${variation.stock} in stock`);
      return;
    }

    if (existing) {
      existing.quantity = Math.min(20, nextQty);
    } else {
      cart.push({ variationId: variation.id, quantity: qty });
    }
    saveCart();
    showToast(`Added ${product.name} to cart`);
  }

  function setLineQty(variationId, quantity) {
    const v = variationsById.get(variationId);
    let qty = Math.max(0, Math.min(20, Number(quantity) || 0));
    if (v?.trackInventory && v.stock != null && qty > v.stock) {
      qty = v.stock;
      showToast(`Only ${v.stock} in stock`);
    }
    if (qty <= 0) {
      cart = cart.filter((l) => l.variationId !== variationId);
    } else {
      const line = cart.find((l) => l.variationId === variationId);
      if (line) line.quantity = qty;
    }
    saveCart();
    renderCartLines();
  }

  function removeLine(variationId) {
    cart = cart.filter((l) => l.variationId !== variationId);
    saveCart();
    renderCartLines();
  }

  function renderProducts(products) {
    if (!products.length) {
      grid.innerHTML =
        '<div class="products-status">No products found in the Square catalog yet.</div>';
      return;
    }

    grid.innerHTML = "";

    for (const p of products) {
      const variation =
        p.variations.find((v) => v.id === p.defaultVariationId) || p.variations[0];
      const outOfStock =
        variation?.trackInventory && variation.stock != null && variation.stock <= 0;

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
      price.textContent = p.priceLabel;

      const actions = document.createElement("div");
      actions.className = "product-actions";

      // Per-product quantity picker
      let pickQty = 1;
      const maxQty =
        variation?.trackInventory && variation.stock != null
          ? Math.min(20, Math.max(1, variation.stock))
          : 20;

      const qty = document.createElement("div");
      qty.className = "qty-controls";
      qty.setAttribute("aria-label", `Quantity for ${p.name}`);

      const qtyLabel = document.createElement("span");
      qtyLabel.textContent = "1";

      const minus = document.createElement("button");
      minus.type = "button";
      minus.setAttribute("aria-label", "Decrease quantity");
      minus.textContent = "−";
      minus.disabled = !!outOfStock;
      minus.addEventListener("click", () => {
        pickQty = Math.max(1, pickQty - 1);
        qtyLabel.textContent = String(pickQty);
      });

      const plus = document.createElement("button");
      plus.type = "button";
      plus.setAttribute("aria-label", "Increase quantity");
      plus.textContent = "+";
      plus.disabled = !!outOfStock;
      plus.addEventListener("click", () => {
        pickQty = Math.min(maxQty, pickQty + 1);
        qtyLabel.textContent = String(pickQty);
      });

      qty.append(minus, qtyLabel, plus);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-primary btn-sm";
      btn.textContent = outOfStock ? "Out of stock" : "Add to cart";
      btn.disabled = !!outOfStock;
      btn.addEventListener("click", () => addToCart(p, pickQty));

      actions.append(qty, btn);
      footer.append(price, actions);
      body.append(h3, desc, footer);

      if (variation?.trackInventory && variation.stock != null) {
        const stock = document.createElement("div");
        stock.className = "product-stock" + (outOfStock ? " out" : "");
        stock.textContent = outOfStock
          ? "Out of stock"
          : `${variation.stock} in stock`;
        body.appendChild(stock);
      }

      article.append(image, body);
      grid.appendChild(article);
    }
  }

  function renderCartLines() {
    cartLinesEl.innerHTML = "";
    const currency = cartCurrency();
    const sub = cartSubtotalCents();
    const grand = cartGrandTotalCents();
    cartSubtotalEl.textContent = moneyLabel(sub, currency);
    cartShippingEl.textContent = cart.length
      ? moneyLabel(shippingCents, currency)
      : moneyLabel(0, currency);
    cartTotalEl.textContent = moneyLabel(cart.length ? grand : 0, currency);

    if (!cart.length) {
      cartLinesEl.innerHTML =
        '<p class="cart-empty">Your cart is empty. Add an X-Frame kit from the shop.</p>';
      cartCheckoutBtn.disabled = true;
      return;
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

  function renderPaySummary() {
    const currency = cartCurrency();
    const rows = cart
      .map((line) => {
        const v = variationsById.get(line.variationId);
        if (!v) return "";
        return `<div class="modal-summary-row">
          <span>${escapeHtml(v.productName)} × ${line.quantity}</span>
          <span>${moneyLabel(v.amount * line.quantity, v.currency)}</span>
        </div>`;
      })
      .join("");

    paySummary.innerHTML =
      rows +
      `<div class="modal-summary-row">
        <span>Shipping (flat rate)</span>
        <span>${moneyLabel(shippingCents, currency)}</span>
      </div>
      <div class="modal-summary-row total">
        <span>Total</span>
        <span>${moneyLabel(cartGrandTotalCents(), currency)}</span>
      </div>`;
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function openModal(step) {
    modal.hidden = false;
    requestAnimationFrame(() => modal.classList.add("open"));
    document.body.style.overflow = "hidden";
    if (step === "pay") showPayStep();
    else showCartStep();
  }

  function closeModal() {
    modal.classList.remove("open");
    document.body.style.overflow = "";
    setTimeout(() => {
      modal.hidden = true;
    }, 200);
  }

  function showCartStep() {
    panelCart.hidden = false;
    panelPay.hidden = true;
    checkoutTitle.textContent = "Your cart";
    checkoutSubtitle.textContent = "Add kits, then checkout when you’re ready";
    setStatus("");
    renderCartLines();
  }

  async function showPayStep() {
    if (!cart.length) {
      showCartStep();
      return;
    }
    panelCart.hidden = true;
    panelPay.hidden = false;
    checkoutTitle.textContent = "Checkout";
    checkoutSubtitle.textContent = "Shipping + secure card payment";
    setStatus("");
    payButton.disabled = false;
    if (sandboxHint) {
      sandboxHint.hidden = config?.environment === "production";
    }
    renderPaySummary();

    try {
      await ensureCard();
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Could not load card form", "error");
    }
  }

  async function ensureCard() {
    if (!window.Square) throw new Error("Square.js is not loaded");
    if (!payments) {
      payments = window.Square.payments(config.applicationId, config.locationId);
    }
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
      ".message-text": { color: "#9a958a" },
      ".message-icon": { color: "#9a958a" },
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
    } catch (styleErr) {
      console.warn("Styled card form failed, falling back:", styleErr);
      try {
        if (card) await card.destroy();
      } catch {
        /* ignore */
      }
      card = await payments.card();
      await card.attach("#card-container");
    }
  }

  async function tokenize() {
    if (!card) throw new Error("Card form is not ready. Go back and try again.");
    const result = await card.tokenize();
    if (result.status === "OK") return result.token;
    const detail = result.errors
      ? result.errors.map((e) => e.message).join(" ")
      : result.status;
    throw new Error(detail || "Card tokenization failed");
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

  async function onSubmit(event) {
    event.preventDefault();
    if (!cart.length || !card) return;

    const shipping = readShipping();
    if (
      !shipping.displayName ||
      !shipping.email ||
      !shipping.addressLine1 ||
      !shipping.city ||
      !shipping.state ||
      !shipping.postalCode
    ) {
      setStatus("Please fill in all required shipping fields.", "error");
      return;
    }

    const amount = cartGrandTotalCents();
    const currency = cartCurrency();

    payButton.disabled = true;
    setStatus("Creating order and processing payment…");

    try {
      const sourceId = await tokenize();
      const verificationToken = await verifyBuyer(sourceId, amount, currency);

      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId,
          verificationToken,
          items: cart.map((l) => ({
            variationId: l.variationId,
            quantity: l.quantity,
          })),
          shippingAddress: shipping,
          buyerEmail: shipping.email,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.error) {
        const detail =
          data.details?.[0]?.detail ||
          data.details?.[0]?.code ||
          data.error ||
          "Payment failed";
        throw new Error(detail);
      }

      cart = [];
      saveCart();
      renderCartLines();

      let msg = `Order placed — ${data.amountLabel} charged. Thank you!`;
      if (data.orderId) msg += ` Order ${data.orderId.slice(0, 8)}…`;
      if (data.notified === false && data.notifyError) {
        msg += " (Shop notify failed — order is still paid in Square.)";
      }
      setStatus(msg, "success");
      payButton.disabled = true;

      // Refresh catalog stock after sale
      try {
        const cat = await fetch("/api/catalog").then((r) => r.json());
        if (cat.products) {
          indexCatalog(cat.products);
          renderProducts(cat.products);
        }
      } catch {
        /* ignore */
      }

      setTimeout(() => closeModal(), 2800);
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Payment failed", "error");
      payButton.disabled = false;
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

      if (config.environment !== "production" && envBadge) {
        envBadge.hidden = false;
      }

      await loadSquareSdk(config.environment);

      if (!catalogRes.ok) {
        const err = await catalogRes.json().catch(() => ({}));
        throw new Error(err.error || "Could not load catalog");
      }
      const catalog = await catalogRes.json();
      if (catalog.shippingCents != null) {
        shippingCents = Number(catalog.shippingCents) || shippingCents;
      }
      const products = catalog.products || [];
      indexCatalog(products);
      renderProducts(products);
    } catch (e) {
      console.error(e);
      grid.innerHTML = `<div class="products-status error">${
        e.message || "Failed to load products"
      }</div>`;
    }
  }

  document.getElementById("cart-open").addEventListener("click", () => openModal("cart"));
  document.getElementById("checkout-close").addEventListener("click", closeModal);
  document.getElementById("cart-continue-btn").addEventListener("click", closeModal);
  document.getElementById("pay-back-btn").addEventListener("click", showCartStep);
  cartCheckoutBtn.addEventListener("click", () => {
    if (!cart.length) return;
    showPayStep();
  });
  form.addEventListener("submit", onSubmit);

  // Don't close on outside click — too easy to lose checkout progress.
  // Escape: step back from payment → cart; only close fully from the cart view.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !modal.classList.contains("open")) return;
    if (panelPay && !panelPay.hidden) {
      showCartStep();
      return;
    }
    closeModal();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
