(() => {
  "use strict";

  const { supabaseUrl, supabaseKey } = window.ELECTION_CONFIG;
  const TZ = "Europe/Paris";
  const REFRESH_MS = 15000;
  const TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Codes raised by the database functions → what the voter should read.
  const ERRORS = {
    polls_closed: "Voting is closed, so no more votes or candidacies are accepted.",
    invalid_name: "Enter your first and last name (3 to 60 characters).",
    invalid_statement: "Your statement needs between 20 and 600 characters.",
    device_already_candidate: "A candidacy has already been submitted from this device.",
    name_taken: "A candidate with this name is already standing.",
    too_many_candidates: "The candidate list is full (40). Contact the organiser.",
    unknown_candidate: "That candidate has been removed. Choose another one.",
    device_already_voted: "A vote has already been submitted from this device.",
    name_already_voted: "This name has already voted. If it wasn’t you, tell the organiser.",
    missing_device: "Your browser is blocking this page’s storage. Try another browser.",
  };

  const $ = (id) => document.getElementById(id);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  // One random id per browser: the server allows one ballot and one candidacy per id.
  const deviceId = (() => {
    const key = "delegate-election:device";
    try {
      const saved = localStorage.getItem(key);
      if (saved && /^[0-9a-f-]{36}$/i.test(saved)) return saved;
      const id = uuid();
      localStorage.setItem(key, id);
      return id;
    } catch {
      return uuid();
    }
  })();

  const cleanName = (s) => s.trim().replace(/\s+/g, " ");
  const validName = (s) => s.length >= 3 && s.length <= 60 && s.includes(" ");
  const plural = (n, one, many) => (n === 1 ? one : many);

  async function rpc(fn, args) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let res;
    try {
      res = await fetch(`${supabaseUrl}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { apikey: supabaseKey, "Content-Type": "application/json" },
        body: JSON.stringify(args),
        signal: controller.signal,
      });
    } catch {
      throw Object.assign(new Error("network"), { code: "network" });
    } finally {
      clearTimeout(timer);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const message = (body && body.message) || `HTTP ${res.status}`;
      throw Object.assign(new Error(message), { code: message });
    }
    return body;
  }

  function explain(err) {
    if (ERRORS[err.code]) return ERRORS[err.code];
    if (err.code === "network") return "Couldn’t reach the server. Check your connection and try again.";
    return `The server refused this request (${err.message}).`;
  }

  const state = {
    data: null,
    offset: 0, // server clock minus this device's clock, in ms
    failed: false,
    selected: null,
    confirmFor: null,
    voted: false,
    registered: false,
  };

  // Loads run one after another so a vote is never followed by a stale snapshot.
  let chain = Promise.resolve();
  function load() {
    chain = chain.then(fetchState);
    return chain;
  }

  async function fetchState() {
    try {
      const sent = Date.now();
      const data = await rpc("election_state", { p_device: deviceId });
      state.offset = Date.parse(data.server_now) - (sent + Date.now()) / 2;
      state.data = data;
      state.failed = false;
    } catch {
      state.failed = true;
    }
    render();
  }

  function closeLabel(iso) {
    const date = new Date(iso);
    const hm = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
    const day = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "long", day: "numeric", month: "long" });
    if (hm === "00:00") return `${day.format(new Date(date.getTime() - 1))} at midnight`;
    return `${day.format(date)} at ${hm}`;
  }

  // Stable per voter, different between voters: nobody gets a top-of-ballot advantage.
  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  const shuffled = (cands) => [...cands].sort((a, b) => hash(deviceId + a.id) - hash(deviceId + b.id));

  /* ---------- Countdown ---------- */

  const pad = (n) => String(n).padStart(2, "0");
  let srMinute = -1;
  let closingCheck = false;

  function tick() {
    const d = state.data;
    if (!d || d.closed) return;
    const left = Math.max(0, Date.parse(d.polls_close_at) - (Date.now() + state.offset));
    const s = Math.floor(left / 1000);
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    $("clock-days").textContent = pad(days);
    $("clock-hours").textContent = pad(hours);
    $("clock-minutes").textContent = pad(minutes);
    $("clock-seconds").textContent = pad(s % 60);
    if (Math.floor(s / 60) !== srMinute) {
      srMinute = Math.floor(s / 60);
      $("clock-sr").textContent = `${days} days, ${hours} hours and ${minutes} minutes left to vote.`;
    }
    if (left === 0 && !closingCheck) {
      closingCheck = true;
      setTimeout(() => load().then(() => { closingCheck = false; }), 2000);
    }
  }

  /* ---------- Rendering ---------- */

  function showMessage(id, msg) {
    const box = $(id);
    const sig = msg ? JSON.stringify([msg.ok, msg.title, msg.text, msg.action && msg.action.label]) : "";
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    if (!msg) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    const wrap = el("div", msg.ok ? "msg is-ok" : "msg");
    wrap.append(el("h3", null, msg.title));
    if (msg.text) wrap.append(el("p", null, msg.text));
    if (msg.action) {
      const button = el("button", "btn", msg.action.label);
      button.type = "button";
      button.addEventListener("click", msg.action.run);
      wrap.append(button);
    }
    box.replaceChildren(wrap);
    box.hidden = false;
  }

  function focusHeading(id) {
    const h = $(id).querySelector("h3");
    if (!h) return;
    h.tabIndex = -1;
    h.focus();
  }

  function render() {
    const d = state.data;
    const closed = Boolean(d && d.closed);
    $("status-text").textContent = state.failed ? "Reconnecting…" : closed ? "Voting closed" : "Voting open";

    if (!d) {
      $("vote-loading").hidden = state.failed;
      showMessage("vote-message", state.failed && {
        title: "Couldn’t load the election.",
        text: "Check your connection. The page tries again every 15 seconds.",
      });
      return;
    }
    $("vote-loading").hidden = true;
    renderHero(d);
    renderVote(d);
    renderRun(d);
    tick();
  }

  function renderHero(d) {
    const when = closeLabel(d.polls_close_at);
    const n = d.candidates.length;
    $("clock-wrap").hidden = d.closed;
    $("closed-banner").hidden = !d.closed;
    $("closes").textContent = when;
    $("closed-when").textContent = `Voting closed on ${when}, Paris time.`;
    $("rule-result").textContent = d.closed
      ? `Voting closed on ${when}, Paris time. The results are shown on this page. A tie for first place is settled by a run-off.`
      : `Results stay hidden until voting closes on ${when}, Paris time, then appear on this page. A tie for first place is settled by a run-off.`;
    $("count-candidates").textContent = n;
    $("label-candidates").textContent = plural(n, "candidate", "candidates");
    $("count-turnout").textContent = d.turnout;
    $("label-turnout").textContent = plural(d.turnout, "vote cast", "votes cast");
    $("tab-vote").textContent = d.closed ? "Results" : "Vote";
    $("run-sub").textContent = d.closed ? "Closed" : `Open until ${when}`;
  }

  function renderVote(d) {
    const me = d.me || {};
    const form = $("vote-form");

    if (d.closed) {
      form.hidden = true;
      showMessage("vote-message", null);
      renderResults(d.candidates);
      $("results").hidden = false;
      return;
    }
    $("results").hidden = true;

    if (me.has_voted || state.voted) {
      form.hidden = true;
      showMessage("vote-message", {
        ok: true,
        title: "Your vote has been recorded.",
        text: `Thank you. Results will be published here when voting closes on ${closeLabel(d.polls_close_at)}, Paris time.`,
      });
      return;
    }

    if (!d.candidates.length) {
      form.hidden = true;
      showMessage("vote-message", {
        title: "No candidates yet.",
        text: "Candidacies are open until voting closes. Interested? Submit yours.",
        action: { label: "Stand as a candidate", run: () => selectTab("run", true) },
      });
      return;
    }

    showMessage("vote-message", null);
    form.hidden = false;
    const n = d.candidates.length;
    $("ballot-sub").textContent = `${n} ${plural(n, "candidate", "candidates")}, listed in random order`;
    renderBallot(d.candidates, me.candidate_id);
  }

  let ballotSig = "";
  function renderBallot(cands, myCandidateId) {
    if (state.selected && !cands.some((c) => c.id === state.selected)) {
      state.selected = null;
      resetConfirm();
    }
    const sig = JSON.stringify([myCandidateId, cands.map((c) => [c.id, c.full_name, c.statement])]);
    if (sig === ballotSig) return;
    ballotSig = sig;

    $("ballot").replaceChildren(...shuffled(cands).map((c) => {
      const li = el("li", "option");
      const input = el("input");
      input.type = "radio";
      input.name = "candidate";
      input.id = `c-${c.id}`;
      input.value = c.id;
      input.checked = state.selected === c.id;
      input.addEventListener("change", () => {
        state.selected = c.id;
        $("vote-error").hidden = true;
        resetConfirm();
      });

      const label = el("label");
      label.htmlFor = input.id;
      const box = el("span", "box");
      box.innerHTML = TICK_SVG;
      const text = el("span");
      const name = el("span", "cand-name", c.full_name);
      if (c.id === myCandidateId) name.append(el("span", "chip", "You"));
      text.append(name, el("span", "cand-statement", c.statement));
      label.append(box, text);

      li.append(input, label);
      return li;
    }));
  }

  function renderResults(cands) {
    const total = cands.reduce((sum, c) => sum + (c.votes || 0), 0);
    const ranked = [...cands].sort((a, b) => b.votes - a.votes || a.full_name.localeCompare(b.full_name));
    const top = ranked.length ? ranked[0].votes : 0;
    const leaders = top > 0 ? ranked.filter((c) => c.votes === top) : [];
    const tie = leaders.length > 1;

    const head = el("div", "panel-head");
    head.append(el("h2", null, "Results"), el("p", null, `${total} ${plural(total, "vote", "votes")} counted`));

    let lead;
    if (!ranked.length) lead = "Nobody stood in this election.";
    else if (!leaders.length) lead = "No votes were cast.";
    else if (tie) lead = `Tie for first place between ${leaders.map((c) => c.full_name).join(" and ")}, with ${top} ${plural(top, "vote", "votes")} each. A run-off will decide.`;
    else lead = `${leaders[0].full_name} is elected class representative, with ${top} of ${total} ${plural(total, "vote", "votes")}.`;

    if (!ranked.length) {
      $("results").replaceChildren(head, el("p", "result-lead", lead));
      return;
    }

    const headRow = el("tr");
    for (const [label, cls] of [["Candidate", null], ["Votes", "num"], ["Share", "num"]]) {
      const th = el("th", cls, label);
      th.scope = "col";
      headRow.append(th);
    }
    const thead = el("thead");
    thead.append(headRow);

    const tbody = el("tbody");
    for (const c of ranked) {
      const row = el("tr");
      const name = el("th", null, c.full_name);
      name.scope = "row";
      if (leaders.includes(c)) name.append(el("span", "tag", tie ? "Tied" : "Elected"));
      row.append(name, el("td", "num", String(c.votes)), el("td", "num", `${total ? Math.round((c.votes / total) * 100) : 0}%`));
      tbody.append(row);
    }

    const table = el("table", "results");
    table.append(thead, tbody);
    const scroll = el("div", "table-scroll");
    scroll.append(table);
    $("results").replaceChildren(head, el("p", "result-lead", lead), scroll);
  }

  function renderRun(d) {
    const me = d.me || {};
    const mine = d.candidates.find((c) => c.id === me.candidate_id);
    const form = $("run-form");

    if (mine || state.registered) {
      form.hidden = true;
      showMessage("run-message", {
        ok: true,
        title: "Your candidacy is registered.",
        text: `${mine ? mine.full_name + " now appears" : "You now appear"} in the candidate list. Share the link so classmates can read your statement.`,
        action: d.closed ? null : { label: "See the candidates", run: () => selectTab("vote", true) },
      });
      return;
    }
    if (d.closed) {
      form.hidden = true;
      showMessage("run-message", { title: "Candidacies are closed.", text: "Voting has closed, so no new candidacies can be added." });
      return;
    }
    showMessage("run-message", null);
    form.hidden = false;
  }

  /* ---------- Actions ---------- */

  function showError(id, text, focusId) {
    const box = $(id);
    box.textContent = text;
    box.hidden = false;
    if (focusId) $(focusId).focus();
  }

  function resetConfirm() {
    state.confirmFor = null;
    $("vote-submit").textContent = "Submit my vote";
    $("vote-confirm-hint").hidden = true;
  }

  $("vote-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const d = state.data;
    if (!d) return;
    $("vote-error").hidden = true;

    const candidate = d.candidates.find((c) => c.id === state.selected);
    if (!candidate) return showError("vote-error", "Choose a candidate first.");
    const name = cleanName($("voter-name").value);
    if (!validName(name)) return showError("vote-error", ERRORS.invalid_name, "voter-name");

    if (state.confirmFor !== candidate.id) {
      state.confirmFor = candidate.id;
      $("vote-submit").textContent = `Confirm my vote for ${candidate.full_name}`;
      $("vote-confirm-hint").hidden = false;
      return;
    }

    const button = $("vote-submit");
    button.disabled = true;
    button.textContent = "Submitting your vote…";
    try {
      await rpc("election_vote", { p_full_name: name, p_candidate: candidate.id, p_device: deviceId });
      state.voted = true;
      render();
      focusHeading("vote-message");
      load();
    } catch (err) {
      showError("vote-error", explain(err));
      if (err.code !== "network") load();
    } finally {
      button.disabled = false;
      resetConfirm();
    }
  });

  $("run-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("run-error").hidden = true;
    const name = cleanName($("run-name").value);
    const statement = $("run-statement").value.trim();
    if (!validName(name)) return showError("run-error", ERRORS.invalid_name, "run-name");
    if (statement.length < 20 || statement.length > 600) return showError("run-error", ERRORS.invalid_statement, "run-statement");

    const button = $("run-submit");
    button.disabled = true;
    button.textContent = "Submitting…";
    try {
      await rpc("election_register", { p_full_name: name, p_statement: statement, p_device: deviceId });
      state.registered = true;
      $("run-form").reset();
      updateCounter();
      await load();
      focusHeading("run-message");
    } catch (err) {
      showError("run-error", explain(err));
      if (err.code !== "network") load();
    } finally {
      button.disabled = false;
      button.textContent = "Submit my candidacy";
    }
  });

  function updateCounter() {
    $("run-counter").textContent = `${$("run-statement").value.length} / 600`;
  }
  $("run-statement").addEventListener("input", () => {
    updateCounter();
    $("run-error").hidden = true;
  });
  $("run-name").addEventListener("input", () => { $("run-error").hidden = true; });
  $("voter-name").addEventListener("input", () => {
    $("vote-error").hidden = true;
    if (state.confirmFor) resetConfirm();
  });

  /* ---------- Tabs ---------- */

  const TABS = ["vote", "run"];
  function selectTab(name, focus) {
    for (const t of TABS) {
      const on = t === name;
      const tab = $(`tab-${t}`);
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      $(`panel-${t}`).hidden = !on;
    }
    if (focus) {
      $(`tab-${name}`).focus();
      try { history.replaceState(null, "", `#${name}`); } catch { /* sandboxed */ }
    }
  }
  for (const t of TABS) {
    $(`tab-${t}`).addEventListener("click", () => selectTab(t, true));
    $(`tab-${t}`).addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      selectTab(t === "vote" ? "run" : "vote", true);
    });
  }

  /* ---------- Boot ---------- */

  selectTab(location.hash === "#run" ? "run" : "vote", false);
  updateCounter();
  load();
  setInterval(tick, 1000);
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
})();
