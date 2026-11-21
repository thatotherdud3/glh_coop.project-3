/* G L H // CO-OP  app.js */

/* cart state management */

// loads the cart from local storage or starts with an empty array
let cart = JSON.parse(localStorage.getItem("glh_cart")) || [];

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

function addToCart(id, name, price, stock) {
  if (stock <= 0) {
    alert("SYSTEM HALT: Inventory depleted.");
    return;
  }

  // checks if the item is already in the cart
  let existing = cart.find((i) => i.product_id === id);
  if (existing) {
    // stops the user going over the available stock level
    if (existing.quantity >= stock) {
      alert(`SYSTEM HALT: Maximum available stock (${stock}) reached.`);
      return;
    }
    existing.quantity += 1;
  } else {
    // adds the item as a new entry in the cart array
    cart.push({
      product_id: id,
      product_name: name,
      price: price,
      quantity: 1,
      max_stock: stock,
    });
  }

  saveCart();
  console.log(`ASSET SECURED: ${name} added to local cart.`);
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

  inventory.forEach((item) => {
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
    let formattedAllergens = `[${item.allergen_info.toUpperCase()}]`;
    let formattedPrice = `£${parseFloat(item.price).toFixed(2)}`;

    card.innerHTML = `
        <div class="product-image-slot" style="width: 100%; aspect-ratio: 4 / 3; overflow: hidden; border-bottom: 1px solid #111111;">
          <img
            class="product-image"
            src="${imagePath}"
            alt="${item.product_name}"
            loading="lazy"
            style="width: 100%; height: 100%; object-fit: cover; display: block; background-color: #e0e0e0;"
          />
        </div>
        <div class="product-details">
          <div class="product-header">
            <span class="product-vendor">PRODUCER: ${item.producer_name.toUpperCase()}</span>
            <div class="product-meta-right">
              <span class="box-index">${item.batch_number}</span>
              <span class="status-badge ${badgeClass}">${status}</span>
            </div>
          </div>
          <h2 class="box-title">${item.product_name}</h2>
          <span class="product-allergen">${formattedAllergens}</span>
          <span class="product-price">${formattedPrice}</span>
        </div>
        <button class="product-action" onclick="addToCart(${item.product_id}, '${item.product_name.replace(/'/g, "\\'")}', ${item.price}, ${item.stock_level})">
          <span>${actionText}</span>
          <span class="action-icon">${actionIcon}</span>
        </button>
    `;

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
  container.innerHTML = "";

  inventory.forEach((item) => {
    // sets the status badge based on stock level
    let status = "ACTIVE";
    let badgeClass = "active";

    if (item.stock_level === 0) {
      status = "OUT OF STOCK";
      badgeClass = "out-of-stock";
    } else if (item.stock_level <= 20) {
      status = "LOW STOCK";
      badgeClass = "low-stock";
    }

    // builds and appends a table row for each product
    const row = document.createElement("tr");
    row.innerHTML = `
            <td class="sku-cell">${item.batch_number}</td>
            <td class="name-cell">${item.product_name}</td>
            <td class="data-cell">${item.stock_level}</td>
            <td class="data-cell">£${parseFloat(item.price).toFixed(2)}</td>
            <td class="data-cell">
                <span class="status-badge ${badgeClass}">${status}</span>
            </td>
            <td class="action-cell">
                <button class="ledger-remove-btn" onclick="deleteProduct(${item.product_id})">REMOVE</button>
            </td>
        `;
    container.appendChild(row);
  });
}


/* producer intake manifest form */

const ledgerForm = document.getElementById("ledger-form");

if (ledgerForm) {
  ledgerForm.addEventListener("submit", function (event) {
    event.preventDefault();

    // checks that at least one allergen box is ticked before submitting
    const allergenCheckboxes = document.querySelectorAll(
      ".allergen-check:checked",
    );
    if (allergenCheckboxes.length === 0) {
      alert(
        "SYSTEM HALT: Regulatory compliance failure. Select at least one allergen.",
      );
      return;
    }

    const formData = new FormData();
    const imageFile = document.getElementById("input-image").files[0];

    // reads the producer id from the session so it gets stored with the product
    const activeProducerId = localStorage.getItem("session_user_id") || 1;
    formData.append("producer_id", activeProducerId);

    formData.append(
      "batch_number",
      ledgerForm.querySelector('input[placeholder="e.g. BATCH-2026-X1"]').value,
    );
    formData.append(
      "product_name",
      ledgerForm.querySelector('input[placeholder="Product Descriptor"]').value,
    );
    formData.append(
      "stock_level",
      document.getElementById("input-stock").value,
    );
    formData.append("price", document.getElementById("input-price").value);

    const harvestDate = document.getElementById("input-harvest-date");
    if (harvestDate && harvestDate.value) {
      formData.append("harvest_date", harvestDate.value);
    }

    // joins the ticked allergen labels into a single comma separated string
    let allergens = Array.from(allergenCheckboxes)
      .map((cb) => cb.parentElement.textContent.trim())
      .join(", ");
    formData.append("allergen_info", allergens);

    if (imageFile) {
      formData.append("product_image", imageFile);
    }

    // posts the form data to the API as multipart
    fetch("http://127.0.0.1:8000/products", {
      method: "POST",
      body: formData,
    })
      .then((response) => {
        if (!response.ok) throw new Error("Server rejected the asset upload.");
        return response.json();
      })
      .then((data) => {
        alert("Stock and Visual Asset successfully committed.");
        ledgerForm.reset();
        // refreshes the ledger table to show the new entry
        fetchInventoryData("http://127.0.0.1:8000/products");
        if (typeof window.refreshProducerDashboard === "function") {
          window.refreshProducerDashboard();
        }
      })
      .catch((error) => {
        console.error("POST ERROR:", error);
        alert("SYSTEM HALT: Failed to commit stock. " + error.message);
      });
  });
}

/* product deletion */

function deleteProduct(productId) {
  if (
    !confirm(
      `SYSTEM QUERY: Authorize permanent deletion of Product ID ${productId}?`,
    )
  )
    return;

  // sends a DELETE request to the API with the product id in the URL
  fetch(`http://127.0.0.1:8000/products/${productId}`, {
    method: "DELETE",
    mode: "cors",
    headers: { "Access-Control-Allow-Origin": "*" },
  })
    .then((response) => {
      if (response.ok) {
        console.log(`DELETION SUCCESS: ID ${productId} purged.`);
        // reloads the ledger so the deleted row disappears straight away
        fetchInventoryData("http://127.0.0.1:8000/products");
        if (typeof window.refreshProducerDashboard === "function") {
          window.refreshProducerDashboard();
        }
      } else {
        throw new Error("Server rejected the purge request.");
      }
    })
    .catch((error) => {
      console.error("DELETION ERROR:", error);
      alert("CRITICAL ERROR: Purge failed.");
    });
}


/* identity and authentication */

let authFormObj = document.querySelector(".auth-form");
// checks which type of form is on the page
let isLoginMode = document.getElementById("user-id");
let isRegistrationMode = document.getElementById("passkey-confirm");

if (authFormObj) {
  authFormObj.addEventListener("submit", function (event) {
    event.preventDefault();

    // registration path
    if (isRegistrationMode) {
      const fullName = document.getElementById("customer-alias").value;
      const email = document.getElementById("customer-email").value;
      const password = document.getElementById("passkey").value;
      const confirmPassword = document.getElementById("passkey-confirm").value;

      // validates both passkey fields match before sending to the API
      if (password !== confirmPassword) {
        alert("SYSTEM HALT: Passkeys do not match. Verification failed.");
        return;
      }

      console.log(`SYSTEM LOG: Initiating registration for [${email}]...`);

      fetch("http://127.0.0.1:8000/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          full_name: fullName,
          email: email,
          password: password,
          role: "customer",
        }),
      })
        .then((res) => {
          if (!res.ok && res.status !== 409) throw new Error("Server failure.");
          return res.json();
        })
        .then((data) => {
          if (data.status === "success") {
            alert(
              "Account successfully established. Proceeding to authentication portal.",
            );
            // redirects to the login page after successfull registration
            window.location.href = "customer-login.html";
          } else {
            alert(`SYSTEM HALT: Registration Denied. ${data.message}`);
          }
        })
        .catch((err) => console.error("REG ERROR:", err));
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

      fetch("http://127.0.0.1:8000/login", {
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

            // saves the session data to local storage
            localStorage.setItem("session_user_id", data.user_id);
            localStorage.setItem("session_role", data.role);
            localStorage.setItem("session_full_name", data.full_name);
            if (data.role === "producer" && data.session_token) {
              localStorage.setItem("session_producer_token", data.session_token);
            } else {
              localStorage.removeItem("session_producer_token");
            }

            // redirects to the correct portal based on role
            window.location.href = data.redirect_url;
          } else {
            alert(`SYSTEM HALT: Access Denied. ${data.message}`);
            // clears the passkey field so the user can try again
            document.getElementById("passkey").value = "";
          }
        })
        .catch((err) => console.error("AUTH ERROR:", err));
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
  if (page === "customer-portal.html" && !userId) {
    window.location.href = "customer-login.html";
    return;
  }
  if (
    page === "producer-portal.html" &&
    (!userId || role !== "producer" || !producerToken)
  ) {
    // An old browser session without the new signed producer token
    // must sign in again. Do not loop between the two pages.
    localStorage.removeItem("session_user_id");
    localStorage.removeItem("session_role");
    localStorage.removeItem("session_full_name");
    localStorage.removeItem("session_producer_token");
    window.location.replace("producer-login.html");
    return;
  }

  // stops any logged in user from seeing the login form again
  if (page === "customer-login.html" && userId) {
    window.location.href = "customer-portal.html";
    return;
  }
  if (page === "producer-login.html" && userId && role === "producer") {
    if (producerToken) {
      window.location.replace("producer-portal.html");
      return;
    }
    // Stale session: retain the login form instead of redirecting to
    // the producer portal without valid credentials.
    localStorage.removeItem("session_user_id");
    localStorage.removeItem("session_role");
    localStorage.removeItem("session_full_name");
  }

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

function logout() {
  const userId = localStorage.getItem("session_user_id");
  // removes the session scoped consent key so the next user sees the form
  if (userId) localStorage.removeItem(`glh_consent_${userId}`);
  localStorage.removeItem("session_user_id");
  localStorage.removeItem("session_role");
  localStorage.removeItem("session_full_name");
  localStorage.removeItem("session_producer_token");
  // clears the cart so it doesnt carry over to the next session
  cart = [];
  localStorage.removeItem("glh_cart");
  // returns the user to the homepage
  window.location.href = "index.html";
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
  fetch(`http://127.0.0.1:8000/users/${userId}`, { method: "DELETE" })
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
  fetch("http://127.0.0.1:8000/consent", {
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
        <h2 style="margin:16px 0 32px;font-size:24px;">${name.toUpperCase()}</h2>

        <div id="account-main-options">
          <button onclick="showUpdateForm()" style="${_btnStyle("#111", "#fff")}">[ UPDATE DETAILS ]</button>
          <button onclick="deleteAccount()" style="${_btnStyle("transparent", "#111", "1px solid #c00", "#c00")}">[ DELETE ACCOUNT ]</button>
          <button onclick="document.getElementById('account-modal').remove()" style="${_btnStyle("transparent", "#111", "1px solid #111")}">[ CANCEL ]</button>
        </div>

        <div id="account-update-form" style="display:none;">
          <label style="font-size:11px;letter-spacing:.1em;">FULL NAME</label>
          <input id="update-name" value="${name}" style="${_inputStyle()}" /><br/>
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
    fetch(`http://127.0.0.1:8000/users/${userId}`)
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
  fetch(`http://127.0.0.1:8000/users/${userId}`, {
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


/* cart page rendering */

function renderCartPage() {
  const cartContainer = document.querySelector(".cart-items");
  if (!cartContainer) return;

  cartContainer.innerHTML = "";
  let subtotal = 0;

  if (cart.length === 0) {
    // hides the cart grid to prevent an empty black gap from showing
    const cartGrid = document.querySelector(".cart-grid");
    if (cartGrid) cartGrid.style.display = "none";

    // shows a clean message in place of the empty grid
    let emptyMsg = document.getElementById("cart-empty-msg");
    if (!emptyMsg) {
      emptyMsg = document.createElement("p");
      emptyMsg.id = "cart-empty-msg";
      emptyMsg.style.cssText =
        'font-family:"Courier New",monospace; font-size:13px; letter-spacing:.1em; color:#555; padding: 40px 0; border-top: 1px solid #111;';
      emptyMsg.innerText = "CART MATRIX IS CURRENTLY EMPTY.";
      cartGrid && cartGrid.parentNode.insertBefore(emptyMsg, cartGrid);
    }
    updateOrderSummary(0);
    return;
  }

  // makes the grid visible again and removes the empty message
  const cartGrid = document.querySelector(".cart-grid");
  if (cartGrid) cartGrid.style.display = "";
  const emptyMsg = document.getElementById("cart-empty-msg");
  if (emptyMsg) emptyMsg.remove();

  // builds a cart item row for each product in the array
  cart.forEach((item, index) => {
    const itemTotal = item.price * item.quantity;
    subtotal += itemTotal;

    const article = document.createElement("article");
    article.className = "cart-item";

    const formattedAllergen = item.allergen_info
      ? `[ALLERGEN: ${item.allergen_info.toUpperCase()}]`
      : "[NO ALLERGEN DATA]";
    const producerName = item.producer_name
      ? item.producer_name.toUpperCase()
      : "GLH CO-OP";

    article.innerHTML = `
                <div class="item-media">
                  <img src="assets/${item.product_image || "placeholder.png"}" alt="${item.product_name}" style="width:100%; height:100%; object-fit:cover; background:#e0e0e0;"/>
                </div>
                <div class="item-details">
                  <h2 class="item-name">${item.product_name.toUpperCase()}</h2>
                  <span class="item-allergen">${formattedAllergen}</span>
                  <p class="item-farm">${producerName}</p>
                </div>
                <div class="item-metrics">
                  <div class="metric-cell price">£${item.price.toFixed(2)}</div>
                  <div class="metric-cell qty">
                    <input type="number" value="${item.quantity}" min="1" max="${item.max_stock}" class="qty-input" onchange="updateItemQty(${index}, this.value)" style="width:100%; text-align:center; border:none; background:transparent; font-family:inherit;" />
                  </div>
                  <button class="metric-cell remove-btn" onclick="removeItem(${index})"> REMOVE </button>
                </div>
            `;
    cartContainer.appendChild(article);
  });

  updateOrderSummary(subtotal);
}

function updateItemQty(index, newQty) {
  const parsedQty = parseInt(newQty, 10);

  // caps the quantity at the max stock level
  if (parsedQty > cart[index].max_stock) {
    alert(
      `SYSTEM HALT: Request exceeds available inventory. Maximum allowance is ${cart[index].max_stock} units.`,
    );
    cart[index].quantity = cart[index].max_stock;
  } else if (parsedQty < 1) {
    cart[index].quantity = 1;
  } else {
    cart[index].quantity = parsedQty;
  }
  saveCart();
  renderCartPage();
}

function removeItem(index) {
  // removes the item from the cart array and re-renders the page
  cart.splice(index, 1);
  saveCart();
  renderCartPage();
}

function updateOrderSummary(subtotal) {
  const summaryTable = document.querySelector(".summary-totals");
  if (!summaryTable) return;

  // reads which delivery option is selected and adds the fee if needed
  const deliveryMethod = document.querySelector(
    'input[name="delivery-method"]:checked',
  ).value;
  const deliveryFee = deliveryMethod === "direct" ? 5.0 : 0.0;

  const vat = subtotal * 0.0;
  const total = subtotal + vat + deliveryFee;

  // writes the calculated values to the four numeric cells in the summary table
  const numericCells = summaryTable.querySelectorAll(".numeric");
  if (numericCells.length === 4) {
    numericCells[0].innerText = `£ ${subtotal.toFixed(2)}`;
    numericCells[1].innerText = `£ ${vat.toFixed(2)}`;
    numericCells[2].innerText = `£ ${deliveryFee.toFixed(2)}`;
    numericCells[3].innerText = `£ ${total.toFixed(2)}`;
  }
}

function initiateCheckout() {
  const userId = localStorage.getItem("session_user_id");

  // blocks the checkout if the user isnt logged in
  if (!userId) {
    alert(
      "SYSTEM LOG: Authentication required to execute transaction. Routing to Customer Node.",
    );
    window.location.href = "customer-login.html";
    return;
  }

  if (cart.length === 0) {
    alert("SYSTEM HALT: Cannot process an empty ledger.");
    return;
  }

  // reads the grand total from the summary table to pass to the API
  const totalString = document
    .querySelectorAll(".summary-totals .numeric")[3]
    .innerText.replace("£", "")
    .trim();
  const finalTotal = parseFloat(totalString);

  // sends the cart and total to the checkout endpoint
  fetch("http://127.0.0.1:8000/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      customer_id: userId,
      cart: cart,
      total_price: finalTotal,
    }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (data.status === "success") {
        alert(
          `TRANSACTION COMPLETE: Order Ref #${data.order_id} committed to ledger.`,
        );
        // clears the cart and sends the user to their portal
        cart = [];
        saveCart();
        window.location.href = "customer-portal.html";
      } else {
        alert(`SYSTEM ERROR: ${data.message}`);
      }
    })
    .catch((err) => console.error("CHECKOUT ERROR:", err));
}


/* customer portal order history */

function loadOrderHistory() {
  const tbody = document.getElementById("order-history-body");
  if (!tbody) return;

  const userId = localStorage.getItem("session_user_id");
  if (!userId) return;

  // fetches all orders for the logged in customer from the API
  fetch(`http://127.0.0.1:8000/orders/${userId}`)
    .then((res) => res.json())
    .then((orders) => {
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
          <td class="ref-cell">GLH-${String(order.order_id).padStart(6, "0")}</td>
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


/* single DOMContentLoaded entry point */

document.addEventListener("DOMContentLoaded", () => {
  // runs on every page load
  initSessionUI();
  updateCartCount();
  initConsentWall();

  const page = window.location.pathname.split("/").pop() || "index.html";

  // only fetches inventory on pages that need it
  if (page === "products.html" || page === "producer-portal.html") {
    fetchInventoryData("http://127.0.0.1:8000/products");
  }

  if (page === "customer-portal.html") {
    loadOrderHistory();
  }

  if (page === "cart.html") {
    renderCartPage();

    // recalculates the order total when the delivery option changes
    const deliveryToggles = document.querySelectorAll(
      'input[name="delivery-method"]',
    );
    deliveryToggles.forEach((toggle) => {
      toggle.addEventListener("change", renderCartPage);
    });

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
