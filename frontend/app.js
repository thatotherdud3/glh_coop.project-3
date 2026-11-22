/* G L H // CO-OP  app.js */

/* cart state management */

// load a valid saved cart, otherwise start fresh
let cart = [];
try {
  const saved = JSON.parse(localStorage.getItem("glh_cart") || "[]");
  if (Array.isArray(saved)) {
    cart = saved.filter(item => item && Number.isInteger(Number(item.product_id))
      && Number.isInteger(Number(item.quantity)) && Number(item.quantity) > 0);
  }
} catch {
  // bad saved data shouldnt break the whole site
}

// encode user-supplied or database-supplied text before adding it to HTML templates.
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;",
    '"': "&quot;", "'": "&#39;"
  })[char]);
}

function invalidateCheckoutAttempt() {
  localStorage.removeItem("glh_checkout_key");
}

function showSystemFeedback(elementId, message, kind = "info") {
  const target = document.getElementById(elementId);
  if (!target) return;
  target.textContent = message || "";
  target.dataset.kind = kind;
  target.hidden = !message;
  target.setAttribute("role", kind === "error" ? "alert" : "status");
}

function readApiResponse(response) {
  return response.json().catch(() => ({})).then((data) => {
    if (!response.ok) {
      const error = new Error(data.message || "Request failed. Please try again.");
      error.status = response.status;
      error.code = data.code;
      error.details = data;
      throw error;
    }
    return data;
  });
}

function saveCart() {
  // writes the current cart array back to local storage
  localStorage.setItem("glh_cart", JSON.stringify(cart));
  updateCartCount();
}

function updateCartCount() {
  // count once, then update any cart links
  const count = cart.reduce((sum, item) => sum + Number(item.quantity), 0);
  document.querySelectorAll(".nav-item").forEach(link => {
    if (link.textContent.includes("CART")) link.textContent = `CART [${count}]`;
  });
}

function addToCart(id, name, price, stock, requestedQuantity = 1, productMetadata = {}) {
  const available = Math.max(0, Math.floor(Number(stock) || 0));
  const quantity = Number(requestedQuantity);
  if (available <= 0 || !Number.isInteger(quantity) || quantity < 1) {
    return false;
  }
  const existing = cart.find((item) => Number(item.product_id) === Number(id));
  const alreadyInCart = existing ? Number(existing.quantity) || 0 : 0;
  if (alreadyInCart + quantity > available) return false;
  // keep the exact produce image, producer and trace data with the cart item.
  const metadata = {
    product_name: name,
    price: Number(price),
    max_stock: available,
    product_image: productMetadata.product_image || existing?.product_image || "placeholder.png",
    producer_name: productMetadata.producer_name || existing?.producer_name || "",
    batch_number: productMetadata.batch_number || existing?.batch_number || "",
    allergen_info: productMetadata.allergen_info || existing?.allergen_info || ""
  };
  if (existing) {
    Object.assign(existing, metadata);
    existing.quantity = alreadyInCart + quantity;
  } else {
    cart.push({ product_id: id, quantity, ...metadata });
  }
  invalidateCheckoutAttempt();
  saveCart();
  return true;
}

/* shop search: filter the already loaded inventory without extra requests */
let shopInventory = [];

function renderShopSearch() {
  const grid = document.getElementById("shop-inventory-grid");
  if (!grid) return;
  const input = document.getElementById("shop-search");
  const query = (input?.value || "").trim().toLocaleLowerCase("en-GB");
  const sortMode = document.getElementById("shop-sort")?.value || "name-asc";
  const byName = (a, b) => String(a.product_name || "").localeCompare(
    String(b.product_name || ""), "en-GB", { sensitivity: "base", numeric: true }
  ) || Number(a.product_id) - Number(b.product_id);
  const stockRank = (item) => Number(item.stock_level) <= 0 ? 2 :
    Number(item.stock_level) <= 20 ? 1 : 0;
  const results = shopInventory.filter((item) =>
    [item.product_name, item.producer_name, item.batch_number, item.product_description]
      .some((value) => String(value || "").toLocaleLowerCase("en-GB").includes(query))
  ).sort((a, b) => {
    if (sortMode === "name-desc") return -byName(a, b);
    if (sortMode === "price-asc") return Number(a.price) - Number(b.price) || byName(a, b);
    if (sortMode === "price-desc") return Number(b.price) - Number(a.price) || byName(a, b);
    if (sortMode === "availability") return stockRank(a) - stockRank(b) || byName(a, b);
    return byName(a, b);
  });
  populateShop(results, grid);
  if (!results.length) {
    const empty = document.createElement("p");
    empty.className = "shop-search-empty";
    empty.textContent = shopInventory.length
      ? "No produce matches your search. Try another name, producer or batch."
      : "No produce is currently listed.";
    grid.appendChild(empty);
  }
  const count = document.getElementById("shop-search-count");
  if (count) count.textContent = `SHOWING ${results.length} OF ${shopInventory.length} PRODUCTS`;
}

function initShopSearch() {
  const input = document.getElementById("shop-search");
  if (input) input.addEventListener("input", renderShopSearch);
  document.getElementById("shop-sort")?.addEventListener("change", renderShopSearch);
}

/* inventory retrieval and distribution */

function showInventoryError(url) {
  const shopGrid = document.getElementById("shop-inventory-grid");
  if (shopGrid) {
    shopInventory = [];
    const search = document.getElementById("shop-search");
    const sort = document.getElementById("shop-sort");
    if (search) search.disabled = true;
    if (sort) sort.disabled = true;
    shopGrid.innerHTML = `
      <section class="shop-inventory-error" role="alert">
        <h2>Inventory temporarily unavailable.</h2>
        <p>We could not load the latest produce. Your cart is still saved.</p>
        <button class="shop-inventory-retry" type="button">TRY AGAIN</button>
      </section>`;
    shopGrid.querySelector(".shop-inventory-retry")
      .addEventListener("click", () => fetchInventoryData(url));
    const counter = document.getElementById("shop-search-count");
    if (counter) counter.textContent = "INVENTORY UNAVAILABLE";
  }
  if (document.getElementById("producer-ledger-body")) {
    showSystemFeedback("ledger-feedback",
      "Unable to load your latest inventory. Refresh the page to try again.", "error");
  }
}

function buildAllergenDeclaration(ingredientAllergens, possibleContact = "") {
  const source = String(ingredientAllergens || "").trim();
  const contains = /^(none|no allergens? present)$/i.test(source)
    ? "None of the listed allergens" : source;
  const contact = String(possibleContact || "").trim();
  if (!contains) throw new Error("Declare the allergens used as ingredients or confirm none are used.");
  if (contains.toLowerCase().startsWith("none of the listed allergens") &&
      contains.toLowerCase() !== "none of the listed allergens") {
    throw new Error("The absence declaration cannot be combined with named ingredient allergens.");
  }
  const declaration = `Contains: ${contains}${contact ? " | May contain: " + contact : ""}`;
  if (declaration.length > 500) throw new Error("Keep the allergen declaration within 500 characters.");
  return declaration;
}

function fetchInventoryData(url) {
  // fresh stock every time
  fetch(`${url}?t=${Date.now()}`, { cache: "no-store" })
    .then((response) => {
      if (!response.ok)
        throw new Error("Network latency or server rejection detected.");
      return response.json();
    })
    .then((data) => {
      if (!Array.isArray(data)) throw new Error("Unexpected inventory response.");
      distributeData(data);
    })
    .catch((error) => {
      console.error("SYSTEM ERROR:", error);
      showInventoryError(url);
    });
}

function distributeData(inventory) {
  // works out which node we are on and sends data to the right render function
  const shopGrid = document.getElementById("shop-inventory-grid");
  const ledgerTable = document.getElementById("producer-ledger-body");

  if (shopGrid) {
    shopInventory = Array.isArray(inventory) ? inventory : [];
    const search = document.getElementById("shop-search");
    const sort = document.getElementById("shop-sort");
    if (search) search.disabled = false;
    if (sort) sort.disabled = false;
    renderShopSearch();
  }
  if (ledgerTable) {
    // filters the inventory so the ledger only shows the logged in producers stock
    const activeProducerId = parseInt(
      localStorage.getItem("session_user_id"),
      10,
    );
    const ownInventory = inventory.filter(
      (item) => item.producer_id === activeProducerId,
    );
    populateLedger(ownInventory, ledgerTable);
  }
}

/* shop produce node */

// correct image extensions used by older database seed versions.
const LEGACY_PRODUCT_IMAGE_NAMES = Object.freeze({
  "basil.png": "basil.jpg",
  "tarragon.png": "tarragon.jpeg",
  "hen ow.png": "hen ow.jpeg",
  "amber honey.png": "amber honey.jpg",
});

function resolveProductImageUrl(imageName) {
  // paths are relative to the frontend page; always use the assets directory.
  const supplied = String(imageName || "placeholder.png").trim();
  const basename = supplied.split(/[\\/]/).pop() || "placeholder.png";
  const filename = LEGACY_PRODUCT_IMAGE_NAMES[basename.toLowerCase()] || basename;
  return "assets/" + encodeURIComponent(filename);
}

function populateShop(inventory, container) {
  container.innerHTML = "";

  // shop search and sorting provide the display order.
  inventory.forEach((item) => {
    const card = document.createElement("div");
    card.className = "product-card";

    // resolve legacy .png filenames and safely encode spaces for the browser.
    const imagePath = resolveProductImageUrl(item.product_image);

    // works out the stock status for the badge and button text
    let status = "IN STOCK";
    let badgeClass = "active";
    let actionText = "ADD TO CART";
    let actionIcon = "+";

    if (item.stock_level === 0) {
      status = "OUT OF STOCK";
      badgeClass = "out-of-stock";
      actionText = "NOT AVAILABLE";
      actionIcon = "/";
    } else if (item.stock_level <= 20) {
      status = "LOW STOCK";
      badgeClass = "low-stock";
    }

    // formats the allergen info and price for display
    const formattedAllergens = `ALLERGEN DECLARATION: ${escapeHtml(String(item.allergen_info || "NOT RECORDED").toUpperCase())}`;
    const formattedPrice = `£${Number(item.price).toFixed(2)}`;

    card.innerHTML = `
        <div class="product-image-slot" style="width: 100%; aspect-ratio: 4 / 3; overflow: hidden; border-bottom: 1px solid #111111;">
          <img
            class="product-image"
            src="${imagePath}"
            alt="${escapeHtml(item.product_name)}"
            loading="lazy"
            style="width: 100%; height: 100%; object-fit: cover; display: block; background-color: #e0e0e0;"
          />
        </div>
        <div class="product-details">
          <div class="product-header">
            <span class="product-vendor">PRODUCER: ${escapeHtml(String(item.producer_name || "").toUpperCase())}</span>
            <div class="product-meta-right">
              <span class="box-index">${escapeHtml(item.batch_number)}</span>
              <span class="status-badge ${badgeClass}">${status}</span>
            </div>
          </div>
          <h2 class="box-title">${escapeHtml(item.product_name)}</h2>
          ${item.product_description ? `<p class="product-description">${escapeHtml(item.product_description)}</p>` : ""}
          <span class="product-allergen">${formattedAllergens}</span>
          <span class="product-price">${formattedPrice}</span>
        </div>
        <button class="product-action" type="button">
          <span>${actionText}</span>
          <span class="action-icon">${actionIcon}</span>
        </button>
    `;

    // let customers choose a quantity on the shop card before adding to cart.
    const stock = Math.max(0, Math.floor(Number(item.stock_level) || 0));
    const actionButton = card.querySelector(".product-action");
    const quantityRow = document.createElement("div");
    quantityRow.className = "shop-quantity-row";
    quantityRow.innerHTML = `
      <span class="shop-quantity-label">QUANTITY</span>
      <div class="shop-quantity-controls" role="group" aria-label="Select product quantity">
        <button type="button" class="shop-quantity-step" data-direction="-1" aria-label="Decrease quantity">−</button>
        <input type="number" class="shop-quantity-input" min="1" step="1" value="1" inputmode="numeric" aria-label="Quantity to add to cart">
        <button type="button" class="shop-quantity-step" data-direction="1" aria-label="Increase quantity">+</button>
      </div>
      <span class="shop-quantity-remaining" aria-live="polite"></span>
    `;
    if (stock === 0) quantityRow.hidden = true;
    actionButton.before(quantityRow);

    const feedback = document.createElement("p");
    feedback.className = "shop-add-feedback";
    feedback.setAttribute("role", "status");
    feedback.setAttribute("aria-live", "polite");
    card.appendChild(feedback);

    const quantityInput = quantityRow.querySelector(".shop-quantity-input");
    const decreaseButton = quantityRow.querySelector('[data-direction="-1"]');
    const increaseButton = quantityRow.querySelector('[data-direction="1"]');
    const remainingLabel = quantityRow.querySelector(".shop-quantity-remaining");
    const actionLabel = actionButton.querySelector("span");
    const actionIconNode = actionButton.querySelector(".action-icon");
    const remainingStock = () => {
      const existing = cart.find((entry) => Number(entry.product_id) === Number(item.product_id));
      return Math.max(0, stock - (existing ? Number(existing.quantity) || 0 : 0));
    };
    const updateQuantityControls = () => {
      const remaining = remainingStock();
      const selected = parseInt(quantityInput.value, 10);
      const quantity = Number.isInteger(selected) ? Math.min(Math.max(selected, 1), Math.max(remaining, 1)) : 1;
      quantityInput.value = String(quantity);
      quantityInput.max = String(Math.max(remaining, 1));
      quantityInput.disabled = remaining === 0;
      decreaseButton.disabled = remaining === 0 || quantity <= 1;
      increaseButton.disabled = remaining === 0 || quantity >= remaining;
      remainingLabel.textContent = `${remaining} AVAILABLE TO ADD`;
      actionButton.disabled = remaining === 0;
      actionLabel.textContent = stock === 0 ? "NOT AVAILABLE" : remaining === 0 ? "MAX IN CART" : "ADD TO CART";
      actionIconNode.textContent = remaining === 0 ? "/" : "+";
    };
    decreaseButton.addEventListener("click", () => {
      quantityInput.stepDown();
      updateQuantityControls();
    });
    increaseButton.addEventListener("click", () => {
      quantityInput.stepUp();
      updateQuantityControls();
    });
    quantityInput.addEventListener("change", updateQuantityControls);
    actionButton.addEventListener("click", () => {
      const selected = Number(quantityInput.value);
      if (!Number.isInteger(selected) || selected < 1 || selected > remainingStock()) {
        feedback.textContent = "Choose a quantity within the available stock."; 
        updateQuantityControls();
        return;
      }
      if (addToCart(item.product_id, item.product_name, Number(item.price), stock, selected, item)) {
        const totalForProduct = cart.find((entry) => Number(entry.product_id) === Number(item.product_id))?.quantity ?? selected;
        feedback.textContent = `${totalForProduct} UNIT${totalForProduct === 1 ? "" : "S"} NOW IN CART`;
        quantityInput.value = "1";
        updateQuantityControls();
      } else {
        feedback.textContent = "This amount is no longer available. Review the remaining stock.";
      }
    });
    updateQuantityControls();
    const productImage = card.querySelector(".product-image");
    if (productImage) {
      productImage.addEventListener("error", function () {
        const fallback = "assets/placeholder.png";
        if (!this.src.endsWith("/" + fallback)) {
          console.warn("Product image not found:", this.getAttribute("src"));
          this.src = fallback;
        }
      });
    }

    container.appendChild(card);
  });
}

/* producer ledger node */

function populateLedger(inventory, container) {
  container.replaceChildren();
  inventory.forEach((item) => {
    const row = document.createElement("tr");
    const quantity = Number(item.stock_level) || 0;
    const status = quantity <= 0 ? "OUT OF STOCK" : quantity <= 20 ? "LOW STOCK" : "ACTIVE";
    const badgeClass = quantity <= 0 ? "out-of-stock" : quantity <= 20 ? "low-stock" : "active";
    row.innerHTML = `
      <td class="sku-cell">${escapeHtml(item.batch_number)}</td>
      <td class="name-cell">${escapeHtml(item.product_name)}</td>
      <td class="data-cell">${escapeHtml(item.stock_level)}</td>
      <td class="data-cell">£${Number(item.price).toFixed(2)}</td>
      <td class="data-cell"><span class="status-badge ${badgeClass}">${status}</span></td>
      <td class="action-cell">
        <div class="ledger-item-actions">
          <button type="button" class="ledger-edit-btn">EDIT</button>
          <button type="button" class="ledger-remove-btn">REMOVE</button>
        </div>
      </td>`;
    row.querySelector(".ledger-edit-btn").addEventListener("click", () => openProductEditor(item));
    row.querySelector(".ledger-remove-btn").addEventListener("click", () => deleteProduct(item.product_id, item.product_name));
    container.appendChild(row);
  });
}

function openProductEditor(item) {
  const form = document.getElementById("product-edit-form");
  if (!form) return;
  form.hidden = false;
  form.dataset.productId = String(item.product_id);
  const set = (id, value) => { document.getElementById(id).value = value ?? ""; };
  set("edit-product-name", item.product_name);
  set("edit-product-batch", item.batch_number);
  set("edit-product-price", Number(item.price).toFixed(2));
  set("edit-product-stock", item.stock_level);
  set("edit-product-description", item.product_description);
  set("edit-product-harvest", item.harvest_date);
  const savedAllergens = String(item.allergen_info || "").trim();
  const portions = savedAllergens.split(/\s*\|\s*May contain:\s*/i);
  const previousIngredients = portions[0].replace(/^Contains:\s*/i, "").trim();
  set("edit-product-contains",
    /^(none|no allergens? present)$/i.test(previousIngredients)
      ? "None of the listed allergens" : previousIngredients);
  set("edit-product-may-contain", portions.slice(1).join(" | May contain: "));
  const title = document.getElementById("edit-product-title");
  if (title) title.textContent = "Edit: " + item.product_name;
  showSystemFeedback("product-edit-feedback", "", "info");
  form.scrollIntoView({ behavior: "smooth", block: "center" });
  document.getElementById("edit-product-name").focus({ preventScroll: true });
}

function closeProductEditor() {
  const form = document.getElementById("product-edit-form");
  if (!form) return;
  form.hidden = true;
  form.reset();
  delete form.dataset.productId;
  showSystemFeedback("product-edit-feedback", "");
}

const productEditForm = document.getElementById("product-edit-form");
if (productEditForm) {
  document.getElementById("edit-product-cancel")?.addEventListener("click", closeProductEditor);
  productEditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const productId = Number(productEditForm.dataset.productId);
    if (!Number.isInteger(productId) || productId <= 0) return;
    const saveButton = document.getElementById("edit-product-save");
    if (saveButton.disabled) return;
    let allergenDeclaration;
    try {
      allergenDeclaration = buildAllergenDeclaration(
        document.getElementById("edit-product-contains").value,
        document.getElementById("edit-product-may-contain").value
      );
    } catch (error) {
      showSystemFeedback("product-edit-feedback", error.message, "error");
      return;
    }
    const payload = {
      product_name: document.getElementById("edit-product-name").value.trim(),
      batch_number: document.getElementById("edit-product-batch").value.trim(),
      price: Number(document.getElementById("edit-product-price").value),
      stock_level: Number(document.getElementById("edit-product-stock").value),
      harvest_date: document.getElementById("edit-product-harvest").value || null,
      allergen_info: allergenDeclaration,
      product_description: document.getElementById("edit-product-description").value.trim()
    };
    if (!Number.isInteger(payload.stock_level) || payload.stock_level < 0) {
      showSystemFeedback("product-edit-feedback", "Stock must be a non-negative whole number.", "error");
      return;
    }
    saveButton.disabled = true;
    saveButton.textContent = "SAVING…";
    showSystemFeedback("product-edit-feedback", "");
    try {
      const result = await fetch("/products/" + encodeURIComponent(productId), {
        method: "PUT", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }).then(readApiResponse);
      closeProductEditor();
      showSystemFeedback("ledger-feedback",
        `Changes saved to “${payload.product_name}”. Stock: ${payload.stock_level} units · Unit price: £${payload.price.toFixed(2)}.`,
        "success");
      document.getElementById("ledger-feedback")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      fetchInventoryData("/products");
      if (typeof window.refreshProducerDashboard === "function") window.refreshProducerDashboard();
    } catch (error) {
      showSystemFeedback("product-edit-feedback",
        error.status === 401 ? "Your producer session expired. Sign in again to edit products." :
        error.message || "Unable to update this listing.", "error");
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = "SAVE CHANGES";
    }
  });
}

/* producer intake manifest form */

const ledgerForm = document.getElementById("ledger-form");

if (ledgerForm) {
  const allergenGrid = document.getElementById("allergen-container");
  const noAllergens = document.getElementById("no-allergens");
  allergenGrid?.addEventListener("change", (event) => {
    if (!event.target.matches(".allergen-check")) return;
    if (event.target === noAllergens && noAllergens.checked) {
      allergenGrid.querySelectorAll(".allergen-check:not(#no-allergens)")
        .forEach(box => { box.checked = false; });
      document.getElementById("allergen-other").value = "";
    } else if (event.target !== noAllergens && event.target.checked && noAllergens) {
      noAllergens.checked = false;
    }
  });
  document.getElementById("allergen-other")?.addEventListener("input", (event) => {
    if (event.target.value.trim() && noAllergens) noAllergens.checked = false;
  });
  ledgerForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const selected = [...document.querySelectorAll("#allergen-container .allergen-check:checked")]
      .filter(cb => cb.id !== "no-allergens");
    const none = Boolean(document.getElementById("no-allergens")?.checked);
    const otherAllergens = document.getElementById("allergen-other")?.value.trim() || "";
    const possibleContact = document.getElementById("allergen-may-contain")?.value.trim() || "";
    if (!none && !selected.length && !otherAllergens) {
      showSystemFeedback("ledger-feedback",
        "Choose the ingredient allergens or confirm that no listed allergens are used.", "error");
      return;
    }
    if (none && (selected.length || otherAllergens)) {
      showSystemFeedback("ledger-feedback",
        "Clear the absence declaration before adding ingredient allergens.", "error");
      return;
    }
    let declaration;
    try {
      const ingredients = none ? "None of the listed allergens" :
        [...selected.map(cb => cb.parentElement.textContent.trim()), otherAllergens]
          .filter(Boolean).join(", ");
      declaration = buildAllergenDeclaration(ingredients, possibleContact);
    } catch (error) {
      showSystemFeedback("ledger-feedback", error.message, "error");
      return;
    }
    const button = document.getElementById("commit-btn");
    if (button.disabled) return;
    const formData = new FormData();
    const imageFile = document.getElementById("input-image").files[0];
    formData.append("batch_number", ledgerForm.querySelector('input[placeholder="e.g. BATCH-2026-X1"]').value.trim());
    formData.append("product_name", ledgerForm.querySelector('input[placeholder="Product Descriptor"]').value.trim());
    formData.append("stock_level", document.getElementById("input-stock").value);
    formData.append("price", document.getElementById("input-price").value);
    formData.append("product_description", document.getElementById("input-description")?.value.trim() || "");
    const harvest = document.getElementById("input-harvest-date");
    if (harvest?.value) formData.append("harvest_date", harvest.value);
    formData.append("allergen_info", declaration);
    if (imageFile) formData.append("product_image", imageFile);
    button.disabled = true;
    button.textContent = "SAVING PRODUCT…";
    showSystemFeedback("ledger-feedback", "");
    try {
      const result = await fetch("/products", {
        method: "POST", credentials: "same-origin", body: formData
      }).then(readApiResponse);
      const addedName = formData.get("product_name");
      const addedStock = Number(formData.get("stock_level"));
      ledgerForm.reset();
      showSystemFeedback("ledger-feedback",
        `“${addedName}” was added to your inventory with ${addedStock} units. You can edit it in Current Ledger.`,
        "success");
      document.getElementById("ledger-feedback")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      fetchInventoryData("/products");
      if (typeof window.refreshProducerDashboard === "function") window.refreshProducerDashboard();
    } catch (error) {
      showSystemFeedback("ledger-feedback",
        error.status === 401 ? "Your producer session expired. Sign in again to upload products." :
        error.message || "Product could not be saved. Check the details and retry.", "error");
    } finally {
      button.disabled = false;
      button.textContent = "COMMIT TO LEDGER";
    }
  });
}

/* product deletion */

async function deleteProduct(productId, productName = "Product") {
  if (!confirm("Remove this product from your inventory? Existing orders will remain on record.")) return;
  try {
    const result = await fetch("/products/" + encodeURIComponent(productId), {
      method: "DELETE", credentials: "same-origin"
    }).then(readApiResponse);
    showSystemFeedback("ledger-feedback", `“${productName}” has been removed from your active inventory.`, "success");
    document.getElementById("ledger-feedback")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    fetchInventoryData("/products");
    if (typeof window.refreshProducerDashboard === "function") window.refreshProducerDashboard();
  } catch (error) {
    showSystemFeedback("ledger-feedback",
      error.status === 401 ? "Your producer session expired. Sign in again to remove products." :
      error.message || "Unable to remove this listing.", "error");
  }
}

/* identity and authentication */

let authFormObj = document.querySelector(".auth-form");
// checks which type of form is on the page
let isLoginMode = document.getElementById("user-id");
let isRegistrationMode = document.getElementById("passkey-confirm");

if (authFormObj && isLoginMode) {
  const feedback = document.createElement("p");
  feedback.id = "auth-feedback";
  feedback.className = "glh-inline-notice";
  feedback.hidden = true;
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  authFormObj.prepend(feedback);
}

if (authFormObj) {
  authFormObj.addEventListener("submit", async function (event) {
    event.preventDefault();

    // registration path: one submission, meaningful validation messages and
    // no stale customer identity carried over from a previous login.
    if (isRegistrationMode) {
      const fullName = document.getElementById("customer-alias").value.trim();
      const email = document.getElementById("customer-email").value.trim();
      const password = document.getElementById("passkey").value;
      const confirmPassword = document.getElementById("passkey-confirm").value;
      const submitButton = authFormObj.querySelector('button[type="submit"]');
      const errorSlot = document.getElementById("registration-error");
      const showRegistrationError = (message) => {
        if (errorSlot) {
          errorSlot.hidden = !message;
          errorSlot.textContent = message || "";
        }
      };
      showRegistrationError("");
      if (!fullName || !email) {
        showRegistrationError("Enter your name and email address.");
        return;
      }
      if (password.length < 8) {
        showRegistrationError("Your passkey must contain at least 8 characters.");
        return;
      }
      if (password !== confirmPassword) {
        showRegistrationError("The two passkeys do not match.");
        return;
      }
      if (submitButton.disabled) return;
      submitButton.disabled = true;
      const originalLabel = submitButton.textContent;
      submitButton.textContent = "CREATING ACCOUNT…";
      try {
        const response = await fetch("/register", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            full_name: fullName, email, password, role: "customer"
          }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.status !== "success") {
          throw new Error(data.message || "Registration failed. Please try again.");
        }

        // registration does not sign in the new customer. End any previous
        // account's cookie session before routing to the login screen.
        try {
          await fetch("/producer/logout", {
            method: "POST", credentials: "same-origin"
          });
        } catch (error) {
          console.warn("Could not clear earlier session cookie:", error);
        }
        for (const key of [
          "session_user_id", "session_role", "session_full_name",
          "session_producer_token"
        ]) localStorage.removeItem(key);
        // preserve the guest shopping cart for checkout after sign-in.
        window.location.replace("customer-login.html?registered=1");
      } catch (error) {
        console.error("REGISTRATION ERROR:", error);
        showRegistrationError(error.message || "Unable to create your account.");
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }

    // login: sign in once, show helpful errors within the form.
    else if (isLoginMode) {
      const email = document.getElementById("user-id").value.trim();
      const passwordField = document.getElementById("passkey");
      const password = passwordField.value;
      const modeText = document.querySelector(".auth-mode")?.innerText || "";
      const requestedNode = modeText.includes("PRODUCER") ? "producer" : "customer";
      const submitButton = authFormObj.querySelector('button[type="submit"]');
      if (submitButton.disabled) return;
      submitButton.disabled = true;
      const originalLabel = submitButton.textContent;
      submitButton.textContent = "VERIFYING IDENTITY…";
      showSystemFeedback("auth-feedback", "");
      try {
        const data = await fetch("/login", {
          method: "POST", credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password, requested_node: requestedNode })
        }).then(readApiResponse);
        if (data.status !== "success") throw new Error(data.message || "Sign-in failed.");
        localStorage.setItem("session_user_id", String(data.user_id));
        localStorage.setItem("session_role", data.role);
        localStorage.setItem("session_full_name", data.full_name);
        if (data.role === "producer" && data.session_token) {
          localStorage.setItem("session_producer_token", data.session_token);
        } else {
          localStorage.removeItem("session_producer_token");
        }
        window.location.href = data.redirect_url;
      } catch (error) {
        showSystemFeedback("auth-feedback",
          error.status === 401 || error.status === 403 ?
            (error.message || "Your email, password or account type is incorrect.") :
            "Unable to sign in. " + (error.message || "Check your connection and retry."),
          "error");
        passwordField.value = "";
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }
  });
}


/* session management, page guards and logout */

let verifiedSession = null;

async function initSessionUI() {
  const page = window.location.pathname.split("/").pop() || "index.html";
  const producerPage = page === "producer-portal.html";
  const customerPage = page === "customer-portal.html";
  let user = null;

  // cookies, not browser storage, determine the authenticated identity.
  try {
    const response = await fetch("/session", {
      credentials: "same-origin", cache: "no-store"
    });
    if (response.ok) {
      user = await response.json();
      if (!["customer", "producer"].includes(user.role)) user = null;
    } else if (response.status !== 401) {
      throw new Error("Could not verify your sign-in (HTTP " + response.status + ").");
    }
  } catch (error) {
    console.error("SESSION VERIFICATION ERROR:", error);
    if (producerPage || customerPage) {
      const status = document.getElementById("producer-metrics-status");
      if (status) status.textContent = "Unable to verify your session. Check the API and reload.";
      const history = document.getElementById("order-history-body");
      if (history) history.innerHTML = '<tr><td colspan="5">Unable to verify session. Reload after checking your connection.</td></tr>';
      return false;
    }
  }
  verifiedSession = user;
  if (user) {
    localStorage.setItem("session_user_id", String(user.user_id));
    localStorage.setItem("session_role", user.role);
    localStorage.setItem("session_full_name", user.full_name || "");
  } else {
    ["session_user_id", "session_role", "session_full_name", "session_producer_token"]
      .forEach((key) => localStorage.removeItem(key));
  }

  if (producerPage && (!user || user.role !== "producer")) {
    window.location.replace("producer-login.html?session=expired");
    return false;
  }
  if (customerPage && !user) {
    window.location.replace("customer-login.html?session=expired");
    return false;
  }

  // send authenticated members to their existing portal, not back to login.
  const nodeLinks = document.querySelectorAll(".menu-link");
  nodeLinks.forEach((link) => {
    const target = link.getAttribute("href");
    if (target === "producer-login.html" && user?.role === "producer") {
      link.href = "producer-portal.html";
    }
    if (target === "customer-login.html" && user) {
      link.href = "customer-portal.html";
    }
  });

  if (user) {
    const navRight = document.querySelector(".nav-right");
    if (navRight && !document.getElementById("logout-btn")) {
      const logoutBtn = document.createElement("a");
      logoutBtn.href = "#";
      logoutBtn.className = "nav-item";
      logoutBtn.id = "logout-btn";
      logoutBtn.textContent = "LOGOUT";
      navRight.appendChild(logoutBtn);
      logoutBtn.addEventListener("click", (event) => {
        event.preventDefault();
        logout();
      });
    }
    if (page === "producer-login.html" && user.role === "producer") {
      window.location.replace("producer-portal.html");
      return false;
    }
    if (page === "customer-login.html") {
      window.location.replace("customer-portal.html");
      return false;
    }
  }

  const name = user?.full_name || "";
  const farmerNameSlot = document.getElementById("active-farmer-name");
  const farmNameSlot = document.getElementById("active-farm-name");
  if (farmerNameSlot && name) {
    farmerNameSlot.textContent = name.toUpperCase();
    if (farmNameSlot) farmNameSlot.textContent = "TERMINAL // " + name.toUpperCase();
  }
  const welcomeTitle = document.getElementById("welcome-title");
  if (welcomeTitle && name) {
    welcomeTitle.textContent = "Welcome Back, " + name.split(" ")[0] + ".";
  }
  const manageBtn = document.getElementById("manage-account-btn");
  if (manageBtn) {
    manageBtn.addEventListener("click", (event) => {
      event.preventDefault();
      showAccountOptions();
    });
  }
  return true;
}

async function logout(confirmation = "") {
  // clear the HttpOnly session cookie server-side before navigating away.
  // the frontend also clears its existing local session state.
  try {
    await fetch("/producer/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch (error) {
    console.warn("Could not clear the server cookie:", error);
  } finally {
    localStorage.removeItem("session_user_id");
    localStorage.removeItem("session_role");
    localStorage.removeItem("session_full_name");
    localStorage.removeItem("session_producer_token");
    cart = [];
    invalidateCheckoutAttempt();
    localStorage.removeItem("glh_cart");
    if (confirmation) sessionStorage.setItem("glh_flash_notice", confirmation);
    window.location.href = "index.html";
  }
}

async function deleteAccount() {
  const userId = localStorage.getItem("session_user_id");
  if (!userId) return;
  if (!confirm("Permanently delete this account? Accounts with orders cannot be deleted in this demo.")) return;
  try {
    await fetch("/users/" + encodeURIComponent(userId), {
      method: "DELETE", credentials: "same-origin"
    }).then(readApiResponse);
    await logout("Your account has been deleted successfully.");
  } catch (error) {
    showSystemFeedback("account-feedback",
      error.message || "Unable to delete this account. Please try again.", "error");
  }
}

/* cookie preferences are per browser, independent of which account is signed in */
const COOKIE_CONSENT_KEY = "glh_cookie_consent_v1";

function initConsentWall() {
  let overlay = document.getElementById("consent-intercept");
  // the homepage contains the editorial consent markup. Other entry pages
  // receive the same popup so first-time visitors see it before opting in.
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "consent-intercept";
    overlay.className = "intercept-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "consent-title");
    overlay.style.display = "none";
    overlay.innerHTML = `
      <div class="intercept-modal">
        <div class="intercept-header">
          <span class="system-label text-blue">[GREENFIELD_DATA_PROTOCOL_]</span>
          <h2 class="intercept-title" id="consent-title">We Value Your Privacy</h2>
        </div>
        <div class="intercept-body">
          <p>GLH CO-OP uses essential browser storage and cookies for the cart
          and secure account sessions. Optional analytics and marketing remain
          off unless you opt in.</p>
          <p>Your preference stays saved in this browser across account
          changes. This demo does not currently enable third-party analytics
          or marketing.</p>
        </div>
        <form class="intercept-form" id="consent-form">
          <div class="consent-options">
            <label class="allergen-checkbox"><input type="checkbox" checked disabled>
              <span class="custom-box"></span> STRICTLY NECESSARY</label>
            <label class="allergen-checkbox"><input type="checkbox" id="consent-analytics">
              <span class="custom-box"></span> ANALYTICS &amp; PERFORMANCE</label>
            <label class="allergen-checkbox"><input type="checkbox" id="consent-marketing">
              <span class="custom-box"></span> MARKETING &amp; LOYALTY</label>
          </div>
          <div class="intercept-actions">
            <button type="button" class="system-btn ghost-btn" id="reject-optional-btn">REJECT OPTIONAL</button>
            <button type="submit" class="system-btn ghost-btn">ACCEPT SELECTED</button>
            <button type="button" class="system-btn blue-btn" id="accept-all-btn">ACCEPT ALL</button>
          </div>
        </form>
      </div>`;
    document.body.prepend(overlay);
  }
  // allow preferences to be revised from the footer on any storefront page.
  const footer = document.querySelector(".massive-footer .footer-content");
  if (footer && !document.getElementById("cookie-preferences-btn")) {
    const button = document.createElement("button");
    button.id = "cookie-preferences-btn";
    button.className = "cookie-preferences-toggle";
    button.type = "button";
    button.textContent = "COOKIE PREFERENCES";
    footer.appendChild(button);
  }
  let existing = null;
  try { existing = JSON.parse(localStorage.getItem(COOKIE_CONSENT_KEY) || "null"); }
  catch (_) { existing = null; }

  overlay.style.display = existing ? "none" : "flex";
  if (existing) {
    document.getElementById("consent-analytics").checked = Boolean(existing.analytics);
    document.getElementById("consent-marketing").checked = Boolean(existing.marketing);
  }
  const form = document.getElementById("consent-form");
  if (form) form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitConsent(
      document.getElementById("consent-analytics").checked,
      document.getElementById("consent-marketing").checked
    );
  });
  document.getElementById("accept-all-btn")?.addEventListener("click", () =>
    submitConsent(true, true));
  document.getElementById("reject-optional-btn")?.addEventListener("click", () =>
    submitConsent(false, false));
  document.getElementById("cookie-preferences-btn")?.addEventListener("click", () => {
    overlay.style.display = "flex";
    document.getElementById("consent-analytics").focus();
  });
}

function submitConsent(analytics, marketing) {
  const token = "GLH-" + Date.now() + "-" +
    Math.random().toString(36).slice(2, 11).toUpperCase();
  const choice = { analytics: Boolean(analytics), marketing: Boolean(marketing),
    recorded_at: new Date().toISOString(), token };
  // store the actual choice, not just a dismissal flag; keep it across logout.
  localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify(choice));
  const overlay = document.getElementById("consent-intercept");
  if (overlay) overlay.style.display = "none";

  fetch("/consent", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, analytics: choice.analytics, marketing: choice.marketing })
  }).then(readApiResponse).catch((error) => {
    // the site remains usable offline; a local preference is not a server record.
    console.warn("Consent preference was saved locally but not recorded by the API:", error);
  });
}

/* account management modal */

function showAccountOptions() {
  // toggles the modal off if its already open
  const existing = document.getElementById("account-modal");
  if (existing) {
    existing.remove();
    return;
  }

  const name = localStorage.getItem("session_full_name") || "";
  const modal = document.createElement("div");
  modal.id = "account-modal";
  modal.style.cssText = `
        position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
        background:#fbfbf9; border:1px solid #111; padding:48px;
        z-index:9999; min-width:360px; max-width:480px; width:90%;
        font-family:'Courier New',monospace;
    `;
  modal.innerHTML = `
        <span style="font-size:11px;letter-spacing:.1em;color:#666;">ACCOUNT MANAGEMENT</span>
        <h2 style="margin:16px 0 32px;font-size:24px;">${escapeHtml(name.toUpperCase())}</h2>

        <p id="account-feedback" class="glh-inline-notice" role="status" aria-live="polite" hidden></p>
        <div id="account-main-options">
          <button onclick="showUpdateForm()" style="${_btnStyle("#111", "#fff")}">[ UPDATE DETAILS ]</button>
          <button onclick="deleteAccount()" style="${_btnStyle("transparent", "#111", "1px solid #c00", "#c00")}">[ DELETE ACCOUNT ]</button>
          <button onclick="document.getElementById('account-modal').remove()" style="${_btnStyle("transparent", "#111", "1px solid #111")}">[ CANCEL ]</button>
        </div>

        <div id="account-update-form" style="display:none;">
          <label style="font-size:11px;letter-spacing:.1em;">FULL NAME</label>
          <input id="update-name" value="${escapeHtml(name)}" style="${_inputStyle()}" /><br/>
          <label style="font-size:11px;letter-spacing:.1em;margin-top:16px;display:block;">EMAIL</label>
          <input id="update-email" type="email" placeholder="your@email.com" style="${_inputStyle()}" /><br/>
          <label style="font-size:11px;letter-spacing:.1em;margin-top:16px;display:block;">NEW PASSKEY <span style="color:#999;">(leave blank to keep current)</span></label>
          <input id="update-password" type="password" placeholder="• • • • • • • •" style="${_inputStyle()}" /><br/>
          <button onclick="submitUpdateDetails()" style="${_btnStyle("#111", "#fff")}">[ COMMIT CHANGES ]</button>
          <button onclick="document.getElementById('account-update-form').style.display='none'; document.getElementById('account-main-options').style.display='block';" style="${_btnStyle("transparent", "#111", "1px solid #111")}">[ BACK ]</button>
        </div>
    `;
  document.body.appendChild(modal);

  // pre-fills the email field by fetching the current value from the API
  const userId = localStorage.getItem("session_user_id");
  if (userId) {
    fetch(`/users/${userId}`)
      .then((r) => r.json())
      .then((d) => {
        const emailInput = document.getElementById("update-email");
        if (emailInput && d.email) emailInput.value = d.email;
      })
      .catch(() => {});
  }
}

// helper that builds inline button styles for the modal
function _btnStyle(bg, color, border, borderColor) {
  const b = border || (bg === "transparent" ? "1px solid #111" : "none");
  return `display:block;width:100%;padding:16px;background:${bg};color:${color};font-family:inherit;font-size:12px;letter-spacing:.1em;cursor:pointer;border:${b};margin-bottom:12px;text-align:left;`;
}

// helper that builds inline input styles for the modal
function _inputStyle() {
  return `width:100%;padding:12px;border:1px solid #111;background:transparent;font-family:inherit;font-size:12px;margin-top:6px;box-sizing:border-box;`;
}

function showUpdateForm() {
  // switches the modal to show the update details form
  document.getElementById("account-main-options").style.display = "none";
  document.getElementById("account-update-form").style.display = "block";
}

async function submitUpdateDetails() {
  const userId = localStorage.getItem("session_user_id");
  const fullName = document.getElementById("update-name").value.trim();
  const email = document.getElementById("update-email").value.trim();
  const password = document.getElementById("update-password").value;
  if (!fullName || !email) {
    showSystemFeedback("account-feedback", "Enter your full name and email address.", "error");
    return;
  }
  if (password && password.length < 8) {
    showSystemFeedback("account-feedback", "New passwords must have at least 8 characters.", "error");
    return;
  }
  showSystemFeedback("account-feedback", "");
  try {
    const data = await fetch("/users/" + encodeURIComponent(userId), {
      method: "PUT", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: fullName, email, password })
    }).then(readApiResponse);
    if (data.status !== "success") throw new Error(data.message || "Unable to save profile changes.");
    localStorage.setItem("session_full_name", data.full_name);
    const title = document.getElementById("welcome-title");
    if (title) title.textContent = "Welcome Back, " + data.full_name.split(" ")[0] + ".";
    document.getElementById("account-update-form").style.display = "none";
    document.getElementById("account-main-options").style.display = "block";
    showSystemFeedback("account-feedback",
      password ? "Account updated successfully. Your new password is now active." :
        "Account updated successfully. Your name and email changes have been saved.",
      "success");
  } catch (error) {
    showSystemFeedback("account-feedback",
      error.message || "Unable to save your account details. Please try again.", "error");
  }
}

/* cart page — image synchronisation, quantity steppers and totals */

const CART_DIRECT_DELIVERY_FEE = 15.00;
let checkoutInFlight = false;
const CART_CHECKOUT_LABEL = "PLACE ORDER";

function formatCartCurrency(value) {
  return Number(value).toLocaleString("en-GB", { style: "currency", currency: "GBP" });
}

function calculateCartTotals() {
  const subtotalPence = cart.reduce(
    (sum, item) => sum + Math.round(Number(item.price || 0) * 100) * Number(item.quantity || 0), 0
  );
  const deliveryMethod = document.querySelector('input[name="delivery-method"]:checked')?.value || "hub";
  const deliveryPence = cart.length && deliveryMethod === "direct"
    ? Math.round(CART_DIRECT_DELIVERY_FEE * 100) : 0;
  return {
    subtotal: subtotalPence / 100,
    deliveryFee: deliveryPence / 100,
    vat: 0,
    total: (subtotalPence + deliveryPence) / 100,
    deliveryMethod
  };
}

// existing carts may pre-date the image metadata. Refresh it from the live
// inventory API so cart pictures and Shop Produce use identical source files.
async function refreshCartProductMetadata() {
  if (!cart.length) return;
  try {
    const response = await fetch(`/products?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Inventory unavailable");
    const products = await response.json();
    if (!Array.isArray(products)) throw new Error("Invalid inventory response");
    const byId = new Map(products.map((product) => [Number(product.product_id), product]));
    for (const entry of cart) {
      const product = byId.get(Number(entry.product_id));
      if (!product) continue;
      entry.product_name = product.product_name;
      entry.price = Number(product.price);
      entry.max_stock = Math.max(0, Math.floor(Number(product.stock_level) || 0));
      entry.product_image = product.product_image || "placeholder.png";
      entry.producer_name = product.producer_name || "";
      entry.batch_number = product.batch_number || "";
      entry.allergen_info = product.allergen_info || "";
    }
    saveCart();
    renderCartPage();
  } catch (error) {
    console.warn("Unable to refresh cart product details:", error);
  }
}

function renderCartPage() {
  const container = document.querySelector(".cart-items");
  if (!container) return;
  container.replaceChildren();
  if (cart.length === 0) {
    container.innerHTML = `
      <section class="cart-empty-state">
        <span class="cart-empty-kicker">SOURCING LEDGER</span>
        <h2 class="cart-empty-title">Nothing in the basket. Yet.</h2>
        <p class="cart-empty-copy">Discover fresh produce from the cooperative and build your first order.</p>
        <a class="cart-empty-action" href="products.html">EXPLORE PRODUCE</a>
      </section>`;
    updateOrderSummary();
    return;
  }
  cart.forEach((item, index) => {
    const article = document.createElement("article");
    article.className = "cart-item";
    article.innerHTML = `
      <div class="item-media"><img loading="lazy" alt=""></div>
      <div class="item-details">
        <span class="item-farm"></span>
        <h2 class="item-name"></h2>
        <span class="item-batch"></span>
        <span class="item-allergen"></span>
      </div>
      <div class="item-metrics">
        <div class="metric-cell price">
          <span class="cart-metric-label">PRICE</span>
          <span class="cart-unit-price"></span>
        </div>
        <div class="metric-cell qty">
          <span class="cart-metric-label">QTY</span>
          <div class="cart-qty-buttons">
            <button type="button" class="cart-qty-step cart-decrease">−</button>
            <span class="cart-qty-value"></span>
            <button type="button" class="cart-qty-step cart-increase">+</button>
          </div>
        </div>
        <button type="button" class="metric-cell remove-btn">REMOVE</button>
      </div>
    `;
    const image = article.querySelector(".item-media img");
    image.src = resolveProductImageUrl(item.product_image);
    image.alt = item.product_name || "Produce";
    image.addEventListener("error", () => {
      if (!image.src.endsWith("/assets/placeholder.png")) image.src = "assets/placeholder.png";
    });
    article.querySelector(".item-farm").textContent = (item.producer_name || "GLH CO-OP").toUpperCase();
    article.querySelector(".item-name").textContent = item.product_name || "Produce";
    article.querySelector(".item-batch").textContent = item.batch_number || "";
    const allergen = String(item.allergen_info || "").trim();
    article.querySelector(".item-allergen").textContent =
      allergen && !/^no allergens? present$/i.test(allergen) ? `ALLERGENS: ${allergen.toUpperCase()}` : "";
    article.querySelector(".cart-unit-price").textContent = formatCartCurrency(item.price);

    const quantity = Math.max(1, Math.floor(Number(item.quantity) || 1));
    const maxStock = Math.max(0, Math.floor(Number(item.max_stock) || 0));
    article.querySelector(".cart-qty-value").textContent = String(quantity);
    const minus = article.querySelector(".cart-decrease");
    const plus = article.querySelector(".cart-increase");
    minus.setAttribute("aria-label", `Decrease quantity of ${item.product_name}`);
    plus.setAttribute("aria-label", `Increase quantity of ${item.product_name}`);
    minus.disabled = quantity <= 1;
    plus.disabled = quantity >= maxStock;
    minus.addEventListener("click", () => updateItemQty(index, quantity - 1));
    plus.addEventListener("click", () => updateItemQty(index, quantity + 1));
    article.querySelector(".remove-btn").addEventListener("click", () => removeItem(index));
    container.appendChild(article);
  });
  updateOrderSummary();
}

function updateItemQty(index, requestedQty) {
  const item = cart[index];
  if (!item) return;
  const maxStock = Math.max(1, Math.floor(Number(item.max_stock) || 1));
  const requested = Number(requestedQty);
  if (!Number.isInteger(requested)) return;
  item.quantity = Math.min(Math.max(requested, 1), maxStock);
  invalidateCheckoutAttempt();
  saveCart();
  showSystemFeedback("cart-feedback", "");

  renderCartPage();
}

function removeItem(index) {
  cart.splice(index, 1);
  invalidateCheckoutAttempt();
  saveCart();
  showSystemFeedback("cart-feedback", "Product removed from your cart.", "info");
  renderCartPage();
}

function updateOrderSummary() {
  const table = document.querySelector(".summary-totals");
  if (!table) return;
  const { subtotal, deliveryFee, vat, total } = calculateCartTotals();
  const numeric = table.querySelectorAll(".numeric");
  if (numeric.length === 3) {
    numeric[0].textContent = formatCartCurrency(subtotal);
    numeric[1].textContent = formatCartCurrency(deliveryFee);
    numeric[2].textContent = formatCartCurrency(vat);
  }
  const totalLabel = document.querySelector(".cart-ledger-amount");
  if (totalLabel) totalLabel.textContent = formatCartCurrency(total);
  const stockIssue = cart.some((item) =>
    Number(item.quantity) < 1 || Number(item.quantity) > Number(item.max_stock)
  );
  const warning = document.querySelector(".cart-stock-message");
  if (warning) warning.hidden = !stockIssue;
  const button = document.querySelector(".cart-submit");
  if (button) button.disabled = checkoutInFlight || !cart.length || stockIssue;
}

function initCartDeliverySelection() {
  const collectionPanel = document.getElementById("cart-collection-panel");
  const addressPanel = document.getElementById("cart-address-panel");
  const collectionSelect = document.getElementById("cart-collection-node");
  if (!collectionPanel || !addressPanel || !collectionSelect) return;

  const radios = document.querySelectorAll('input[name="delivery-method"]');
  function syncFields() {
    const direct = document.querySelector('input[name="delivery-method"]:checked')?.value === "direct";
    collectionPanel.hidden = direct;
    addressPanel.hidden = !direct;
    collectionSelect.disabled = direct;
    collectionSelect.required = !direct;
    addressPanel.querySelectorAll("input, select").forEach(field => {
      field.disabled = !direct;
    });
    updateOrderSummary();
  }
  radios.forEach(radio => radio.addEventListener("change", () => {
    invalidateCheckoutAttempt();
    showSystemFeedback("cart-feedback", "");
    syncFields();
  }));
  collectionSelect.addEventListener("change", () => {
    invalidateCheckoutAttempt();
    showSystemFeedback("cart-feedback", "");
  });
  addressPanel.querySelectorAll("input, select").forEach(field => {
    field.addEventListener("change", invalidateCheckoutAttempt);
  });
  addressPanel.querySelectorAll("input").forEach(field => {
    field.addEventListener("input", () => field.setCustomValidity(""));
  });
  syncFields();
}

function getCartRouting() {
  const method = document.querySelector('input[name="delivery-method"]:checked')?.value || "hub";
  if (method === "hub") {
    const node = document.getElementById("cart-collection-node");
    if (!node?.value) {
      node?.reportValidity();
      return null;
    }
    return { collection_node_code: node.value, delivery_address: null };
  }

  const fields = {
    line1: document.getElementById("cart-address-line1"),
    line2: document.getElementById("cart-address-line2"),
    town: document.getElementById("cart-address-town"),
    postcode: document.getElementById("cart-address-postcode"),
    country: document.getElementById("cart-address-country")
  };
  const address = {};
  for (const [key, field] of Object.entries(fields)) {
    if (!field) return null;
    const value = field.value.trim();
    if (!value && key !== "line2") {
      field.setCustomValidity("Please complete this field.");
      field.reportValidity();
      return null;
    }
    if (!field.checkValidity()) {
      field.reportValidity();
      return null;
    }
    address[key] = value;
  }
  return { collection_node_code: null, delivery_address: address };
}

function getOrCreateCheckoutKey() {
  let key = localStorage.getItem("glh_checkout_key");
  if (!key) {
    key = (globalThis.crypto?.randomUUID?.() ||
      "glh-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2));
    localStorage.setItem("glh_checkout_key", key);
  }
  return key;
}

async function verifyCartAgainstInventory() {
  // inspect the latest live stock and prices before asking the server to write.
  // the API repeats these checks under a SQLite transaction.
  const response = await fetch("/products?t=" + Date.now(), {
    cache: "no-store", credentials: "same-origin"
  });
  const products = await readApiResponse(response);
  if (!Array.isArray(products)) throw new Error("Inventory response was invalid.");
  const byId = new Map(products.map(product => [Number(product.product_id), product]));
  let priceChanged = false;
  let stockChanged = false;
  let missing = false;
  let metadataChanged = false;
  for (const item of cart) {
    const latest = byId.get(Number(item.product_id));
    if (!latest) {
      missing = true;
      item.max_stock = 0;
      metadataChanged = true;
      continue;
    }
    const newPrice = Number(latest.price);
    const newStock = Math.max(0, Math.floor(Number(latest.stock_level) || 0));
    if (Math.round(Number(item.price) * 100) !== Math.round(newPrice * 100)) priceChanged = true;
    if (Number(item.quantity) > newStock) stockChanged = true;
    if (Number(item.max_stock) !== newStock) metadataChanged = true;
    item.price = newPrice;
    item.max_stock = newStock;
    item.product_name = latest.product_name;
    item.product_image = latest.product_image || "placeholder.png";
    item.producer_name = latest.producer_name || "";
    item.batch_number = latest.batch_number || "";
    item.allergen_info = latest.allergen_info || "";
  }
  if (priceChanged || stockChanged || missing || metadataChanged) {
    saveCart();
    renderCartPage();
  }
  if (priceChanged || stockChanged || missing) invalidateCheckoutAttempt();
  if (missing) return "A product is no longer listed. Remove it from your cart before checkout.";
  if (stockChanged) return "Some items have less stock available. Review the quantities highlighted in your cart.";
  if (priceChanged) return "One or more prices have changed. The new total is displayed; review it before authorising your order.";
  return null;
}

async function recoverCompletedCheckout() {
  const key = localStorage.getItem("glh_checkout_key");
  if (!key) return false;
  const response = await fetch("/checkout/status?key=" + encodeURIComponent(key), {
    credentials: "same-origin", cache: "no-store"
  });
  if (response.status === 404) return false;
  const result = await readApiResponse(response);
  if (result.status !== "success" || !result.order_id) return false;
  // the first request completed even if its browser response was lost.
  // do not submit a second order; open the original confirmation instead.
  cart = [];
  invalidateCheckoutAttempt();
  saveCart();
  window.location.href = "order-confirmation.html?order_id=" +
    encodeURIComponent(result.order_id);
  return true;
}

async function initiateCheckout() {
  if (checkoutInFlight) return; // Guard before any asynchronous request.
  if (!["customer", "producer"].includes(localStorage.getItem("session_role")) ||
      !localStorage.getItem("session_user_id")) {
    showSystemFeedback("cart-feedback", "Sign in through Customer Node to place this order. Your cart will be saved.", "error");
    const signIn = document.getElementById("cart-sign-in-link");
    if (signIn) signIn.hidden = false;
    return;
  }
  if (!cart.length) {
    showSystemFeedback("cart-feedback", "Your cart is empty. Add some produce to continue.", "error");
    return;
  }
  if (cart.some(item => Number(item.quantity) < 1 ||
      Number(item.quantity) > Number(item.max_stock))) {
    showSystemFeedback("cart-feedback", "Some quantities exceed available stock. Adjust the items before checkout.", "error");
    return;
  }
  const routing = getCartRouting();
  if (!routing) {
    showSystemFeedback("cart-feedback", "Choose a collection node or complete your delivery address.", "error");
    return;
  }
  checkoutInFlight = true;
  const submitButton = document.querySelector(".cart-submit");
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "VERIFYING STOCK…";
    submitButton.setAttribute("aria-busy", "true");
  }
  showSystemFeedback("cart-feedback", "");
  try {
    // recover any successfully recorded prior attempt before examining stock.
    // A completed first attempt will have reduced available inventory.
    if (await recoverCompletedCheckout()) return;
    const issue = await verifyCartAgainstInventory();
    if (issue) {
      showSystemFeedback("cart-feedback", issue, "error");
      return;
    }
    const checkoutKey = getOrCreateCheckoutKey();
    if (submitButton) submitButton.textContent = "RECORDING ORDER…";
    const { total, deliveryMethod } = calculateCartTotals();
    const response = await fetch("/checkout", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cart, delivery_method: deliveryMethod, total_price: total,
        checkout_key: checkoutKey, ...routing
      })
    });
    const data = await readApiResponse(response);
    if (data.status !== "success" || !data.order_id) {
      throw new Error(data.message || "No order reference was returned.");
    }
    cart = [];
    invalidateCheckoutAttempt();
    saveCart();
    window.location.href = "order-confirmation.html?order_id=" +
      encodeURIComponent(data.order_id);
  } catch (error) {
    if (error.status === 409) {
      invalidateCheckoutAttempt();
      await refreshCartProductMetadata();
      showSystemFeedback("cart-feedback",
        error.message || "Stock or pricing changed. Review your cart and try again.", "error");
    } else {
      showSystemFeedback("cart-feedback",
        error.status === 401
          ? "Checkout authentication was rejected by the API. Sign in again; if your portal still shows you signed in, restart the updated Python server. Your cart is saved."
          :
        error.status ? error.message :
        "The connection was interrupted. We cannot confirm whether the order was recorded. Retry with the same cart; duplicate submissions are protected.",
        "error");
      if (error.status === 401) {
        const signIn = document.getElementById("cart-sign-in-link");
        if (signIn) signIn.hidden = false;
      }
    }
    console.error("CHECKOUT ERROR:", error);
  } finally {
    checkoutInFlight = false;
    if (submitButton) {
      submitButton.textContent = CART_CHECKOUT_LABEL;
      submitButton.removeAttribute("aria-busy");
    }
    updateOrderSummary();
  }
}

/* customer portal order history */

function loadOrderHistory(authenticatedCustomerId) {
  const tbody = document.getElementById("order-history-body");
  if (!tbody) return;

  const userId = Number(authenticatedCustomerId);
  if (!Number.isInteger(userId) || userId <= 0) return;

  // fetches all orders for the logged in customer from the API
  fetch(`/orders/${userId}`, { credentials: "same-origin", cache: "no-store" })
    .then((res) => {
      if (!res.ok) {
        const error = new Error("Order history request was rejected (" + res.status + ").");
        error.status = res.status;
        throw error;
      }
      return res.json();
    })
    .then((orders) => {
      if (!Array.isArray(orders)) throw new Error("Invalid order history response.");
      tbody.innerHTML = "";
      if (orders.length === 0) {
        const row = document.createElement("tr");
        const cell = document.createElement("td");
        cell.colSpan = 5;
        cell.className = "order-history-empty";
        const title = document.createElement("h3");
        title.className = "order-history-empty-title";
        title.textContent = "Your first order starts here.";
        const explanation = document.createElement("p");
        explanation.textContent = "You haven't placed any orders yet. Explore the produce available from GLH CO-OP farmers.";
        const shopLink = document.createElement("a");
        shopLink.className = "order-history-empty-link";
        shopLink.href = "products.html";
        shopLink.textContent = "BROWSE PRODUCE →";
        cell.append(title, explanation, shopLink);
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
      }
      orders.forEach((order) => {
        // formats the date to dd/mm/yyyy for UK display
        const date = new Date(order.order_time);
        const formatted = date.toLocaleDateString("en-GB", {
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
        });
        const row = document.createElement("tr");
        // pads the order id to 6 digits to make the GLH reference number
        row.innerHTML = `
          <td class="ref-cell"><a href="order-confirmation.html?order_id=${encodeURIComponent(order.order_id)}">GLH-${String(order.order_id).padStart(6, "0")}</a></td>
          <td>${formatted}</td>
          <td>${order.item_count}</td>
          <td>£ ${parseFloat(order.total_price).toFixed(2)}</td>
          <td class="status-cell">${order.fulfilment_status || "Pending"}</td>`;
        tbody.appendChild(row);
      });
    })
    .catch((err) => {
      console.error("ORDER HISTORY ERROR:", err);
      const message = err.status === 403
        ? "SIGNED IN, BUT THE API DENIED ACCESS TO THIS ORDER HISTORY. RESTART THE UPDATED API AND SIGN IN AGAIN."
        : err.status === 401
          ? "YOUR ORDER SESSION HAS EXPIRED. SIGN IN AGAIN."
          : "SYSTEM ERROR: Could not load order manifest. " + (err.status ? "HTTP " + err.status : "Check the API server.");
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 5;
      cell.style.cssText = "font:12px/1.6 'Courier New',monospace;padding:24px;color:#a22;";
      cell.textContent = message;
      row.appendChild(cell);
      tbody.replaceChildren(row);
    });
}


async function initCustomerPortal() {
  // use the signed HttpOnly cookie as the single source of identity.
  // A different browser's old localStorage value must never select an account.
  const status = document.getElementById("order-history-body");
  if (!status) return;
  try {
    const response = await fetch("/session", {
      method: "GET", credentials: "same-origin", cache: "no-store"
    });
    if (!response.ok) {
      if (response.status === 401) {
        for (const key of [
          "session_user_id", "session_role", "session_full_name",
          "session_producer_token"
        ]) localStorage.removeItem(key);
        window.location.replace("customer-login.html?session=expired");
        return;
      }
      throw new Error("Unable to verify customer session (" + response.status + ").");
    }
    const user = await response.json();
    if (!["customer", "producer"].includes(user.role)) {
      window.location.replace("customer-login.html?session=customer-required");
      return;
    }
    localStorage.setItem("session_user_id", String(user.user_id));
    localStorage.setItem("session_role", user.role);
    localStorage.setItem("session_full_name", user.full_name || "");
    const welcome = document.getElementById("welcome-title");
    if (welcome) welcome.textContent = "Welcome Back, " +
      (user.full_name || "Member").split(" ")[0] + ".";
    loadOrderHistory(user.user_id);
  } catch (error) {
    console.error("CUSTOMER SESSION ERROR:", error);
    status.innerHTML = '<tr><td colspan="5">Unable to verify your session. Please reload or sign in again.</td></tr>';
  }
}

/* single DOMContentLoaded entry point */

document.addEventListener("DOMContentLoaded", async () => {
  // verify a signed server session before rendering protected portal data.
  if (!(await initSessionUI())) return;
  updateCartCount();
  const flash = sessionStorage.getItem("glh_flash_notice");
  if (flash) {
    sessionStorage.removeItem("glh_flash_notice");
    const notice = document.createElement("p");
    notice.className = "glh-inline-notice glh-flash-notice";
    notice.dataset.kind = "success";
    notice.setAttribute("role", "status");
    notice.textContent = flash;
    document.querySelector(".global-nav")?.insertAdjacentElement("afterend", notice);
  }
  initConsentWall();
  initShopSearch();

  const page = window.location.pathname.split("/").pop() || "index.html";

  // only fetches inventory on pages that need it
  if (page === "products.html" || page === "producer-portal.html") {
    fetchInventoryData("/products");
  }

  if (page === "customer-portal.html") {
    initCustomerPortal();
  }

  if (page === "cart.html") {
    renderCartPage();
    refreshCartProductMetadata();

    // show the relevant collection or home-delivery form.
    initCartDeliverySelection();

    // check whether a prior submission succeeded despite a lost response,
    // including after the customer reloads the cart.
    if (localStorage.getItem("glh_checkout_key")) {
      checkoutInFlight = true;
      updateOrderSummary();
      recoverCompletedCheckout().catch(error => {
        showSystemFeedback("cart-feedback",
          "We could not verify your previous checkout. Keep this cart unchanged and try again.", "error");
        console.warn("CHECKOUT RECOVERY ERROR:", error);
      }).finally(() => {
        checkoutInFlight = false;
        updateOrderSummary();
      });
    }

    // wires up the checkout button
    const submitBtn = document.querySelector(".cart-submit");
    if (submitBtn) {
      submitBtn.addEventListener("click", (e) => {
        e.preventDefault();
        initiateCheckout();
      });
    }
  }
});
