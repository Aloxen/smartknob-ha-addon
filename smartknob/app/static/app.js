/**
 * SmartKnob Studio — Single Page Application Frontend
 */

const STATE = {
  devices: [],
  activeFilename: "",
  config: {
    device: { name: "Wohnzimmer Knob", ip: "192.168.178.133" },
    menu: [],
  },
  currentPath: [], // e.g. [0] if inside first submenu
  selectedItemIndex: 0,
  entities: [],
};

const COLOR_PALETTE = [
  "#FFAA00", "#FF6600", "#FF0055", "#00CC88",
  "#00CCFF", "#0066FF", "#BB66FF", "#FFFFFF",
];

const ICON_LIST = [
  { id: "lightbulb", icon: "mdi-lightbulb-on" },
  { id: "brightness", icon: "mdi-brightness-6" },
  { id: "power", icon: "mdi-power" },
  { id: "plug", icon: "mdi-power-socket-eu" },
  { id: "dashboard", icon: "mdi-view-dashboard" },
  { id: "preset", icon: "mdi-palette" },
  { id: "info", icon: "mdi-information" },
  { id: "gear", icon: "mdi-cog" },
  { id: "home", icon: "mdi-home" },
  { id: "circle", icon: "mdi-circle-outline" },
];

// ── Initialization ─────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  setupEventListeners();
  await loadEntities();
  await loadDevices();
});

function setupEventListeners() {
  document.getElementById("deviceSelect").addEventListener("change", (e) => {
    switchDevice(e.target.value);
  });

  document.getElementById("btnNewDevice").addEventListener("click", promptNewDevice);
  document.getElementById("btnSave").addEventListener("click", () => saveConfig(false));
  document.getElementById("btnPush").addEventListener("click", () => saveConfig(true));
  document.getElementById("btnViewYaml").addEventListener("click", openYamlModal);

  // Add Item Modal
  document.getElementById("btnAddItem").addEventListener("click", () => {
    document.getElementById("addModal").classList.add("active");
  });
  document.getElementById("closeAddModal").addEventListener("click", () => {
    document.getElementById("addModal").classList.remove("active");
  });

  document.querySelectorAll(".type-card").forEach((card) => {
    card.addEventListener("click", () => {
      const type = card.dataset.type;
      const screen = card.dataset.screen;
      addNewItem(type, screen);
      document.getElementById("addModal").classList.remove("active");
    });
  });

  // YAML Modal
  document.getElementById("closeYamlModal").addEventListener("click", closeYamlModal);
  document.getElementById("btnCancelYaml").addEventListener("click", closeYamlModal);
  document.getElementById("btnApplyYaml").addEventListener("click", applyYamlModal);
}

// ── API Communication ──────────────────────────────────────────────────────

async function loadDevices() {
  try {
    const res = await fetch("api/devices");
    const data = await res.json();
    STATE.devices = data.devices || [];

    const select = document.getElementById("deviceSelect");
    select.innerHTML = "";
    STATE.devices.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.filename;
      opt.textContent = `${d.name} (${d.ip || "No IP"})`;
      select.appendChild(opt);
    });

    if (STATE.devices.length > 0) {
      switchDevice(STATE.devices[0].filename);
    }
  } catch (err) {
    showToast("Fehler beim Laden der Geräte", true);
  }
}

async function loadEntities() {
  try {
    const res = await fetch("api/entities");
    const data = await res.json();
    STATE.entities = data.entities || [];
  } catch (err) {
    console.warn("Could not load entities", err);
  }
}

async function switchDevice(filename) {
  STATE.activeFilename = filename;
  STATE.currentPath = [];
  STATE.selectedItemIndex = 0;

  try {
    const res = await fetch(`api/config?file=${encodeURIComponent(filename)}`);
    const data = await res.json();
    STATE.config = data.config || { device: { name: filename }, menu: [] };
    if (!STATE.config.menu) STATE.config.menu = [];

    renderBreadcrumbs();
    renderItemList();
    renderInspector();
    drawDisplayCanvas();
  } catch (err) {
    showToast("Fehler beim Laden der Konfiguration", true);
  }
}

async function saveConfig(push = false) {
  try {
    const res = await fetch("api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: STATE.activeFilename,
        config: STATE.config,
        push: push,
      }),
    });
    const data = await res.json();
    if (push) {
      showToast(data.pushed ? "🚀 Erfolgreich an SmartKnob gesendet!" : "Gespeichert (Push fehlgeschlagen)");
    } else {
      showToast("💾 Gespeichert!");
    }
  } catch (err) {
    showToast("Fehler beim Speichern", true);
  }
}

// ── Hierarchy & Current Menu Resolution ────────────────────────────────────

function getCurrentMenuList() {
  let list = STATE.config.menu;
  for (const idx of STATE.currentPath) {
    if (list[idx] && list[idx].children) {
      list = list[idx].children;
    }
  }
  return list;
}

function renderBreadcrumbs() {
  const container = document.getElementById("breadcrumbs");
  container.innerHTML = "";

  const rootSpan = document.createElement("span");
  rootSpan.className = `crumb ${STATE.currentPath.length === 0 ? "active" : ""}`;
  rootSpan.textContent = "🏠 Hauptmenü";
  rootSpan.addEventListener("click", () => {
    STATE.currentPath = [];
    STATE.selectedItemIndex = 0;
    renderBreadcrumbs();
    renderItemList();
    renderInspector();
    drawDisplayCanvas();
  });
  container.appendChild(rootSpan);

  let current = STATE.config.menu;
  const pathAccum = [];
  STATE.currentPath.forEach((idx, step) => {
    pathAccum.push(idx);
    const item = current[idx];
    if (!item) return;

    const sep = document.createElement("span");
    sep.textContent = "›";
    sep.style.color = "var(--text-dim)";
    container.appendChild(sep);

    const crumb = document.createElement("span");
    const isLast = step === STATE.currentPath.length - 1;
    crumb.className = `crumb ${isLast ? "active" : ""}`;
    crumb.textContent = item.label || "Untermenü";

    const targetPath = [...pathAccum];
    crumb.addEventListener("click", () => {
      STATE.currentPath = targetPath;
      STATE.selectedItemIndex = 0;
      renderBreadcrumbs();
      renderItemList();
      renderInspector();
      drawDisplayCanvas();
    });
    container.appendChild(crumb);

    if (item.children) current = item.children;
  });
}

// ── Item List (Left Panel) ─────────────────────────────────────────────────

function renderItemList() {
  const container = document.getElementById("itemList");
  container.innerHTML = "";

  const menuList = getCurrentMenuList();

  if (menuList.length === 0) {
    container.innerHTML = `
      <div class="empty-state" style="padding: 40px 10px; text-align: center; color: var(--text-dim);">
        <i class="mdi mdi-playlist-plus" style="font-size: 32px; display: block; margin-bottom: 8px;"></i>
        Dieses Menü ist noch leer.<br>Klicke oben auf <strong>+ Element hinzufügen</strong>.
      </div>
    `;
    return;
  }

  menuList.forEach((item, idx) => {
    const card = document.createElement("div");
    card.className = `item-card ${idx === STATE.selectedItemIndex ? "selected" : ""}`;

    const color = item.color || "#0284c7";
    const iconClass = getMdiIcon(item.icon || "circle");

    let subtext = "";
    let badgeText = "Screen";
    if (item.type === "submenu") {
      const count = item.children ? item.children.length : 0;
      subtext = `${count} Unterelement(e)`;
      badgeText = "Untermenü";
    } else if (item.screen === "brightness") {
      subtext = item.entity_id || "Keine Entity";
      badgeText = "Licht";
    } else if (item.screen === "switch") {
      subtext = item.entity_id || "Keine Entity";
      badgeText = "Schalter";
    } else if (item.screen === "preset") {
    const presetOpts = (item.options && item.options.options) ? item.options.options : [];
    // Find the entity's available options from the loaded HA entities list
    const entState = STATE.entities.find(e => e.entity_id === item.entity_id);
    const availableOptions = entState && entState.options ? entState.options : [];

    let optRows = presetOpts.map((opt, i) => `
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
        <input type="text" class="form-control inp-preset-opt" data-idx="${i}" value="${escapeHtml(opt)}" style="flex:1;">
        <button class="btn-icon danger btn-del-preset" data-idx="${i}"><i class="mdi mdi-close"></i></button>
      </div>
    `).join("");

    let availHtml = availableOptions.length > 0 ? `
      <div style="margin-top:8px; font-size:12px; color:var(--text-dim);">
        Verfügbare Optionen aus HA:
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
          ${availableOptions.map(o => `
            <button class="btn btn-small btn-secondary btn-add-available-preset"
                    data-opt="${escapeHtml(o)}" style="font-size:11px; padding:2px 8px;">${escapeHtml(o)}</button>
          `).join("")}
        </div>
        <button id="btnAddAllPresets" class="btn btn-small btn-secondary" style="margin-top:6px; width:100%;">
          <i class="mdi mdi-playlist-plus"></i> Alle hinzufügen
        </button>
      </div>
    ` : `<div style="font-size:11px; color:var(--text-dim); margin-top:8px;">
           Lade Entität um Optionen zu sehen, oder füge manuell hinzu.
         </div>`;

    customHtml = `
      <div class="form-section">
        <div class="form-section-title">🎨 Preset-Auswahl Einstellungen</div>
        <div class="form-row">
          <label>Preset-Entity (select.* oder input_select.*):</label>
          ${renderEntitySelector(item.entity_id || "", "select", (val) => {
            item.entity_id = val;
            renderItemList();
            renderInspector();
            drawDisplayCanvas();
          }, "input_select")}
        </div>
        <div class="form-row">
          <label>Verfügbare Presets (werden am Knob angezeigt):</label>
          <div id="presetOptList">${optRows}</div>
          <button id="btnAddPresetOpt" class="btn btn-small btn-secondary" style="width:100%; margin-top:6px;">
            <i class="mdi mdi-plus"></i> Preset manuell hinzufügen
          </button>
          ${availHtml}
        </div>
        <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">
          💡 Tipp: Lasse die Liste leer damit der Knob die Optionen direkt aus HA liest.
        </div>
      </div>
    `;
  } else if (item.screen === "info") {
      const itemsCount = item.options && item.options.items ? item.options.items.length : 0;
      subtext = `${itemsCount} Info-Item(s)`;
      badgeText = "Info";
    } else if (item.screen === "preset") {
      subtext = item.entity_id || "Keine Entity";
      const optCount = item.options && item.options.options ? item.options.options.length : 0;
      badgeText = optCount > 0 ? `Preset (${optCount} Opt.)` : "Preset";
    }

    card.innerHTML = `
      <div class="item-icon-bubble" style="background: ${hexToRgba(color, 0.2)}; color: ${color};">
        <i class="mdi ${iconClass}"></i>
      </div>
      <div class="item-info">
        <div class="item-label">${escapeHtml(item.label || "Ohne Namen")}</div>
        <div class="item-subtext">${escapeHtml(subtext)}</div>
      </div>
      <div class="item-actions">
        ${item.type === "submenu" ? `<button class="btn btn-small btn-secondary btn-open-sub" title="Untermenü öffnen">Öffnen ➔</button>` : ""}
        <button class="btn-icon btn-move-up" title="Nach oben"><i class="mdi mdi-arrow-up"></i></button>
        <button class="btn-icon btn-move-down" title="Nach unten"><i class="mdi mdi-arrow-down"></i></button>
        <button class="btn-icon danger btn-delete" title="Löschen"><i class="mdi mdi-delete-outline"></i></button>
      </div>
    `;

    card.addEventListener("click", (e) => {
      if (e.target.closest(".btn-icon") || e.target.closest(".btn-open-sub")) return;
      STATE.selectedItemIndex = idx;
      renderItemList();
      renderInspector();
      drawDisplayCanvas();
    });

    const btnOpenSub = card.querySelector(".btn-open-sub");
    if (btnOpenSub) {
      btnOpenSub.addEventListener("click", () => {
        STATE.currentPath.push(idx);
        STATE.selectedItemIndex = 0;
        renderBreadcrumbs();
        renderItemList();
        renderInspector();
        drawDisplayCanvas();
      });
    }

    card.querySelector(".btn-move-up").addEventListener("click", () => moveItem(idx, -1));
    card.querySelector(".btn-move-down").addEventListener("click", () => moveItem(idx, 1));
    card.querySelector(".btn-delete").addEventListener("click", () => deleteItem(idx));

    container.appendChild(card);
  });
}

function moveItem(index, delta) {
  const list = getCurrentMenuList();
  const target = index + delta;
  if (target < 0 || target >= list.length) return;

  const temp = list[index];
  list[index] = list[target];
  list[target] = temp;

  STATE.selectedItemIndex = target;
  renderItemList();
  drawDisplayCanvas();
}

function deleteItem(index) {
  const list = getCurrentMenuList();
  const label = list[index].label || "dieses Element";
  if (!confirm(`Möchtest du "${label}" wirklich löschen?`)) return;

  list.splice(index, 1);
  if (STATE.selectedItemIndex >= list.length) {
    STATE.selectedItemIndex = Math.max(0, list.length - 1);
  }
  renderItemList();
  renderInspector();
  drawDisplayCanvas();
}

function addNewItem(type, screen) {
  const list = getCurrentMenuList();

  let newItem = {};
  if (type === "submenu") {
    newItem = {
      label: "Neuer Raum",
      icon: "home",
      color: "#BB66FF",
      type: "submenu",
      children: [],
    };
  } else if (screen === "brightness") {
    newItem = {
      label: "Neues Licht",
      icon: "brightness",
      color: "#FFAA00",
      type: "screen",
      screen: "brightness",
      entity_id: "light.wohnzimmer_wled",
      options: {
        presets: [
          { label: "Rainbow", preset: "1", color: "#FF00FF" },
          { label: "Cozy", preset: "2", color: "#FF6600" },
        ],
      },
    };
  } else if (screen === "switch") {
    newItem = {
      label: "Neuer Schalter",
      icon: "power",
      color: "#00CC88",
      type: "screen",
      screen: "switch",
      entity_id: "switch.stehlampe",
      options: {
        power_threshold: 0,
      },
    };
  } else if (screen === "preset") {
    newItem = {
      label: "Gaming Preset",
      icon: "preset",
      color: "#BB66FF",
      type: "screen",
      screen: "preset",
      entity_id: "select.gaming_preset",
      options: {
        options: [], // will be populated from HA entity state at runtime
      },
    };
  } else if (screen === "info") {
    newItem = {
      label: "Energie",
      icon: "info",
      color: "#00CCFF",
      type: "screen",
      screen: "info",
      options: {
        items: [
          { label: "Verbrauch", type: "value", entity_id: "sensor.stromverbrauch", unit: "W" },
          { label: "Heute", type: "gauge", entity_id: "sensor.energie_heute", unit: "kWh", min: 0, max: 20 },
          { label: "Verlauf", type: "chart", entity_id: "sensor.stromverbrauch", time_range_hours: 24 },
        ],
      },
    };
  }

  list.push(newItem);
  STATE.selectedItemIndex = list.length - 1;
  renderItemList();
  renderInspector();
  drawDisplayCanvas();
}

// ── Inspector (Center Panel) ───────────────────────────────────────────────

function renderInspector() {
  const container = document.getElementById("inspectorContent");
  const badge = document.getElementById("inspectorBadge");
  const list = getCurrentMenuList();
  const item = list[STATE.selectedItemIndex];

  if (!item) {
    badge.textContent = "Keine Auswahl";
    container.innerHTML = `
      <div class="empty-state">
        <i class="mdi mdi-cursor-default-click-outline"></i>
        <p>Wähle links ein Element aus oder erstelle ein neues mit <strong>+ Element hinzufügen</strong>.</p>
      </div>
    `;
    return;
  }

  badge.textContent = item.type === "submenu" ? "Untermenü" : (item.screen || "Screen");

  let customHtml = "";

  if (item.screen === "brightness") {
    customHtml = `
      <div class="form-section">
        <div class="form-section-title">💡 Licht-Einstellungen</div>
        <div class="form-row">
          <label>Home Assistant Light-Entity:</label>
          ${renderEntitySelector(item.entity_id || "", "light", (val) => {
            item.entity_id = val;
            renderItemList();
            drawDisplayCanvas();
          })}
        </div>
      </div>
    `;
  } else if (item.screen === "switch") {
    customHtml = `
      <div class="form-section">
        <div class="form-section-title">🔌 Schalter-Einstellungen</div>
        <div class="form-row">
          <label>Schalter-Entity (switch.* oder light.*):</label>
          ${renderEntitySelector(item.entity_id || "", "switch", (val) => {
            item.entity_id = val;
            renderItemList();
            drawDisplayCanvas();
          })}
        </div>
        <div class="form-row">
          <label>Leistungssensor (optional für Warnung):</label>
          ${renderEntitySelector(item.options?.power_sensor || "", "sensor", (val) => {
            if (!item.options) item.options = {};
            item.options.power_sensor = val;
          })}
        </div>
        <div class="form-row">
          <label>Abschaltwarnung ab Watt (0 = deaktiviert):</label>
          <input type="number" class="form-control" id="inpPowerThreshold" value="${item.options?.power_threshold || 0}">
        </div>
      </div>
    `;
  } else if (item.screen === "preset") {
    const presetOpts = (item.options && item.options.options) ? item.options.options : [];
    // Find the entity's available options from the loaded HA entities list
    const entState = STATE.entities.find(e => e.entity_id === item.entity_id);
    const availableOptions = entState && entState.options ? entState.options : [];

    let optRows = presetOpts.map((opt, i) => `
      <div style="display:flex; align-items:center; gap:6px; margin-bottom:6px;">
        <input type="text" class="form-control inp-preset-opt" data-idx="${i}" value="${escapeHtml(opt)}" style="flex:1;">
        <button class="btn-icon danger btn-del-preset" data-idx="${i}"><i class="mdi mdi-close"></i></button>
      </div>
    `).join("");

    let availHtml = availableOptions.length > 0 ? `
      <div style="margin-top:8px; font-size:12px; color:var(--text-dim);">
        Verfügbare Optionen aus HA:
        <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:4px;">
          ${availableOptions.map(o => `
            <button class="btn btn-small btn-secondary btn-add-available-preset"
                    data-opt="${escapeHtml(o)}" style="font-size:11px; padding:2px 8px;">${escapeHtml(o)}</button>
          `).join("")}
        </div>
        <button id="btnAddAllPresets" class="btn btn-small btn-secondary" style="margin-top:6px; width:100%;">
          <i class="mdi mdi-playlist-plus"></i> Alle hinzufügen
        </button>
      </div>
    ` : `<div style="font-size:11px; color:var(--text-dim); margin-top:8px;">
           Lade Entität um Optionen zu sehen, oder füge manuell hinzu.
         </div>`;

    customHtml = `
      <div class="form-section">
        <div class="form-section-title">🎨 Preset-Auswahl Einstellungen</div>
        <div class="form-row">
          <label>Preset-Entity (select.* oder input_select.*):</label>
          ${renderEntitySelector(item.entity_id || "", "select", (val) => {
            item.entity_id = val;
            renderItemList();
            renderInspector();
            drawDisplayCanvas();
          }, "input_select")}
        </div>
        <div class="form-row">
          <label>Verfügbare Presets (werden am Knob angezeigt):</label>
          <div id="presetOptList">${optRows}</div>
          <button id="btnAddPresetOpt" class="btn btn-small btn-secondary" style="width:100%; margin-top:6px;">
            <i class="mdi mdi-plus"></i> Preset manuell hinzufügen
          </button>
          ${availHtml}
        </div>
        <div style="font-size:11px; color:var(--text-dim); margin-top:4px;">
          💡 Tipp: Lasse die Liste leer damit der Knob die Optionen direkt aus HA liest.
        </div>
      </div>
    `;
  } else if (item.screen === "info") {
    const infoItems = item.options?.items || [];
    let itemsRows = infoItems.map((it, i) => `
      <div class="form-section" style="margin-bottom: 10px; padding: 10px; background: rgba(0,0,0,0.2);">
        <div style="display:flex; justify-content:space-between; margin-bottom:8px;">
          <strong>Item #${i+1}: ${escapeHtml(it.label || "Messwert")}</strong>
          <button class="btn-icon danger btn-del-info" data-idx="${i}"><i class="mdi mdi-close"></i></button>
        </div>
        <div class="form-row">
          <label>Darstellungs-Typ:</label>
          <select class="form-control sel-info-type" data-idx="${i}">
            <option value="value" ${it.type === 'value' ? 'selected' : ''}>Große Zahl (Value)</option>
            <option value="gauge" ${it.type === 'gauge' ? 'selected' : ''}>Tacho-Bogen (Gauge)</option>
            <option value="chart" ${it.type === 'chart' ? 'selected' : ''}>24h-Verlauf (Chart)</option>
          </select>
        </div>
        <div class="form-row">
          <label>Sensor Entity:</label>
          <input type="text" class="form-control inp-info-eid" data-idx="${i}" value="${escapeHtml(it.entity_id || '')}">
        </div>
        <div style="display:flex; gap:10px;">
          <div class="form-row" style="flex:1;">
            <label>Bezeichnung:</label>
            <input type="text" class="form-control inp-info-lbl" data-idx="${i}" value="${escapeHtml(it.label || '')}">
          </div>
          <div class="form-row" style="width:80px;">
            <label>Einheit:</label>
            <input type="text" class="form-control inp-info-unit" data-idx="${i}" value="${escapeHtml(it.unit || '')}">
          </div>
        </div>
      </div>
    `).join("");

    customHtml = `
      <div class="form-section">
        <div class="form-section-title">📊 Info-Screen Items (Blättern durch Drehen)</div>
        ${itemsRows}
        <button id="btnAddInfoItem" class="btn btn-small btn-secondary" style="width:100%; margin-top:8px;">
          <i class="mdi mdi-plus"></i> Item hinzufügen
        </button>
      </div>
    `;
  }

  container.innerHTML = `
    <!-- Basis Eigenschaften -->
    <div class="form-section">
      <div class="form-section-title">Allgemein</div>
      <div class="form-row">
        <label>Name / Display-Text:</label>
        <input type="text" class="form-control" id="inpLabel" value="${escapeHtml(item.label || "")}">
      </div>

      <div class="form-row">
        <label>Akzentfarbe:</label>
        <div style="display:flex; align-items:center; gap:10px;">
          <input type="color" id="inpColorPicker" value="${item.color || "#FFAA00"}" style="cursor:pointer; width:40px; height:36px; border:none; background:none;">
          <input type="text" class="form-control" id="inpColorHex" value="${item.color || "#FFAA00"}" style="font-family:monospace; width:100px;">
        </div>
        <div class="color-presets">
          ${COLOR_PALETTE.map((c) => `
            <div class="color-dot ${c.toLowerCase() === (item.color || '').toLowerCase() ? 'active' : ''}" style="background: ${c};" data-color="${c}"></div>
          `).join("")}
        </div>
      </div>

      <div class="form-row">
        <label>Icon:</label>
        <div class="icon-grid">
          ${ICON_LIST.map((ic) => `
            <button class="icon-btn ${ic.id === (item.icon || 'circle') ? 'active' : ''}" data-icon="${ic.id}" title="${ic.id}">
              <i class="mdi ${ic.icon}"></i>
            </button>
          `).join("")}
        </div>
      </div>
    </div>

    ${customHtml}
  `;

  // Bind base events
  document.getElementById("inpLabel").addEventListener("input", (e) => {
    item.label = e.target.value;
    renderItemList();
    drawDisplayCanvas();
  });

  const inpColorPicker = document.getElementById("inpColorPicker");
  const inpColorHex = document.getElementById("inpColorHex");
  inpColorPicker.addEventListener("input", (e) => {
    item.color = e.target.value.toUpperCase();
    inpColorHex.value = item.color;
    renderItemList();
    drawDisplayCanvas();
  });
  inpColorHex.addEventListener("change", (e) => {
    item.color = e.target.value;
    inpColorPicker.value = item.color;
    renderItemList();
    drawDisplayCanvas();
  });

  container.querySelectorAll(".color-dot").forEach((dot) => {
    dot.addEventListener("click", () => {
      item.color = dot.dataset.color;
      inpColorPicker.value = item.color;
      inpColorHex.value = item.color;
      container.querySelectorAll(".color-dot").forEach((d) => d.classList.remove("active"));
      dot.classList.add("active");
      renderItemList();
      drawDisplayCanvas();
    });
  });

  container.querySelectorAll(".icon-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      item.icon = btn.dataset.icon;
      container.querySelectorAll(".icon-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderItemList();
      drawDisplayCanvas();
    });
  });

  // Switch specific
  const inpThreshold = document.getElementById("inpPowerThreshold");
  if (inpThreshold) {
    inpThreshold.addEventListener("change", (e) => {
      if (!item.options) item.options = {};
      item.options.power_threshold = parseFloat(e.target.value) || 0;
    });
  }

  // Preset specific
  const btnAddPresetOpt = document.getElementById("btnAddPresetOpt");
  if (btnAddPresetOpt) {
    btnAddPresetOpt.addEventListener("click", () => {
      if (!item.options) item.options = {};
      if (!item.options.options) item.options.options = [];
      item.options.options.push("Neues Preset");
      renderInspector();
    });
  }
  const btnAddAllPresets = document.getElementById("btnAddAllPresets");
  if (btnAddAllPresets) {
    btnAddAllPresets.addEventListener("click", () => {
      const entState = STATE.entities.find(e => e.entity_id === item.entity_id);
      const available = entState && entState.options ? entState.options : [];
      if (!item.options) item.options = {};
      item.options.options = [...available];
      renderInspector();
    });
  }
  container.querySelectorAll(".btn-add-available-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!item.options) item.options = {};
      if (!item.options.options) item.options.options = [];
      const opt = btn.dataset.opt;
      if (!item.options.options.includes(opt)) {
        item.options.options.push(opt);
        renderInspector();
      }
    });
  });
  container.querySelectorAll(".inp-preset-opt").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(inp.dataset.idx);
      item.options.options[idx] = e.target.value;
    });
  });
  container.querySelectorAll(".btn-del-preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      item.options.options.splice(idx, 1);
      renderInspector();
    });
  });

  // Info specific
  const btnAddInfo = document.getElementById("btnAddInfoItem");
  if (btnAddInfo) {
    btnAddInfo.addEventListener("click", () => {
      if (!item.options) item.options = {};
      if (!item.options.items) item.options.items = [];
      item.options.items.push({ label: "Neuer Wert", type: "value", entity_id: "sensor.stromverbrauch", unit: "W" });
      renderInspector();
      drawDisplayCanvas();
    });
  }

  container.querySelectorAll(".btn-del-info").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx);
      item.options.items.splice(idx, 1);
      renderInspector();
      drawDisplayCanvas();
    });
  });

  container.querySelectorAll(".sel-info-type").forEach((sel) => {
    sel.addEventListener("change", (e) => {
      const idx = parseInt(sel.dataset.idx);
      item.options.items[idx].type = e.target.value;
      drawDisplayCanvas();
    });
  });

  container.querySelectorAll(".inp-info-eid").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(inp.dataset.idx);
      item.options.items[idx].entity_id = e.target.value;
    });
  });

  container.querySelectorAll(".inp-info-lbl").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(inp.dataset.idx);
      item.options.items[idx].label = e.target.value;
      drawDisplayCanvas();
    });
  });

  container.querySelectorAll(".inp-info-unit").forEach((inp) => {
    inp.addEventListener("input", (e) => {
      const idx = parseInt(inp.dataset.idx);
      item.options.items[idx].unit = e.target.value;
      drawDisplayCanvas();
    });
  });
}

function renderEntitySelector(currentValue, filterDomain, onSelect, filterDomain2 = null) {
  const filtered = STATE.entities.filter((e) =>
    !filterDomain || e.domain === filterDomain || (filterDomain2 && e.domain === filterDomain2)
  );
  const optionsHtml = filtered.map((e) => `
    <option value="${e.entity_id}" ${e.entity_id === currentValue ? "selected" : ""}>
      ${e.friendly_name} (${e.entity_id})
    </option>
  `).join("");

  const id = `sel_entity_${Math.random().toString(36).substr(2, 9)}`;
  setTimeout(() => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", (e) => onSelect(e.target.value));
    }
  }, 0);

  return `
    <select class="form-control" id="${id}">
      <option value="">-- Entität auswählen --</option>
      ${optionsHtml}
    </select>
  `;
}

// ── Display 240x240 Simulation ─────────────────────────────────────────────

function drawDisplayCanvas() {
  const canvas = document.getElementById("displayCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = 240;
  const H = 240;
  const R = 120;

  // Clear
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#000000";
  ctx.beginPath();
  ctx.arc(R, R, R, 0, Math.PI * 2);
  ctx.fill();

  const menuList = getCurrentMenuList();
  const item = menuList[STATE.selectedItemIndex];

  if (!item || menuList.length === 0) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 20px -apple-system, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("SmartKnob", R, R - 10);
    ctx.fillStyle = "#666666";
    ctx.font = "13px -apple-system, sans-serif";
    ctx.fillText("Leeres Menü", R, R + 20);
    return;
  }

  // Draw clock-layout menu
  ctx.strokeStyle = "#222222";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(R, R, R - 6, 0, Math.PI * 2);
  ctx.stroke();

  // Draw items around the arc
  const count = menuList.length;
  const stepAngle = (36 * Math.PI) / 180;
  const totalRange = (count - 1) * stepAngle;
  const startAngle = Math.PI / 2 + totalRange / 2;

  menuList.forEach((it, i) => {
    const ang = startAngle - i * stepAngle;
    const isSel = i === STATE.selectedItemIndex;
    const radius = isSel ? 87 : 94;
    const x = R + Math.cos(ang) * radius;
    const y = R - Math.sin(ang) * radius;

    const col = it.color || "#0284c7";

    // Bubble
    ctx.fillStyle = isSel ? col : "#1a1a1a";
    ctx.beginPath();
    ctx.arc(x, y, isSel ? 16 : 12, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = col;
    ctx.lineWidth = isSel ? 2 : 1;
    ctx.stroke();
  });

  // Center display content
  const accent = item.color || "#0284c7";

  // Center icon bubble
  ctx.fillStyle = hexToRgba(accent, 0.2);
  ctx.beginPath();
  ctx.arc(R, R - 15, 26, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = accent;
  ctx.font = "bold 24px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(getIconGlyph(item.icon), R, R - 14);

  // Center Label
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 16px -apple-system, sans-serif";
  ctx.fillText(item.label || "Screen", R, R + 32);

  // Subtitle / Type
  ctx.fillStyle = "#888888";
  ctx.font = "12px -apple-system, sans-serif";
  let sub = item.type === "submenu" ? "Untermenü" : item.screen;
  ctx.fillText(sub, R, R + 52);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getMdiIcon(name) {
  const found = ICON_LIST.find((i) => i.id === name);
  return found ? found.icon : "mdi-circle-outline";
}

function getIconGlyph(name) {
  switch (name) {
    case "lightbulb": return "💡";
    case "brightness": return "☀️";
    case "power": return "⏻";
    case "plug": return "🔌";
    case "info": return "ℹ️";
    case "home": return "🏠";
    case "dashboard": return "▦";
    case "preset": return "🎨";
    case "gear": return "⚙️";
    default: return "●";
  }
}

function hexToRgba(hex, alpha = 1) {
  if (!hex || hex[0] !== "#" || hex.length < 7) return `rgba(2,132,199,${alpha})`;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function escapeHtml(str) {
  return (str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

function showToast(msg, isError = false) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = `toast ${isError ? "error" : ""} active`;
  setTimeout(() => toast.classList.remove("active"), 3000);
}

function promptNewDevice() {
  const name = prompt("Name des neuen SmartKnob:", "Schlafzimmer Knob");
  if (!name) return;
  const ip = prompt("IP-Adresse des SmartKnob:", "192.168.178.134");
  if (!ip) return;

  const slug = name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
  const filename = `smartknob_${slug}.yaml`;

  STATE.config = {
    device: { name: name, ip: ip },
    menu: [],
  };
  STATE.activeFilename = filename;
  saveConfig(false).then(() => loadDevices());
}

function openYamlModal() {
  const modal = document.getElementById("yamlModal");
  const txt = document.getElementById("yamlEditorText");
  // Dump state config
  txt.value = JSON.stringify({ smartknob: STATE.config }, null, 2);
  modal.classList.add("active");
}

function closeYamlModal() {
  document.getElementById("yamlModal").classList.remove("active");
}

function applyYamlModal() {
  const txt = document.getElementById("yamlEditorText").value;
  try {
    const parsed = JSON.parse(txt);
    STATE.config = parsed.smartknob || parsed;
    renderItemList();
    renderInspector();
    drawDisplayCanvas();
    closeYamlModal();
    showToast("YAML erfolgreich übernommen");
  } catch (err) {
    alert("Ungültiges JSON/YAML-Format: " + err.message);
  }
}
