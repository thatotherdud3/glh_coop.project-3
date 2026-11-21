/* Producer metrics and fulfilment queue. Values are loaded from the API. */
(function () {
  "use strict";
  const origin = window.location.port === "8000"
    ? window.location.origin : "http://127.0.0.1:8000";
  let inFlight = false;

  function byId(id) { return document.getElementById(id); }

  function setStatus(message) {
    const node = byId("producer-metrics-status");
    if (node) node.textContent = message;
  }

  function expireSession() {
    ["session_user_id", "session_role", "session_full_name", "session_producer_token"]
      .forEach(key => localStorage.removeItem(key));
    window.location.href = "producer-login.html";
  }

  async function request(path, options) {
    const token = localStorage.getItem("session_producer_token");
    if (!token) {
      expireSession();
      throw new Error("Producer login required.");
    }
    const response = await fetch(origin + path, {
      ...options,
      cache: "no-store",
      headers: { Authorization: "Bearer " + token },
    });
    let data;
    try { data = await response.json(); }
    catch (_) { throw new Error("Invalid server response."); }
    if (response.status === 401) {
      expireSession();
      throw new Error("Producer session expired.");
    }
    if (!response.ok) throw new Error(data.message || "Request failed.");
    return data;
  }

  function renderQueue(items) {
    const container = byId("producer-pending-items");
    if (!container) return;
    container.replaceChildren();
    if (!items || items.length === 0) {
      const empty = document.createElement("p");
      empty.className = "producer-empty-queue";
      empty.textContent = "NO ORDERS AWAITING FULFILMENT.";
      container.appendChild(empty);
      return;
    }
    for (const item of items) {
      const row = document.createElement("div");
      row.className = "producer-pending-row";
      const order = document.createElement("strong");
      order.className = "producer-pending-order";
      order.textContent = "GLH-" + String(item.order_id).padStart(6, "0");
      const product = document.createElement("span");
      product.className = "producer-pending-product";
      product.textContent = item.product_name;
      const quantity = document.createElement("span");
      quantity.className = "producer-pending-quantity";
      quantity.textContent = item.quantity + " UNIT" + (item.quantity === 1 ? "" : "S");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "producer-fulfil-btn";
      btn.textContent = "MARK FULFILLED";
      btn.addEventListener("click", async function () {
        btn.disabled = true;
        setStatus("UPDATING FULFILMENT…");
        try {
          await request("/producer/fulfil/" + encodeURIComponent(item.item_id), {
            method: "PUT",
          });
          await refreshProducerDashboard();
        } catch (error) {
          setStatus(error.message);
          btn.disabled = false;
        }
      });
      row.append(order, product, quantity, btn);
      container.appendChild(row);
    }
  }

  async function refreshProducerDashboard() {
    if (!byId("producer-revenue") || inFlight) return;
    inFlight = true;
    try {
      setStatus("LOADING PRODUCER FIGURES…");
      const data = await request("/producer/dashboard");
      byId("producer-revenue").textContent = Number(data.revenue_mtd)
        .toLocaleString("en-GB", { style: "currency", currency: "GBP" });
      byId("producer-stock").textContent = Number(data.active_stock_units)
        .toLocaleString("en-GB") + " Units";
      byId("producer-pending").textContent = Number(data.pending_orders)
        .toLocaleString("en-GB") + " Orders";
      let note = "Product order value this month, excluding delivery; payment not verified.";
      if (data.historical_prices_estimated) {
        note += " Older orders estimated using current prices.";
      }
      if (data.missing_historical_prices) {
        note += " Some old prices are unavailable.";
      }
      byId("producer-revenue-note").textContent = note;
      renderQueue(data.pending_items);
      setStatus("");
    } catch (error) {
      setStatus(error.message || "Unable to load producer metrics.");
    } finally {
      inFlight = false;
    }
  }

  window.refreshProducerDashboard = refreshProducerDashboard;
  document.addEventListener("DOMContentLoaded", function () {
    if (!byId("producer-revenue")) return;
    const refresh = byId("producer-refresh");
    if (refresh) refresh.addEventListener("click", refreshProducerDashboard);
    refreshProducerDashboard();
  });
})();
