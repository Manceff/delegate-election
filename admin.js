(() => {
  "use strict";

  const { supabaseUrl, supabaseKey } = window.ELECTION_CONFIG;
  const TZ = "Europe/Paris";
  const KEY_STORE = "delegate-election:admin-key";
  const LIST_STORE = "delegate-election:class-list";
  const REFRESH_MS = 20000;

  const MESSAGES = {
    not_admin: "This key isn’t valid.",
    not_found: "Already removed. The lists have been refreshed.",
    network: "Couldn’t reach the server. Check your connection and try again.",
  };

  const photoUrl = (path) => `${supabaseUrl}/storage/v1/object/public/candidate-photos/${path}`;

  const $ = (id) => document.getElementById(id);
  const plural = (n, one, many) => (n === 1 ? one : many);

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  // Session by default; "Remember on this device" keeps the key in localStorage.
  const keyStore = {
    get() {
      try { return sessionStorage.getItem(KEY_STORE) || localStorage.getItem(KEY_STORE); } catch { return null; }
    },
    set(key, remember) {
      try { (remember ? localStorage : sessionStorage).setItem(KEY_STORE, key); } catch { /* storage blocked */ }
    },
    clear() {
      try { sessionStorage.removeItem(KEY_STORE); localStorage.removeItem(KEY_STORE); } catch { /* storage blocked */ }
    },
  };

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

  const explain = (err) => MESSAGES[err.code] || `The server refused this request (${err.message}).`;

  const dateTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const clockTime = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const when = (iso) => dateTime.format(new Date(iso));

  /* ---------- Name matching ---------- */

  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const words = (s) => norm(s).split(" ").filter(Boolean);
  const sortedKey = (s) => words(s).sort().join(" ");

  function distance(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const next = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = next;
      }
    }
    return row[b.length];
  }

  function likeness(a, b) {
    if (norm(a) === norm(b)) return "Same name, written differently";
    if (sortedKey(a) === sortedKey(b)) return "Same words in a different order";
    const wa = words(a);
    const wb = words(b);
    if (wa.every((w) => wb.includes(w)) || wb.every((w) => wa.includes(w))) return "One name contains the other";
    const d = Math.min(distance(norm(a), norm(b)), distance(sortedKey(a), sortedKey(b)));
    return d <= 2 ? `Spelling ${d} ${plural(d, "letter", "letters")} apart` : null;
  }

  function findPairs(items) {
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const reason = likeness(items[i].full_name, items[j].full_name);
        if (reason) pairs.push({ a: items[i], b: items[j], reason });
      }
    }
    return pairs;
  }

  /* ---------- State ---------- */

  let adminKey = null;
  let data = null;

  let chain = Promise.resolve(true);
  function load() {
    chain = chain.then(fetchOverview, fetchOverview);
    return chain;
  }

  async function fetchOverview() {
    if (!adminKey) return false;
    try {
      data = await rpc("admin_overview", { p_key: adminKey });
      render();
      $("updated").textContent = `Updated ${clockTime.format(new Date())}`;
      return true;
    } catch (err) {
      if (err.code === "not_admin") {
        signOut(MESSAGES.not_admin);
      } else {
        $("updated").textContent = "Couldn’t refresh. Trying again shortly.";
      }
      return false;
    }
  }

  function openDashboard() {
    $("gate").hidden = true;
    $("dashboard").hidden = false;
  }

  function signOut(message) {
    keyStore.clear();
    adminKey = null;
    data = null;
    $("dashboard").hidden = true;
    $("gate").hidden = false;
    const box = $("gate-error");
    box.textContent = message || "";
    box.hidden = !message;
  }

  let toastTimer;
  function toast(text, isError) {
    const box = $("toast");
    box.textContent = text;
    box.classList.toggle("is-error", Boolean(isError));
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 6000);
  }

  /* ---------- Rendering ---------- */

  function render() {
    const closed = Date.parse(data.server_now) >= Date.parse(data.polls_close_at);
    const stats = [
      [data.candidates.length, plural(data.candidates.length, "candidate", "candidates")],
      [data.voters.length, plural(data.voters.length, "person has voted", "people have voted")],
      [data.ballots, plural(data.ballots, "vote counted", "votes counted")],
    ];
    $("stats").replaceChildren(...stats.map(([n, label]) => {
      const li = el("li");
      li.append(el("strong", null, String(n)), label);
      return li;
    }));

    const notes = [el("p", "status-line", closed
      ? `Voting closed on ${when(data.polls_close_at)}. Results are public on the election page.`
      : `Voting closes on ${when(data.polls_close_at)}, Paris time. Counts below are not public yet.`)];
    if (data.unlinked_ballots > 0) {
      notes.push(el("p", "alert is-warn", `${data.unlinked_ballots} early ${plural(data.unlinked_ballots, "vote is", "votes are")} not linked to a name: removing that voter from the roll won’t remove the vote.`));
    }
    if (data.ballots !== data.voters.length) {
      notes.push(el("p", "alert is-warn", `The vote count (${data.ballots}) doesn’t match the voter roll (${data.voters.length}).`));
    }
    $("notes").replaceChildren(...notes);

    renderCandidates();
    renderDupes();
    renderRoll();
    renderClassCheck();
  }

  const initials = (name) => (name || "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("");

  function avatar(candidate) {
    const box = el("span", "avatar avatar-sm");
    if (candidate.photo_path) {
      const img = el("img");
      img.src = photoUrl(candidate.photo_path);
      img.alt = "";
      img.loading = "lazy";
      box.append(img);
    } else {
      box.append(el("span", "initials", initials(candidate.full_name)));
    }
    return box;
  }

  function removeButton(name, onClick) {
    const button = el("button", "btn btn-danger btn-small", "Remove");
    button.type = "button";
    button.setAttribute("aria-label", `Remove ${name}`);
    button.addEventListener("click", onClick);
    return button;
  }

  function fillTable(table, headers, rows, emptyText) {
    const headRow = el("tr");
    for (const [label, cls] of headers) {
      const th = el("th", cls, label);
      th.scope = "col";
      headRow.append(th);
    }
    const thead = el("thead");
    thead.append(headRow);
    const tbody = el("tbody");
    if (rows.length) {
      tbody.append(...rows);
    } else {
      const row = el("tr");
      const cell = el("td", "empty", emptyText);
      cell.colSpan = headers.length;
      row.append(cell);
      tbody.append(row);
    }
    table.replaceChildren(thead, tbody);
  }

  function renderCandidates() {
    const ranked = [...data.candidates].sort((a, b) => b.votes - a.votes || a.full_name.localeCompare(b.full_name));
    const rows = ranked.map((c) => {
      const row = el("tr");
      const name = el("td", "name");
      const label = el("span", "with-avatar");
      label.append(avatar(c), el("span", null, c.full_name));
      name.append(label, el("span", "sub", c.statement));
      const actions = el("td", "actions");
      if (c.photo_path) {
        const photoButton = el("button", "btn btn-quiet btn-small", "Remove photo");
        photoButton.type = "button";
        photoButton.addEventListener("click", () => removePhoto(c));
        actions.append(photoButton, document.createTextNode(" "));
      }
      actions.append(removeButton(c.full_name, () => removeCandidate(c)));
      row.append(name, el("td", null, when(c.registered_at)), el("td", "num", String(c.votes)), actions);
      return row;
    });
    fillTable($("cand-table"), [["Candidate", null], ["Registered", null], ["Votes", "num"], ["", "actions"]], rows, "No candidates yet.");
  }

  function renderRoll() {
    const rows = data.voters.map((v, i) => {
      const row = el("tr");
      const name = el("td", "name", v.full_name);
      if (!v.ballot_linked) name.append(el("span", "sub", "Early vote, not linked to the name"));
      const actions = el("td", "actions");
      actions.append(removeButton(v.full_name, () => removeVoter(v)));
      row.append(el("td", "num", String(i + 1)), name, el("td", null, when(v.voted_at)), actions);
      return row;
    });
    fillTable($("roll-table"), [["No.", "num"], ["Name", null], ["Voted", null], ["", "actions"]], rows, "Nobody has voted yet.");
  }

  function renderDupes() {
    const groups = [
      ["Candidates", findPairs(data.candidates), removeCandidate, (c) => `${c.votes} ${plural(c.votes, "vote", "votes")}`],
      ["Voters", findPairs(data.voters), removeVoter, (v) => `voted ${when(v.voted_at)}`],
    ];
    const items = [];
    for (const [kind, pairs, remove, detail] of groups) {
      for (const pair of pairs) {
        const li = el("li", "dupe");
        li.append(el("span", "dupe-reason", `${kind}: ${pair.reason}`));
        const box = el("div", "dupe-items");
        for (const entry of [pair.a, pair.b]) {
          const item = el("div", "dupe-item");
          item.append(el("strong", null, entry.full_name), el("span", null, detail(entry)), removeButton(entry.full_name, () => remove(entry)));
          box.append(item);
        }
        li.append(box);
        items.push(li);
      }
    }
    if (!items.length) {
      $("dupes").replaceChildren(el("p", "empty", "No likely duplicates found."));
      return;
    }
    const list = el("ul", "dupes");
    list.append(...items);
    $("dupes").replaceChildren(list);
  }

  function listOf(items, emptyText) {
    if (!items.length) return el("p", "empty", emptyText);
    const list = el("ul", "plain-list");
    list.append(...items);
    return list;
  }

  function renderClassCheck() {
    const names = $("class-list").value.split(/\r?\n/).map((s) => s.trim()).filter((s) => words(s).length);
    if (!names.length) {
      $("missing-title").textContent = "Not voted yet";
      $("unknown-title").textContent = "Voted, not on the list";
      $("missing").replaceChildren(el("p", "empty", "Paste the class list above."));
      $("unknown").replaceChildren(el("p", "empty", "Paste the class list above."));
      return;
    }
    const voterKeys = new Set(data.voters.map((v) => sortedKey(v.full_name)));
    const listKeys = new Set(names.map(sortedKey));
    const notVoted = names.filter((n) => !voterKeys.has(sortedKey(n)));
    const notListed = data.voters.filter((v) => !listKeys.has(sortedKey(v.full_name)));

    $("missing-title").textContent = `Not voted yet (${notVoted.length})`;
    $("unknown-title").textContent = `Voted, not on the list (${notListed.length})`;

    $("missing").replaceChildren(listOf(notVoted.map((n) => el("li", null, n)), "Everyone on the list has voted."));
    $("unknown").replaceChildren(listOf(notListed.map((v) => {
      const li = el("li");
      const label = el("span", null, v.full_name);
      const close = names.find((n) => distance(sortedKey(n), sortedKey(v.full_name)) <= 2);
      if (close) label.append(el("span", "sub", ` (close to ${close})`));
      li.append(label, removeButton(v.full_name, () => removeVoter(v)));
      return li;
    }), "Every voter is on the list."));
  }

  /* ---------- Actions ---------- */

  async function act(fn, args, describe) {
    try {
      const result = await rpc(fn, { p_key: adminKey, ...args });
      toast(describe(result));
    } catch (err) {
      if (err.code === "not_admin") return signOut(MESSAGES.not_admin);
      toast(explain(err), true);
    }
    await load();
  }

  function removeCandidate(c) {
    const votes = c.votes ? ` Their ${c.votes} ${plural(c.votes, "vote", "votes")} will be removed and ${plural(c.votes, "that classmate", "those classmates")} will be able to vote again.` : "";
    if (!window.confirm(`Remove the candidacy of ${c.full_name}?${votes}`)) return;
    act("admin_delete_candidate", { p_candidate: c.id }, (r) =>
      `Removed ${c.full_name}${r.votes_removed ? ` and ${r.votes_removed} ${plural(r.votes_removed, "vote", "votes")}` : ""}.`);
  }

  function removePhoto(c) {
    if (!window.confirm(`Remove the photo of ${c.full_name}? Their candidacy stays on the list.`)) return;
    act("admin_clear_photo", { p_candidate: c.id }, () => `Removed the photo of ${c.full_name}.`);
  }

  function removeVoter(v) {
    const vote = v.ballot_linked
      ? " Their vote will be removed and they will be able to vote again."
      : " This early vote isn’t linked to the name, so it stays counted.";
    if (!window.confirm(`Remove ${v.full_name} from the voter roll?${vote}`)) return;
    act("admin_delete_voter", { p_name_key: v.name_key }, (r) =>
      `Removed ${v.full_name} from the voter roll${r.ballots_removed ? " and their vote" : ""}.`);
  }

  $("gate-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const box = $("gate-error");
    box.hidden = true;
    const key = $("admin-key").value.trim();
    if (!key) {
      box.textContent = "Enter the organiser key.";
      box.hidden = false;
      return;
    }
    const button = $("gate-submit");
    button.disabled = true;
    button.textContent = "Checking…";
    try {
      await rpc("admin_overview", { p_key: key });
      adminKey = key;
      keyStore.set(key, $("remember").checked);
      $("admin-key").value = "";
      openDashboard();
      await load();
      $("overview-title").tabIndex = -1;
      $("overview-title").focus();
    } catch (err) {
      box.textContent = explain(err);
      box.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = "Open";
    }
  });

  let saveTimer;
  $("class-list").addEventListener("input", () => {
    if (data) renderClassCheck();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try { localStorage.setItem(LIST_STORE, $("class-list").value); } catch { /* storage blocked */ }
    }, 400);
  });
  $("refresh").addEventListener("click", () => load());
  $("sign-out").addEventListener("click", () => signOut());

  /* ---------- Boot ---------- */

  try { $("class-list").value = localStorage.getItem(LIST_STORE) || ""; } catch { /* storage blocked */ }
  const saved = keyStore.get();
  if (saved) {
    adminKey = saved;
    load().then((ok) => { if (ok) openDashboard(); });
  }
  setInterval(() => { if (adminKey && !document.hidden) load(); }, REFRESH_MS);
  document.addEventListener("visibilitychange", () => { if (adminKey && !document.hidden) load(); });
})();
