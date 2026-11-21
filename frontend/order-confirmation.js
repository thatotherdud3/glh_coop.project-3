/* Private, server-backed order confirmation. No payment is charged here. */
(function () {
  "use strict";
  const byId = (id) => document.getElementById(id);
  const pound = (n) => Number(n || 0).toLocaleString("en-GB", { style: "currency", currency: "GBP" });
  const nodes = {
    "ND-01": "Liverpool Hub", "ND-02": "Manchester Hub",
    "ND-03": "Cardiff Hub", "ND-04": "Glasgow Hub",
    "ND-05": "Belfast Hub", "ND-06": "Dublin Hub"
  };

  function showError(message, needsLogin) {
    byId("receipt-status").textContent = message;
    if (needsLogin) byId("receipt-sign-in").hidden = false;
  }

  function renderItem(item) {
    const row = document.createElement("article");
    row.className = "receipt-item";
    const img = document.createElement("img");
    img.loading = "lazy";
    img.alt = item.product_name || "Produce";
    img.src = typeof resolveProductImageUrl === "function"
      ? resolveProductImageUrl(item.product_image) : "assets/placeholder.png";
    img.addEventListener("error", function () {
      if (!this.src.endsWith("/assets/placeholder.png")) this.src = "assets/placeholder.png";
    });
    const body = document.createElement("div");
    body.className = "receipt-item-content";
    const producer = document.createElement("span");
    producer.className = "receipt-item-producer";
    producer.textContent = item.producer_name || "GLH CO-OP";
    const name = document.createElement("strong");
    name.className = "receipt-item-name";
    name.textContent = item.product_name || "Produce";
    const qty = document.createElement("span");
    qty.className = "receipt-item-quantity";
    qty.textContent = item.quantity + " UNIT" + (item.quantity === 1 ? "" : "S") +
      " / " + (item.fulfilled ? "FULFILLED" : "PENDING");
    body.append(producer, name, qty);
    const price = document.createElement("span");
    price.className = "receipt-item-price";
    price.textContent = pound(item.line_total);
    row.append(img, body, price);
    return row;
  }

  async function loadReceipt() {
    const orderId = new URLSearchParams(window.location.search).get("order_id");
    if (!orderId || !/^[0-9]+$/.test(orderId)) {
      showError("No valid order reference was provided.", false);
      return;
    }
    try {
      const response = await fetch("/orders/" + encodeURIComponent(orderId) + "/confirmation", {
        credentials: "same-origin", cache: "no-store"
      });
      const data = await response.json();
      if (!response.ok) {
        showError(data.message || "Unable to retrieve this order.", response.status === 401);
        return;
      }
      byId("receipt-number").textContent = "GLH-" + String(data.order_id).padStart(6, "0");
      let formattedTime = data.order_time || "Not recorded";
      if (data.order_time) {
        const parsed = new Date(data.order_time.replace(" ", "T") + "Z");
        if (!Number.isNaN(parsed.getTime())) {
          formattedTime = parsed.toLocaleString("en-GB", {
            dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London"
          });
        }
      }
      byId("receipt-date").textContent = formattedTime;
      byId("receipt-fulfilment").textContent = data.fulfilment_status || "Pending";
      byId("receipt-payment").textContent = "NOT PROCESSED";
      const direct = data.delivery_method === "direct";
      byId("receipt-method").textContent = direct ? "DIRECT DELIVERY / £15.00" : "HUB COLLECTION / FREE";
      if (direct) {
        const a = data.delivery_address || {};
        byId("receipt-destination").textContent =
          [a.line1, a.line2, a.town, a.postcode, a.country].filter(Boolean).join("\n");
        byId("receipt-route-note").textContent = "Delivery details recorded. A delivery has not been scheduled.";
      } else {
        const code = data.collection_node_code;
        byId("receipt-destination").textContent = nodes[code]
          ? nodes[code] + " / " + code : "Collection node not recorded";
        byId("receipt-route-note").textContent = "Illustrative node selection only. Collection is not booked.";
      }
      const items = byId("receipt-items");
      items.replaceChildren(...(data.items || []).map(renderItem));
      const subtotal = (data.items || []).reduce((acc, item) => acc + Number(item.line_total || 0), 0);
      byId("receipt-subtotal").textContent = pound(subtotal);
      byId("receipt-delivery").textContent = pound(data.delivery_fee);
      byId("receipt-total").textContent = pound(data.total_price);
      byId("receipt-status").hidden = true;
      byId("receipt-content").hidden = false;
    } catch (error) {
      console.error("ORDER CONFIRMATION ERROR:", error);
      showError("Unable to contact the order ledger. Please try again.", false);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", loadReceipt, { once: true });
  } else {
    loadReceipt();
  }
})();
