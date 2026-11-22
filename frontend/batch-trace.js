/* real batch info comes from the api */
document.addEventListener("DOMContentLoaded", function () {
  const form = document.getElementById("batch-lookup-form");
  if (!form) return;
  const input = document.getElementById("batch-input");
  const button = document.getElementById("batch-search-btn");
  const status = document.getElementById("batch-search-status");
  const result = document.getElementById("batch-results");

  function showStatus(message, isError) {
    status.textContent = message;
    status.classList.toggle("is-error", Boolean(isError));
  }

  function populate(data) {
    document.getElementById("batch-reference").textContent = data.batch_number;
    document.getElementById("batch-product").textContent = data.product_name;
    document.getElementById("batch-origin").textContent = data.origin || "NOT RECORDED";
    document.getElementById("batch-origin-note").textContent =
      data.origin_type === "farm" ? "FARM RECORD" : "PRODUCER RECORD";

    const date = data.harvest_date;
    const validDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date);
    document.getElementById("batch-harvest").textContent = validDate
      ? date.slice(8, 10) + "/" + date.slice(5, 7) + "/" + date.slice(0, 4)
      : "NOT RECORDED";
    document.getElementById("batch-harvest-note").textContent =
      validDate ? "DATE RECORDED AT STOCK INTAKE" : "NO HARVEST DATE ON FILE";

    const labels = {
      VERIFIED: ["VERIFIED", "CLEARANCE STATUS RECORDED"],
      PENDING: ["PENDING REVIEW", "NOT YET CLEARED"],
      REJECTED: ["NOT CLEARED", "CLEARANCE REJECTED"],
      NOT_RECORDED: ["NOT RECORDED", "NO SAFETY CLEARANCE ON FILE"],
    };
    const clearance = labels[data.safety_clearance] || labels.NOT_RECORDED;
    document.getElementById("batch-clearance").textContent = clearance[0];
    document.getElementById("batch-clearance-note").textContent = clearance[1];
    result.hidden = false;
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    const code = input.value.trim();
    result.hidden = true;
    showStatus("", false);

    if (!/^[a-z0-9_-]{1,100}$/i.test(code)) {
      showStatus("Enter a valid batch number using letters, numbers, underscores or hyphens.", true);
      input.focus();
      return;
    }

    button.disabled = true;
    showStatus("SEARCHING TRACEABILITY RECORD…", false);
    try {
      const apiOrigin = window.location.port === "8000"
        ? window.location.origin
        : "http://127.0.0.1:8000";
      const response = await fetch(apiOrigin + "/batch-trace/" + encodeURIComponent(code), {
        cache: "no-store",
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "Batch lookup failed.");

      populate(data);
      showStatus("", false);
      result.scrollIntoView({
        behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
        block: "start",
      });
    } catch (error) {
      showStatus(error instanceof TypeError
        ? "Cannot connect to the GLH API. Start the local server on port 8000."
        : error.message, true);
    } finally {
      button.disabled = false;
    }
  });
});
