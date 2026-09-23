// BrewOps frontend — vanilla JS, no dependencies, no build step.

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.detail || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

// ---- dashboard ----

function currentRange() {
  const start = document.getElementById("filter-start").value; // "" or "YYYY-MM-DD"
  const end = document.getElementById("filter-end").value;
  const params = new URLSearchParams();
  if (start) params.set("start", start);
  if (end) params.set("end", end);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function renderDrinkBars(perDrink) {
  const container = document.getElementById("drink-bars");
  container.innerHTML = "";
  const max = Math.max(1, ...perDrink.map((d) => d.count));
  for (const drink of perDrink) {
    const row = document.createElement("div");
    row.className = "bar-row";
    row.innerHTML = `
      <span class="bar-label">${drink.label}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${(drink.count / max) * 100}%"></span></span>
      <span class="bar-count">${drink.count}</span>`;
    container.appendChild(row);
  }
}

function renderTimeline(perDay) {
  const svg = document.getElementById("timeline");
  svg.innerHTML = "";
  if (perDay.length === 0) return;
  const width = 600;
  const height = 130;
  const max = Math.max(...perDay.map((d) => d.count));
  const barWidth = width / perDay.length;
  perDay.forEach((day, i) => {
    const barHeight = (day.count / max) * (height - 10);
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", i * barWidth);
    rect.setAttribute("y", height - barHeight);
    rect.setAttribute("width", Math.max(0.5, barWidth - 0.6));
    rect.setAttribute("height", barHeight);
    rect.setAttribute("class", "timeline-bar");
    const title = document.createElementNS("http://www.w3.org/2000/svg", "title");
    title.textContent = `${day.day}: ${day.count} brews`;
    rect.appendChild(title);
    svg.appendChild(rect);
  });
}

function renderMachineCards(healths) {
  const container = document.getElementById("machine-cards");
  container.innerHTML = "";
  for (const m of healths) {
    const card = document.createElement("div");
    card.className = "card";
    const specialty = m.specialty
      ? `${m.specialty.label} (${m.specialty.count})`
      : "no brews yet";
    const maintenance = m.last_maintenance
      ? `${m.last_maintenance.type} on ${m.last_maintenance.timestamp.slice(0, 10)}`
      : "none on record";
    const errors = m.recent_errors.length
      ? `<p class="errors">Recent errors: ${m.recent_errors
          .map((e) => `${e.error_code || "?"} (${e.timestamp.slice(0, 10)})`)
          .join(", ")}</p>`
      : "";
    card.innerHTML = `
      <h3>${m.name}</h3>
      <p class="badge">${m.has_telemetry ? "telemetry" : "manual log"}</p>
      <p>${m.brew_count} brews · last ${m.last_brew ? m.last_brew.slice(0, 16) : "never"}</p>
      <p>Specialty: ${specialty}</p>
      <p>Last maintenance: ${maintenance}</p>
      ${errors}`;
    container.appendChild(card);
  }
}

async function loadDashboard() {
  const range = currentRange();
  const stats = await fetchJSON(`/api/stats${range}`);
  document.getElementById("total-brews").textContent = stats.total_brews;
  const lastDay = stats.per_day[stats.per_day.length - 1];
  document.getElementById("brews-today").textContent = lastDay ? lastDay.count : 0;
  renderDrinkBars(stats.per_drink);
  renderTimeline(stats.per_day);

  const machines = await fetchJSON("/api/machines");
  document.getElementById("machine-count").textContent = machines.length;
  const healths = await Promise.all(
    machines.map((m) => fetchJSON(`/api/machines/${m.id}${range}`))
  );
  renderMachineCards(healths);
}

// ---- forms ----

function localNow() {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16); // datetime-local format
}

function fillSelect(select, items, valueKey, labelKey) {
  select.innerHTML = "";
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item[valueKey];
    option.textContent = item[labelKey];
    select.appendChild(option);
  }
}

function setupFilter() {
  document.getElementById("filter-apply").addEventListener("click", () => {
    const start = document.getElementById("filter-start").value;
    const end = document.getElementById("filter-end").value;
    const message = document.getElementById("filter-message");
    message.textContent = "";
    message.className = "message";
    if (start && end && start > end) {
      message.textContent = "From date must not be after To date.";
      message.classList.add("error");
      return;
    }
    loadDashboard().catch((error) => {
      message.textContent = error.message;
      message.classList.add("error");
    });
  });

  document.getElementById("filter-clear").addEventListener("click", () => {
    document.getElementById("filter-start").value = "";
    document.getElementById("filter-end").value = "";
    document.getElementById("filter-message").textContent = "";
    loadDashboard().catch((error) => console.error("Dashboard failed to load:", error));
  });
}

async function setupForms() {
  const machines = await fetchJSON("/api/machines");
  const drinks = await fetchJSON("/api/drink-types");
  fillSelect(document.getElementById("brew-machine"), machines, "id", "name");
  fillSelect(document.getElementById("brew-drink"), drinks, "name", "label");
  fillSelect(document.getElementById("maintenance-machine"), machines, "id", "name");
  document.getElementById("brew-timestamp").value = localNow();
  document.getElementById("maintenance-timestamp").value = localNow();

  document.getElementById("brew-form").addEventListener("submit", (event) =>
    submitForm(event, "/api/brews", "brew-message", () => ({
      machine_id: Number(document.getElementById("brew-machine").value),
      drink_type: document.getElementById("brew-drink").value,
      timestamp: document.getElementById("brew-timestamp").value,
    }))
  );

  document.getElementById("maintenance-form").addEventListener("submit", (event) =>
    submitForm(event, "/api/maintenance", "maintenance-message", () => ({
      machine_id: Number(document.getElementById("maintenance-machine").value),
      type: document.getElementById("maintenance-type").value,
      timestamp: document.getElementById("maintenance-timestamp").value,
      note: document.getElementById("maintenance-note").value || null,
    }))
  );
}

async function submitForm(event, url, messageId, buildPayload) {
  event.preventDefault();
  const message = document.getElementById(messageId);
  message.textContent = "";
  message.className = "message";
  try {
    await fetchJSON(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildPayload()),
    });
    message.textContent = "Logged.";
    message.classList.add("ok");
    await loadDashboard();
  } catch (error) {
    message.textContent = error.message;
    message.classList.add("error");
  }
}

loadDashboard().catch((error) => {
  document.getElementById("total-brews").textContent = "!";
  console.error("Dashboard failed to load:", error);
});
setupForms().catch((error) => console.error("Form setup failed:", error));
setupFilter();
