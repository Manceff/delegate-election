(() => {
  "use strict";

  const { supabaseUrl, supabaseKey } = window.ELECTION_CONFIG;
  const TZ = "Europe/Paris";
  const REFRESH_MS = 15000;
  const TICK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // Codes raised by the database functions → what the voter should read.
  const ERRORS = {
    polls_closed: "Polls are closed, so no more ballots or candidacies are accepted.",
    invalid_name: "Enter your first and last name (3 to 60 characters).",
    invalid_statement: "Your statement needs between 20 and 600 characters.",
    device_already_candidate: "A candidacy has already been submitted from this device.",
    name_taken: "A candidate with this name is already on the ballot.",
    too_many_candidates: "The ballot is full (40 candidates). Contact the class organiser.",
    unknown_candidate: "That candidate is no longer on the ballot. Tick another name.",
    device_already_voted: "A ballot has already been cast from this device.",
    name_already_voted: "This name is already on the voter roll. If you haven’t voted, tell the class organiser.",
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
    if (err.code === "network") return "Couldn’t reach the ballot box. Check your connection and try again.";
    return `The ballot box refused this request (${err.message}).`;
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
    const pill = $("status-pill");
    const closed = Boolean(d && d.closed);
    pill.classList.toggle("is-open", !closed);
    pill.classList.toggle("is-closed", closed);
    $("status-text").textContent = state.failed ? "Reconnecting…" : closed ? "Polls closed" : "Polls open";

    if (!d) {
      $("vote-loading").hidden = state.failed;
      showMessage("vote-message", state.failed && {
        title: "Couldn’t reach the ballot box.",
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
    $("closes").textContent = `${when} · Paris time`;
    $("closed-when").textContent = `Polls closed on ${when}, Paris time. The count is below.`;
    $("rule-result").textContent = d.closed
      ? `Polls closed on ${when}, Paris time, and the count is published on this page. A tie for first place is settled by a run-off.`
      : `The count stays sealed until polls close on ${when}, Paris time. Results then appear on this page. A tie for first place is settled by a run-off.`;
    $("count-candidates").textContent = n;
    $("label-candidates").textContent = plural(n, "candidate", "candidates");
    $("count-turnout").textContent = d.turnout;
    $("label-turnout").textContent = plural(d.turnout, "ballot cast", "ballots cast");
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
        title: "Your ballot is in the box.",
        text: `Thanks for voting. The count stays sealed until polls close on ${closeLabel(d.polls_close_at)}, Paris time. Come back then for the result.`,
      });
      return;
    }

    if (!d.candidates.length) {
      form.hidden = true;
      showMessage("vote-message", {
        title: "Nobody is on the ballot yet.",
        text: "Candidacies stay open until polls close. Want the job? Be the first to run.",
        action: { label: "Run for delegate", run: () => selectTab("run", true) },
      });
      return;
    }

    showMessage("vote-message", null);
    form.hidden = false;
    const n = d.candidates.length;
    $("ballot-sub").textContent = `${n} ${plural(n, "candidate", "candidates")} · order shuffled for each voter`;
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

    const head = el("div", "sheet-head");
    head.append(el("h2", null, "The count"), el("p", null, `${total} ${plural(total, "ballot", "ballots")} counted`));

    const intro = el("div", "msg");
    if (!ranked.length) {
      intro.append(el("h3", null, "No candidates stood in this election."));
    } else if (!leaders.length) {
      intro.append(el("h3", null, "No ballots were cast."));
    } else if (tie) {
      intro.append(
        el("h3", null, `Tie for first place: ${leaders.map((c) => c.full_name).join(" and ")}.`),
        el("p", null, `Each has ${top} ${plural(top, "vote", "votes")}. A run-off between them decides the delegate.`),
      );
    } else {
      intro.append(
        el("h3", null, `${leaders[0].full_name} is elected class delegate.`),
        el("p", null, `${top} of ${total} ${plural(total, "vote", "votes")}.`),
      );
    }

    const list = el("ul", "ballot");
    for (const c of ranked) {
      const lead = leaders.includes(c);
      const li = el("li", lead ? "result is-winner" : "result");
      const row = el("div", "result-top");
      const name = el("span", "cand-name", c.full_name);
      if (lead) name.append(el("span", "stamp", tie ? "Tied" : "Elected"));
      const votes = el("span", "result-votes", String(c.votes));
      votes.append(el("small", null, ` ${total ? Math.round((c.votes / total) * 100) : 0}%`));
      row.append(name, votes);
      const bar = el("div", "bar");
      bar.setAttribute("aria-hidden", "true");
      const fill = el("i");
      fill.style.width = `${total ? (c.votes / total) * 100 : 0}%`;
      bar.append(fill);
      li.append(row, bar);
      list.append(li);
    }
    $("results").replaceChildren(head, intro, list);
  }

  function renderRun(d) {
    const me = d.me || {};
    const mine = d.candidates.find((c) => c.id === me.candidate_id);
    const form = $("run-form");

    if (mine || state.registered) {
      form.hidden = true;
      showMessage("run-message", {
        ok: true,
        title: "You’re on the ballot.",
        text: `${mine ? mine.full_name + ": c" : "C"}lassmates can now vote for you. Share the link so everyone reads your statement.`,
        action: d.closed ? null : { label: "See the ballot", run: () => selectTab("vote", true) },
      });
      return;
    }
    if (d.closed) {
      form.hidden = true;
      showMessage("run-message", { title: "Candidacies are closed.", text: "Polls have closed, so no new names can be added." });
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
    $("vote-submit").textContent = "Cast my ballot";
    $("vote-confirm-hint").hidden = true;
  }

  $("vote-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const d = state.data;
    if (!d) return;
    $("vote-error").hidden = true;

    const candidate = d.candidates.find((c) => c.id === state.selected);
    if (!candidate) return showError("vote-error", "Tick one name on the ballot first.");
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
    button.textContent = "Casting your ballot…";
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
    button.textContent = "Adding your name…";
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
      button.textContent = "Put my name on the ballot";
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
