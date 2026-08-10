/**
 * Pack Mule House — product catalog + embedded Square checkout
 */
(function () {
  "use strict";

  const grid = document.getElementById("product-grid");
  const envBadge = document.getElementById("env-badge");
  const modal = document.getElementById("checkout-modal");
  const form = document.getElementById("checkout-form");
  const payButton = document.getElementById("pay-button");
  const payStatus = document.getElementById("pay-status");
  const qtySelect = document.getElementById("checkout-qty");
  const emailInput = document.getElementById("checkout-email");

  let config = null;
  let productsById = new Map();
  let card = null;
  let payments = null;
  let selected = null; // { product, variation }

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

  function renderProducts(products) {
    if (!products.length) {
      grid.innerHTML =
        '<div class="products-status">No products found in the Square catalog yet.</div>';
      return;
    }

    grid.innerHTML = "";
    productsById = new Map();

    for (const p of products) {
      productsById.set(p.id, p);

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

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-primary btn-sm";
      btn.textContent = "Buy";
      btn.addEventListener("click", () => openCheckout(p));

      footer.append(price, btn);
      body.append(h3, desc, footer);
      article.append(image, body);
      grid.appendChild(article);
    }
  }

  function updateTotals() {
    if (!selected) return;
    const qty = Math.max(1, Number(qtySelect.value) || 1);
    const unit = selected.variation.amount;
    const currency = selected.variation.currency;
    document.getElementById("checkout-unit-price").textContent = moneyLabel(
      unit,
      currency
    );
    document.getElementById("checkout-qty-label").textContent = String(qty);
    document.getElementById("checkout-total").textContent = moneyLabel(
      unit * qty,
      currency
    );
  }

  async function ensureCard() {
    if (!window.Square) {
      throw new Error("Square.js is not loaded");
    }
    if (!payments) {
      payments = window.Square.payments(config.applicationId, config.locationId);
    }
    // Recreate card each open so the form is clean
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

    // Styles must match Square's allowed CardClassSelectors (see customize-styles docs).
    // Custom webfonts like "Inter" are rejected — use system fonts only.
    const cardStyle = {
      ".input-container": {
        borderColor: "#2a2a2a",
        borderRadius: "10px",
      },
      ".input-container.is-focus": {
        borderColor: "#5c8a8a",
      },
      ".input-container.is-error": {
        borderColor: "#e07070",
      },
      ".message-text": {
        color: "#9a958a",
      },
      ".message-icon": {
        color: "#9a958a",
      },
      ".message-text.is-error": {
        color: "#e07070",
      },
      ".message-icon.is-error": {
        color: "#e07070",
      },
      input: {
        backgroundColor: "#1c1c1c",
        color: "#eae6dc",
        fontFamily: "helvetica neue, sans-serif",
      },
      "input::placeholder": {
        color: "#6b675f",
      },
      "input.is-error": {
        color: "#e07070",
      },
    };

    try {
      card = await payments.card({ style: cardStyle });
      await card.attach("#card-container");
    } catch (styleErr) {
      console.warn("Styled card form failed, falling back to defaults:", styleErr);
      try {
        if (card) await card.destroy();
      } catch {
        /* ignore */
      }
      card = await payments.card();
      await card.attach("#card-container");
    }
  }

  async function openCheckout(product) {
    const variation =
      product.variations.find((v) => v.id === product.defaultVariationId) ||
      product.variations[0];
    if (!variation) {
      alert("This product has no sellable variation.");
      return;
    }

    selected = { product, variation };
    document.getElementById("checkout-product-name").textContent = product.name;
    qtySelect.value = "1";
    emailInput.value = "";
    setStatus("");
    payButton.disabled = false;
    updateTotals();

    modal.hidden = false;
    // allow transition
    requestAnimationFrame(() => modal.classList.add("open"));
    document.body.style.overflow = "hidden";

    try {
      await ensureCard();
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Could not load card form", "error");
    }
  }

  function closeCheckout() {
    modal.classList.remove("open");
    document.body.style.overflow = "";
    setTimeout(() => {
      modal.hidden = true;
    }, 200);
  }

  async function tokenize() {
    if (!card) {
      throw new Error("Card form is not ready. Close checkout and try again.");
    }
    const result = await card.tokenize();
    if (result.status === "OK") return result.token;
    const detail = result.errors
      ? result.errors.map((e) => e.message).join(" ")
      : result.status;
    throw new Error(detail || "Card tokenization failed");
  }

  async function verifyBuyer(token, amountCents, currency) {
    // SCA / 3DS — required in some regions; safe no-op path if Square skips
    const details = {
      amount: (amountCents / 100).toFixed(2),
      currencyCode: currency || "USD",
      intent: "CHARGE",
      billingContact: {
        email: emailInput.value.trim() || undefined,
      },
    };
    try {
      const verification = await payments.verifyBuyer(token, details);
      return verification && verification.token ? verification.token : undefined;
    } catch (e) {
      // In US sandbox this often is not required; continue without
      console.warn("verifyBuyer skipped:", e);
      return undefined;
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (!selected || !card) return;

    const qty = Math.max(1, Math.min(20, Number(qtySelect.value) || 1));
    const amount = selected.variation.amount * qty;
    const currency = selected.variation.currency;

    payButton.disabled = true;
    setStatus("Processing payment…");

    try {
      const sourceId = await tokenize();
      const verificationToken = await verifyBuyer(sourceId, amount, currency);

      const res = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId,
          verificationToken,
          variationId: selected.variation.id,
          quantity: qty,
          buyerEmail: emailInput.value.trim() || undefined,
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

      setStatus(
        `Paid ${data.amountLabel} — thank you!${data.receiptUrl ? " Check your email for a receipt." : ""}`,
        "success"
      );
      payButton.disabled = true;

      // Soft close after success
      setTimeout(() => closeCheckout(), 2200);
    } catch (e) {
      console.error(e);
      setStatus(e.message || "Payment failed", "error");
      payButton.disabled = false;
    }
  }

  async function init() {
    try {
      const [configRes, catalogRes] = await Promise.all([
        fetch("/api/config"),
        fetch("/api/catalog"),
      ]);

      if (!configRes.ok) throw new Error("Could not load payment config");
      config = await configRes.json();

      if (config.environment !== "production" && envBadge) {
        envBadge.hidden = false;
      }

      await loadSquareSdk(config.environment);

      if (!catalogRes.ok) {
        const err = await catalogRes.json().catch(() => ({}));
        throw new Error(err.error || "Could not load catalog");
      }
      const catalog = await catalogRes.json();
      renderProducts(catalog.products || []);
    } catch (e) {
      console.error(e);
      grid.innerHTML = `<div class="products-status error">${
        e.message || "Failed to load products"
      }</div>`;
    }
  }

  qtySelect.addEventListener("change", updateTotals);
  form.addEventListener("submit", onSubmit);
  document.getElementById("checkout-close").addEventListener("click", closeCheckout);
  document.getElementById("checkout-cancel").addEventListener("click", closeCheckout);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeCheckout();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && modal.classList.contains("open")) closeCheckout();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

// build 20260810182637
