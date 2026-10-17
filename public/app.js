// ---------- session identity ----------
const ID_RE = /^[A-Za-z0-9_-]{4,32}$/;

function randomId(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, b => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
}

const params = new URLSearchParams(location.search);
let sessionId = params.get("s");
if (!sessionId || !ID_RE.test(sessionId)) {
  sessionId = randomId(8);
  params.set("s", sessionId);
  history.replaceState(null, "", `${location.pathname}?${params.toString()}${location.hash}`);
}

// The token proves "this browser is Player N" after a refresh or reconnect.
function loadToken() {
  const key = `civ-token-${sessionId}`;
  try {
    let t = localStorage.getItem(key);
    if (!t) { t = randomId(24); localStorage.setItem(key, t); }
    return t;
  } catch (e) {
    return randomId(24);
  }
}
const token = loadToken();

// ---------- networking ----------
let S = null;            // last state sent by the server (already filtered for this player)
let ws = null;
let retry = 0;
let lastRev = null;
let errorMsg = "";
let banPanelOpen = false;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.addEventListener("open", () => {
    retry = 0;
    document.getElementById("connLost").hidden = true;
    send({ type: "join", id: sessionId, token });
  });

  ws.addEventListener("message", ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === "state") {
      S = msg;
      errorMsg = "";
      applyState();
    } else if (msg.type === "error") {
      errorMsg = msg.message;
      if (S) applyState();
    }
  });

  ws.addEventListener("close", () => {
    document.getElementById("connLost").hidden = false;
    const delay = Math.min(10000, 500 * 2 ** retry++);
    setTimeout(connect, delay);
  });
}

// ---------- icons ----------
function civIconImg(name) {
  const src = `icons/${encodeURIComponent(name.toLowerCase())}.png`;
  return `<img class="civ-icon" src="${src}" alt="" width="22" height="22">`;
}

// ---------- rendering ----------
function bannedSet() { return new Set(S ? S.banned : []); }

function banChipHtml(name, banned) {
  const isBanned = banned.has(name);
  const title = `${isBanned ? "Unban" : "Ban"} ${name}`;
  return `<button type="button" class="civ-chip${isBanned ? " banned" : ""}" data-name="${name}" title="${title}" aria-label="${title}">${civIconImg(name)}${name}</button>`;
}

function renderBanSection() {
  const section = document.getElementById("banSection");
  const grid = document.getElementById("banGrid");
  const label = document.getElementById("banLabel");
  const banned = bannedSet();

  if (banPanelOpen) {
    label.textContent = banned.size > 0
      ? `All civilizations — ${banned.size} banned. Cross out or bring back any, then Reroll to apply.`
      : "All civilizations — cross out any to ban them, then Roll.";
    grid.innerHTML = ALL_CIVILIZATIONS.map(n => banChipHtml(n, banned)).join("");
    section.hidden = false;
  } else if (banned.size > 0) {
    label.textContent = "Banned civilizations";
    grid.innerHTML = ALL_CIVILIZATIONS.filter(n => banned.has(n)).map(n => banChipHtml(n, banned)).join("");
    section.hidden = false;
  } else {
    grid.innerHTML = "";
    section.hidden = true;
  }

  const btn = document.getElementById("banToggleBtn");
  const btnLabel = banPanelOpen ? "Hide Bans" : "Select Bans";
  btn.textContent = banned.size > 0 ? `${btnLabel} (${banned.size})` : btnLabel;
}

function renderSessionBar() {
  const you = document.getElementById("youLabel");
  const opp = document.getElementById("oppLabel");
  you.className = "you";
  if (!S) {
    you.textContent = "Connecting…";
    opp.textContent = "";
    return;
  }
  if (S.you === 1 || S.you === 2) {
    you.classList.add(`p${S.you}`);
    you.textContent = `You are Player ${S.you}`;
    const other = S.you === 1 ? 2 : 1;
    if (!S.seatTaken[other]) {
      opp.className = "opp offline";
      opp.textContent = "Waiting for opponent — send them the invite link";
    } else if (S.online[other]) {
      opp.className = "opp online";
      opp.textContent = `Player ${other} is connected`;
    } else {
      opp.className = "opp offline";
      opp.textContent = `Player ${other} is offline`;
    }
  } else {
    you.textContent = "Spectating (this session already has two players)";
    opp.className = "opp";
    opp.textContent = "";
  }
}

const MAP_OPTION_INFO = [
  { key: "cityStates", label: "City-states", choices: [["yes", "Yes"], ["no", "No"]] },
  { key: "barbarians", label: "Barbarians", choices: [["yes", "Yes"], ["no", "No"]] },
  { key: "ruins", label: "Ancient ruins", choices: [["yes", "Yes"], ["no", "No"]] },
  { key: "congress", label: "World Congress", choices: [["yes", "Yes"], ["no", "No"]] },
];

function renderMapOptions() {
  const section = document.getElementById("mapOptionsSection");
  section.hidden = !S.hasRolled;
  if (!S.hasRolled) return;

  document.getElementById("mapOptionsLabel").textContent = S.optionsDone
    ? (S.optionsLocked ? "Game options — locked" : "Game options — set (can change until a civ is picked)")
    : "Game options — each player decides two, then civs can be picked";

  document.getElementById("mapOptionsGrid").innerHTML = MAP_OPTION_INFO.map(info => {
    const opt = S.mapOptions[info.key];
    if (!opt) return "";
    const mine = S.you === opt.owner;
    const canSet = mine && !S.optionsLocked;
    const owner = mine ? "Your choice" : `Player ${opt.owner}'s choice`;
    // The server withholds the opponent's choices until every option is set.
    const hidden = !mine && opt.value === null;
    const buttons = hidden
      ? `<span class="map-option-hidden">${opt.chosen ? "Chosen &#10003; — revealed when all options are set" : "Choosing&hellip;"}</span>`
      : info.choices.map(([value, text]) =>
          `<button type="button" class="choice-btn${opt.value === value ? " selected" : ""}"
             data-option="${info.key}" data-value="${value}" ${canSet ? "" : "disabled"}>${text}</button>`
        ).join("");
    const cls = `map-option p${opt.owner}${mine ? " mine" : ""}${opt.chosen ? " done" : ""}`;
    return `<div class="${cls}">
              <div class="map-option-head"><span>${info.label}</span><span class="map-option-owner">${owner}</span></div>
              <div class="map-option-choices">${buttons}</div>
            </div>`;
  }).join("");
}

function renderPlayers() {
  [1, 2].forEach(p => {
    const optsEl = document.getElementById(`options-${p}`);
    const mine = S.you === p;
    const canPick = mine && S.optionsDone;
    const crossed = new Set(S.crossed[p]);
    optsEl.innerHTML = S.pools[p].map(name => {
      const selected = S.picks[p] === name;
      const isCrossed = crossed.has(name);
      const btnLabel = isCrossed ? "&#8634;" : "&times;";
      const btnTitle = isCrossed ? `Bring back ${name}` : `Cross out ${name}`;
      const canCross = S.you === 1 || S.you === 2;
      const crossBtn = canCross
        ? `<button type="button" class="remove-btn${isCrossed ? " restore" : ""}"
              data-action="toggle-cross" data-player="${p}" data-name="${name}"
              aria-label="${btnTitle}" title="${btnTitle}">${btnLabel}</button>`
        : "";
      return `<div class="option-row">
                <button type="button" class="option-btn${selected ? " selected" : ""}${isCrossed ? " crossed" : ""}"
                  data-action="pick" data-player="${p}" data-name="${name}" ${mine && ((isCrossed && !selected) || !canPick) ? "disabled" : ""}>
                  <span class="opt-name">${civIconImg(name)}${name}</span><span class="tick">&#10003;</span>
                </button>
                ${crossBtn}
              </div>`;
    }).join("");

    document.querySelector(`.player-panel[data-player="${p}"] .player-name`).textContent =
      mine ? `Player ${p} (you)` : `Player ${p}`;

    const pickEl = document.getElementById(`pick-${p}`);
    if (S.picks[p]) pickEl.innerHTML = `Picked <strong>${S.picks[p]}</strong>`;
    else if (S.picked[p]) pickEl.innerHTML = "Has picked <strong>&#10003;</strong>";
    else pickEl.textContent = "No pick yet";
  });
}

function renderStatus() {
  const status = document.getElementById("status");
  if (errorMsg) { status.textContent = errorMsg; return; }
  if (!S.hasRolled) {
    status.textContent = "Open Select Bans to cross out any civilizations you don't want, then press Roll to draft. Either player can change bans, the count and roll — everyone sees the same thing. Player 1 and Player 2 draw from separate, non-overlapping sets.";
  } else if (S.revealed) {
    status.innerHTML = `<strong>Player 1</strong> plays ${S.picks[1]} &middot; <strong>Player 2</strong> plays ${S.picks[2]}`;
  } else if (!S.optionsDone) {
    status.textContent = "Set your game options first. You can already look at both civ pools and cross civs out — picking unlocks once all four options are chosen.";
  } else if (S.you === 1 || S.you === 2) {
    status.textContent = S.picked[S.you]
      ? "You have picked. Waiting for your opponent — picks are revealed when both players have chosen."
      : "Click a civilization in your panel to pick it (click again to undo), or the × to cross it out. Your opponent can't see your pick until they choose too.";
  } else {
    status.textContent = "Picks are revealed when both players have chosen.";
  }
}

function applyState() {
  const panels = document.querySelectorAll(".player-panel");
  const rerolled = lastRev !== null && S.rev !== lastRev;
  lastRev = S.rev;
  if (rerolled) panels.forEach(el => el.classList.add("shuffling"));

  const canAct = S.you === 1 || S.you === 2;
  const rollBtn = document.getElementById("rollBtn");
  const countInput = document.getElementById("countInput");
  rollBtn.textContent = S.hasRolled ? "Reroll" : "Roll";
  rollBtn.disabled = !canAct;
  countInput.disabled = !canAct;
  countInput.max = S.maxCount;
  countInput.title = `How many civilizations each player gets (max ${S.maxCount})`;
  if (document.activeElement !== countInput) countInput.value = S.count;
  document.getElementById("playersSection").hidden = !S.hasRolled;

  hideCivPopup();
  renderSessionBar();
  renderBanSection();
  renderMapOptions();
  renderPlayers();
  renderStatus();

  if (rerolled) {
    void document.body.offsetWidth; // flush so the fade-in transition runs
    setTimeout(() => panels.forEach(el => el.classList.remove("shuffling")), 40);
  }
}

// ---------- civilopedia popup (unchanged from the single-player page) ----------
const civPopup = document.getElementById("civPopup");

function hideCivPopup() {
  civPopup.hidden = true;
}

function positionCivPopup(targetEl) {
  const rect = targetEl.getBoundingClientRect();
  const margin = 10;
  const pw = civPopup.offsetWidth;
  const ph = civPopup.offsetHeight;

  let left = rect.right + margin;
  let placeBelow = false;
  if (left + pw + 16 > window.innerWidth) {
    left = rect.left - pw - margin;
    if (left < 16) placeBelow = true;
  }

  let top;
  if (placeBelow) {
    left = Math.max(16, Math.min(rect.left, window.innerWidth - pw - 16));
    top = rect.bottom + margin;
  } else {
    top = rect.top;
  }
  if (top + ph + 16 > window.innerHeight) {
    top = Math.max(16, window.innerHeight - ph - 16);
  }

  civPopup.style.left = `${left}px`;
  civPopup.style.top = `${top}px`;
}

function civPopupRow(label, name, description, replaces) {
  const suffix = replaces ? ` <span class="replaces">(replaces ${replaces})</span>` : "";
  return `<div class="civ-popup-row">
            <dt>${label} &mdash; <span>${name}</span>${suffix}</dt>
            <dd>${description}</dd>
          </div>`;
}

function showCivPopup(name, targetEl) {
  const data = CIVILOPEDIA[name];
  if (!data) { hideCivPopup(); return; }

  civPopup.querySelector(".civ-popup-name").innerHTML = `${civIconImg(name)}${name}`;
  civPopup.querySelector(".civ-popup-leader").textContent = `Led by ${data.leader}`;

  let rows = civPopupRow("Leader Ability", data.leaderAbility.name, data.leaderAbility.description, null);
  data.units.forEach(u => {
    rows += civPopupRow("Unique Unit", u.name, u.description, u.replaces);
  });
  data.buildings.forEach(b => {
    rows += civPopupRow(b.isImprovement ? "Unique Improvement" : "Unique Building", b.name, b.description, b.replaces);
  });
  document.getElementById("civPopupBody").innerHTML = rows;

  civPopup.hidden = false;
  positionCivPopup(targetEl);
}

// ---------- user actions: send to the server; the server's state drives the UI ----------
document.addEventListener("click", e => {
  const chip = e.target.closest(".civ-chip");
  if (chip) {
    send({ type: "toggleBan", civ: chip.dataset.name });
    return;
  }

  const choice = e.target.closest(".choice-btn");
  if (choice) {
    send({ type: "setOption", key: choice.dataset.option, value: choice.dataset.value });
    return;
  }

  const btn = e.target.closest("button[data-action]");
  if (!btn || !S) return;
  const p = Number(btn.dataset.player);

  if (btn.dataset.action === "pick") {
    if (p !== S.you) return; // you can only pick from your own panel
    send({ type: "pick", civ: btn.dataset.name });
  } else if (btn.dataset.action === "toggle-cross") {
    send({ type: "toggleCross", civ: btn.dataset.name, player: p }); // either panel
  }
});

document.addEventListener("mouseover", e => {
  const btn = e.target.closest(".option-btn, .civ-chip");
  if (btn) showCivPopup(btn.dataset.name, btn);
});

document.addEventListener("mouseout", e => {
  const btn = e.target.closest(".option-btn, .civ-chip");
  if (btn && !btn.contains(e.relatedTarget)) hideCivPopup();
});

document.addEventListener("focusin", e => {
  const btn = e.target.closest(".option-btn, .civ-chip");
  if (btn) showCivPopup(btn.dataset.name, btn);
});

document.addEventListener("focusout", e => {
  const btn = e.target.closest(".option-btn, .civ-chip");
  if (btn) hideCivPopup();
});

window.addEventListener("scroll", hideCivPopup, { passive: true, capture: true });

document.getElementById("banToggleBtn").addEventListener("click", () => {
  banPanelOpen = !banPanelOpen;
  renderBanSection();
});

document.getElementById("rollBtn").addEventListener("click", () => {
  banPanelOpen = false;
  send({ type: "roll" });
});

document.getElementById("countInput").addEventListener("change", e => {
  send({ type: "setCount", n: e.target.value });
});

document.getElementById("copyLinkBtn").addEventListener("click", async e => {
  const btn = e.currentTarget;
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    btn.textContent = "Copied!";
  } catch (err) {
    window.prompt("Copy this link and send it to your opponent:", url);
    return;
  }
  setTimeout(() => { btn.textContent = "Copy invite link"; }, 1500);
});

renderSessionBar();
renderBanSection();
connect();
