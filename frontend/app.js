/* G L H // CO-OP  app.js */

/* cart state management */

// loads the cart from local storage or starts with an empty array
let cart = JSON.parse(localStorage.getItem("glh_cart")) || [];

// Encode user-supplied or database-supplied text before adding it to HTML templates.
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
  // finds the cart link in the nav and updates the number in brackets
  const counts = document.querySelectorAll(".nav-item");
  counts.forEach((el) => {
    if (el.innerText.includes("CART")) {
      el.innerText = `CART [${cart.reduce((sum, item) => sum + item.quantity, 0)}]`;
    }
  });
}

function addToCart(id, name, price, stock, requestedQuantity = 1, productMetadata = {}) {
  const available = Math.max(0, Math.floor(Number(stock) || 0));
  const quantity = Number(requestedQuantity);
  if (available <= 0) {
    alert("SYSTEM HALT: Inventory depleted.");
    return false;
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    alert("SYSTEM HALT: Select a valid quantity.");
    return false;
  }
  const existing = cart.find((item) => Number(item.product_id) === Number(id));
  const alreadyInCart = existing ? Number(existing.quantity) || 0 : 0;
  if (alreadyInCart + quantity > available) {
    alert(`SYSTEM HALT: Maximum available stock (${available}) reached. You already have ${alreadyInCart} in your cart.`);
    return false;
  }
  // Keep the exact produce image, producer and trace data with the cart item.
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

/* inventory retrieval and distribution */

function fetchInventoryData(url) {
  // appends a timestamp to the URL to prevent the browser from caching the response
  const cacheBustUrl = `${url}?t=${new Date().getTime()}`;

  fetch(cacheBustUrl, { cache: "no-store" })
    .then((response) => {
      if (!response.ok)
        throw new Error("Network latency or server rejection detected.");
      return response.json();
    })
    .then((data) => {
      console.log("SYSTEM LOG: Data payload secured.", data);
      distributeData(data);
    })
    .catch((error) => console.error("SYSTEM ERROR:", error));
}

function distributeData(inventory) {
  // works out which node we are on and sends data to the right render function
  const shopGrid = document.getElementById("shop-inventory-grid");
  const ledgerTable = document.getElementById("producer-ledger-body");

  if (shopGrid) populateShop(inventory, shopGrid);
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

// Correct image extensions used by older database seed versions.
const LEGACY_PRODUCT_IMAGE_NAMES = Object.freeze({
  "basil.png": "basil.jpg",
  "tarragon.png": "tarragon.jpeg",
  "hen ow.png": "hen ow.jpeg",
  "amber honey.png": "amber honey.jpg",
});

function resolveProductImageUrl(imageName) {
  // Paths are relative to the frontend page; always use the assets directory.
  const supplied = String(imageName || "placeholder.png").trim();
  const basename = supplied.split(/[\\/]/).pop() || "placeholder.png";
  const filename = LEGACY_PRODUCT_IMAGE_NAMES[basename.toLowerCase()] || basename;
  return "assets/" + encodeURIComponent(filename);
}

function populateShop(inventory, container) {
  container.innerHTML = "";

  // Alphabetical by the product's name, not by producer or batch.
  const sortedInventory = [...inventory].sort((a, b) =>
    String(a.product_name || "").localeCompare(
      String(b.product_name || ""),
      "en-GB",
      { sensitivity: "base", numeric: true },
    ) || Number(a.product_id) - Number(b.product_id)
  );

  sortedInventory.forEach((item) => {
    const card = document.createElement("div");
    card.className = "product-card";

    // Resolve legacy .png filenames and safely encode spaces for the browser.
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
    let formattedAllergens = `[${escapeHtml(String(item.allergen_info || "").toUpperCase())}]`;
    let formattedPrice = `£${parseFloat(item.price).toFixed(2)}`;

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

    // Let customers choose a quantity on the shop card before adding to cart.
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
    row.querySelector(".ledger-remove-btn").addEventListener("click", () => deleteProduct(item.product_id));
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
  set("edit-product-allergens", item.allergen_info);
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
    const payload = {
      product_name: document.getElementById("edit-product-name").value.trim(),
      batch_number: document.getElementById("edit-product-batch").value.trim(),
      price: Number(document.getElementById("edit-product-price").value),
      stock_level: Number(document.getElementById("edit-product-stock").value),
      harvest_date: document.getElementById("edit-product-harvest").value || null,
      allergen_info: document.getElementById("edit-product-allergens").value.trim(),
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
      showSystemFeedback("ledger-feedback", result.message || "Changes saved to your product listing.", "success");
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
  ledgerForm.addEventListener("submit", async function (event) {
    event.preventDefault();
    const selected = [...document.querySelectorAll(".allergen-check:checked")];
    if (!selected.length) {
      showSystemFeedback("ledger-feedback", "Select all applicable allergens or 'No Allergens Present' before saving.", "error");
      return;
    }
    const none = selected.some(cb => cb.id === "no-allergens");
    if (none && selected.length > 1) {
      showSystemFeedback("ledger-feedback", "'No Allergens Present' cannot be combined with other allergens.", "error");
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
    formData.append("allergen_info", selected.map(cb => cb.parentElement.textContent.trim()).join(", "));
    if (imageFile) formData.append("product_image", imageFile);
    button.disabled = true;
    button.textContent = "SAVING PRODUCT…";
    showSystemFeedback("ledger-feedback", "");
    try {
      const result = await fetch("/products", {
        method: "POST", credentials: "same-origin", body: formData
      }).then(readApiResponse);
      ledgerForm.reset();
      showSystemFeedback("ledger-feedback", "New product added to your inventory.", "success");
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

async function deleteProduct(productId) {
  if (!confirm("Remove this product from your inventory? Existing orders will remain on record.")) return;
  try {
    const result = await fetch("/products/" + encodeURIComponent(productId), {
      method: "DELETE", credentials: "same-origin"
    }).then(readApiResponse);
    showSystemFeedback("ledger-feedback", "Product removed from your inventory.", "success");
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

        // Registration does not sign in the new customer. End any previous
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
        // Preserve the guest shopping cart for checkout after sign-in.
        window.location.replace("customer-login.html?registered=1");
      } catch (error) {
        console.error("REGISTRATION ERROR:", error);
        showRegistrationError(error.message || "Unable to create your account.");
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = originalLabel;
      }
    }

    // login path
    else if (isLoginMode) {
      const email = document.getElementById("user-id").value;
      const password = document.getElementById("passkey").value;

      // reads the mode label to determine which terminal is being used
      const modeText = document.querySelector(".auth-mode").innerText;
      const requestedNode = modeText.includes("PRODUCER")
        ? "producer"
        : "customer";

      console.log(
        `SYSTEM LOG: Initiating authentication for [${email}] on [${requestedNode.toUpperCase()}] node...`,
      );

      fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email,
          password: password,
          requested_node: requestedNode,
        }),
      })
        .then((res) => {
          if (!res.ok && res.status !== 401 && res.status !== 403)
            throw new Error("Server failure.");
          return res.json();
        })
        .then((data) => {
          if (data.status === "success") {
            console.log(`AUTH SUCCESS: Role: ${data.role.toUpperCase()}`);
            // A signed session is also supplied as a first-party HttpOnly cookie.
            // Older localStorage-based sessions remain compatible.

            // saves the session data to local storage
            localStorage.setItem("session_user_id", data.user_id);
            localStorage.setItem("session_role", data.role);
            localStorage.setItem("session_full_name", data.full_name);
            if (data.role === "producer" && data.session_token) {
              localStorage.setItem("session_producer_token", data.session_token);
            } else {
              localStorage.removeItem("session_producer_token");
            }

            // The dashboard can authenticate through the HttpOnly cookie,
            // even if the legacy localStorage token was not persisted.

            // redirects to the correct portal based on role
            window.location.href = data.redirect_url;
          } else {
            alert(`SYSTEM HALT: Access Denied. ${data.message}`);
            // clears the passkey field so the user can try again
            document.getElementById("passkey").value = "";
          }
        })
        .catch((err) => {
          console.error("AUTH ERROR:", err);
          alert("Unable to complete sign-in. Check the browser Console and API connection.");
        });
    }
  });
}


/* session management, page guards and logout */

function initSessionUI() {
  const userId = localStorage.getItem("session_user_id");
  const role = localStorage.getItem("session_role");
  const name = localStorage.getItem("session_full_name");
  const producerToken = localStorage.getItem("session_producer_token");
  const page = window.location.pathname.split("/").pop() || "index.html";

  // page guards: bounce unauthenticated users back to login
  // Customer Portal verifies its identity through /session, not localStorage.
  // Using a stale browser ID here can cause a redirect or order-history loop.
  if (page === "producer-portal.html" && (!userId || role !== "producer")) {
    // The backend authenticates dashboard requests with its signed cookie;
    // an absent localStorage token is not a reason to bounce the page.
    window.location.replace("producer-login.html");
    return;
  }

  // stops any logged in user from seeing the login form again
  // Customer login is always accessible so expired sessions can sign in again.
  // Keep the producer login form available when visited explicitly.
  // The API replaces any old producer session when credentials are submitted.

  // injects the logout button into the nav if the user is logged in
  if (userId) {
    const navRight = document.querySelector(".nav-right");
    if (navRight && !document.getElementById("logout-btn")) {
      const logoutBtn = document.createElement("a");
      logoutBtn.href = "#";
      logoutBtn.className = "nav-item";
      logoutBtn.id = "logout-btn";
      logoutBtn.innerText = "LOGOUT";

      navRight.appendChild(logoutBtn);

      logoutBtn.addEventListener("click", function (e) {
        e.preventDefault();
        logout();
      });
    }
  }

  // updates the producer name in the terminal header
  const farmerNameSlot = document.getElementById("active-farmer-name");
  const farmNameSlot = document.getElementById("active-farm-name");
  if (farmerNameSlot && name) {
    farmerNameSlot.innerText = name.toUpperCase();
    if (farmNameSlot) {
      farmNameSlot.innerText = `TERMINAL // ${name.toUpperCase()}`;
    }
  }

  // updates the welcome message on the customer portal with the users first name
  const welcomeTitle = document.getElementById("welcome-title");
  if (welcomeTitle && name) {
    welcomeTitle.innerText = `Welcome Back, ${name.split(" ")[0]}.`;
  }

  // wires up the manage account button if it exists on this page
  const manageBtn = document.getElementById("manage-account-btn");
  if (manageBtn) {
    manageBtn.addEventListener("click", function (e) {
      e.preventDefault();
      showAccountOptions();
    });
  }
}

async function logout() {
  // Clear the HttpOnly session cookie server-side before navigating away.
  // The frontend also clears its existing local session state.
  try {
    await fetch("/producer/logout", {
      method: "POST",
      credentials: "same-origin",
    });
  } catch (error) {
    console.warn("Could not clear the server cookie:", error);
  } finally {
    const userId = localStorage.getItem("session_user_id");
    if (userId) localStorage.removeItem(`glh_consent_${userId}`);
    localStorage.removeItem("session_user_id");
    localStorage.removeItem("session_role");
    localStorage.removeItem("session_full_name");
    localStorage.removeItem("session_producer_token");
    cart = [];
    localStorage.removeItem("glh_cart");
    window.location.href = "index.html";
  }
}

function deleteAccount() {
  const userId = localStorage.getItem("session_user_id");
  if (!userId) return;

  if (
    !confirm(
      "SYSTEM QUERY: Authorize permanent account deletion? This action cannot be undone.",
    )
  )
    return;

  // sends a DELETE request to the API with the user id in the URL
  fetch(`/users/${userId}`, { method: "DELETE" })
    .then((response) => {
      if (response.ok) {
        alert("Account successfully purged from system.");
        // calls logout to clear the session after deletion
        logout();
      } else {
        throw new Error("Server rejected deletion.");
      }
    })
    .catch((err) => {
      console.error("ACCOUNT DELETION ERROR:", err);
      alert("CRITICAL ERROR: Account deletion failed.");
    });
}


/* cookie consent wall */

function initConsentWall() {
  const overlay = document.getElementById("consent-intercept");
  if (!overlay) return;

  // scopes the consent key to the logged in user so each person sees the form once
  const userId = localStorage.getItem("session_user_id");
  const consentKey = userId ? `glh_consent_${userId}` : "glh_consent_anon";

  // hides the overlay if this user has already given consent
  if (localStorage.getItem(consentKey)) {
    overlay.style.display = "none";
    return;
  }

  overlay.style.display = "flex";

  // wires up the accept selected button
  const form = document.getElementById("consent-form");
  if (form) {
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      const analytics = document.getElementById("consent-analytics").checked;
      const marketing = document.getElementById("consent-marketing").checked;
      submitConsent(analytics, marketing, consentKey);
    });
  }

  // wires up the accept all button which passes true for both flags
  const acceptAllBtn = document.getElementById("accept-all-btn");
  if (acceptAllBtn) {
    acceptAllBtn.addEventListener("click", function () {
      submitConsent(true, true, consentKey);
    });
  }
}

function submitConsent(analytics, marketing, consentKey) {
  const userId = localStorage.getItem("session_user_id");
  // generates a unique token for this consent record
  const token =
    "GLH-" +
    (userId || "ANON") +
    "-" +
    Date.now() +
    "-" +
    Math.random().toString(36).substr(2, 9).toUpperCase();

  // posts the consent preferences to the API for GDPR record keeping
  fetch("/consent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, analytics, marketing }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.status === "success") {
        // saves the token to local storage so the modal doesnt show again
        localStorage.setItem(consentKey, token);
        console.log(`GDPR LOG: Consent committed — token: ${token}`);
      }
    })
    .catch((err) =>
      console.warn("CONSENT POST FAILED (server may be offline):", err),
    )
    .finally(() => {
      // always hides the overlay even if the server was unreachable
      const overlay = document.getElementById("consent-intercept");
      if (overlay) overlay.style.display = "none";
      // persists the dismissal locally if the server call failed
      if (!localStorage.getItem(consentKey)) {
        localStorage.setItem(consentKey, "local-" + Date.now());
      }
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

function submitUpdateDetails() {
  const userId = localStorage.getItem("session_user_id");
  const fullName = document.getElementById("update-name").value.trim();
  const email = document.getElementById("update-email").value.trim();
  const password = document.getElementById("update-password").value;

  if (!fullName || !email) {
    alert("SYSTEM HALT: Name and email are required fields.");
    return;
  }

  // sends a PUT request to update the user record on the server
  fetch(`/users/${userId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ full_name: fullName, email, password }),
  })
    .then((r) => r.json())
    .then((data) => {
      if (data.status === "success") {
        // updates the session name in local storage to match the new value
        localStorage.setItem("session_full_name", data.full_name);
        alert("PROFILE UPDATE: Details successfully committed to ledger.");
        document.getElementById("account-modal").remove();

        // refreshes the welcome title on the customer portal without a page reload
        const welcomeTitle = document.getElementById("welcome-title");
        if (welcomeTitle) {
          welcomeTitle.innerText = `Welcome Back, ${data.full_name.split(" ")[0]}.`;
        }
      } else {
        alert(`SYSTEM HALT: Update failed. ${data.message || ""}`);
      }
    })
    .catch((err) => {
      console.error("UPDATE ERROR:", err);
      alert("CRITICAL ERROR: Failed to commit profile update.");
    });
}


/* cart page — image synchronisation, quantity steppers and totals */

const CART_DIRECT_DELIVERY_FEE = 15.00;

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

// Existing carts may pre-date the image metadata. Refresh it from the live
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
    const empty = document.createElement("p");
    empty.className = "cart-empty-message";
    empty.textContent = "YOUR CART IS CURRENTLY EMPTY.";
    container.appendChild(empty);
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
  saveCart();
  renderCartPage();
}

function removeItem(index) {
  cart.splice(index, 1);
  saveCart();
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
  if (button) button.disabled = !cart.length || stockIssue;
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
  radios.forEach(radio => radio.addEventListener("change", syncFields));
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

function initiateCheckout() {
  const userId = localStorage.getItem("session_user_id");
  if (!userId) {
    alert("SYSTEM LOG: Authentication required to execute transaction. Routing to Customer Node.");
    window.location.href = "customer-login.html";
    return;
  }
  if (!cart.length) {
    alert("SYSTEM HALT: Cannot process an empty ledger.");
    return;
  }
  if (cart.some((item) => Number(item.quantity) < 1 || Number(item.quantity) > Number(item.max_stock))) {
    alert("SYSTEM HALT: Some products exceed available stock. Please adjust your cart.");
    return;
  }
  const routing = getCartRouting();
  if (!routing) return;
  const { total, deliveryMethod } = calculateCartTotals();
  fetch("/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customer_id: userId, cart, delivery_method: deliveryMethod, total_price: total, ...routing })
  })
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Checkout was rejected.");
      return data;
    })
    .then((data) => {
      if (data.status === "success") {
        cart = [];
        saveCart();
        window.location.href = "order-confirmation.html?order_id=" + encodeURIComponent(data.order_id);
      } else {
        alert(`SYSTEM ERROR: ${data.message || "Unable to complete transaction."}`);
      }
    })
    .catch((error) => {
      console.error("CHECKOUT ERROR:", error);
      alert(`SYSTEM ERROR: ${error.message}`);
    });
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
      if (!res.ok) throw new Error("Order history request was rejected (" + res.status + ").");
      return res.json();
    })
    .then((orders) => {
      if (!Array.isArray(orders)) throw new Error("Invalid order history response.");
      tbody.innerHTML = "";
      if (orders.length === 0) {
        tbody.innerHTML =
          "<tr><td colspan='5' style=\"font-family:'Courier New',monospace;font-size:12px;padding:24px;color:#555;\">NO ORDERS ON RECORD.</td></tr>";
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
      tbody.innerHTML =
        "<tr><td colspan='5' style=\"font-family:'Courier New',monospace;font-size:12px;padding:24px;color:#c00;\">SYSTEM ERROR: Could not load order manifest.</td></tr>";
    });
}


async function initCustomerPortal() {
  // Use the signed HttpOnly cookie as the single source of identity.
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
    if (user.role !== "customer") {
      window.location.replace("customer-login.html?session=customer-required");
      return;
    }
    localStorage.setItem("session_user_id", String(user.user_id));
    localStorage.setItem("session_role", "customer");
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

document.addEventListener("DOMContentLoaded", () => {
  // runs on every page load
  initSessionUI();
  updateCartCount();
  initConsentWall();

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

    // Show the relevant collection or home-delivery form.
    initCartDeliverySelection();

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
