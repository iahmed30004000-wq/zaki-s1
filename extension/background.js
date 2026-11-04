/* عامل الخلفية: الاتصال بالنظام · المحددات عن بُعد · وضع القائمة بالحدود · التحديث.
 * ما في تصفّح بالخلفية: وضع القائمة بيفتح بس الروابط اللي حطيتها إنت، تبويب واحد، بسرعة إنسان، وبيوقف عند أي تحقق. */
importScripts("lib/core.js", "lib/adapters.js");
const S1 = self.S1;
const BUNDLED = ["aliexpress", "meta_adlib"];
const VERSION = chrome.runtime.getManifest().version;

// ───── التخزين ─────
const store = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
};
async function config() {
  const { cfg } = await store.get("cfg");
  return Object.assign({ systemUrl: "", token: "", market: "SY", connected: false, limits: S1.DEFAULT_LIMITS }, cfg || {});
}
const saveConfig = async (patch) => store.set({ cfg: Object.assign(await config(), patch) });

// ───── مكالمات النظام (توكن الجهاز بكل نداء) ─────
async function api(path, init = {}) {
  const c = await config();
  if (!c.systemUrl || !c.token) throw new Error("الإضافة مش متصلة: افتح الخيارات");
  const res = await fetch(c.systemUrl.replace(/\/+$/, "") + path, Object.assign({}, init, { headers: Object.assign({ authorization: "Bearer " + c.token, "content-type": "application/json" }, init.headers || {}) }));
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error && body.error.message) || "خطأ " + res.status);
  return body;
}

// ───── المحددات: النسخة البعيدة أول، والمرفقة احتياطي (وبتشتغل حتى بلا اتصال) ─────
async function bundled(id) {
  const res = await fetch(chrome.runtime.getURL("selectors/" + id + ".json"));
  return res.json();
}
async function selectorSets() {
  const { remote } = await store.get("remote");
  const out = {};
  for (const id of BUNDLED) out[id] = (remote && remote[id]) || (await bundled(id));
  return out;
}
async function refreshSelectors() {
  const known = Object.fromEntries(Object.entries((await store.get("remote")).remote || {}).map(([k, v]) => [k, v.version]));
  const r = await api("/api/extension/selectors?known=" + encodeURIComponent(JSON.stringify(known)));
  const remote = Object.assign({}, (await store.get("remote")).remote || {});
  for (const s of r.sets) remote[s.site] = Object.assign({}, s.selectors, { site: s.site, version: s.version });
  await store.set({ remote, selectorsAt: Date.now() });
  const lex = await api("/api/extension/lexicon");
  await store.set({ lexicon: lex });
  const v = await api("/api/extension/version");
  await store.set({ updateAvailable: compareVersions(v.version, VERSION) > 0, latest: v });
  return { sets: r.sets.length, version: v.version };
}
const compareVersions = (a, b) => {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
};

async function siteFor(url) {
  const sets = await selectorSets();
  for (const [id, set] of Object.entries(sets)) if (S1.urlMatches(url, set.match)) return { id, set };
  return null;
}

// ───── الإرسال ─────
async function sendCapture(msg) {
  const c = await config();
  const body = { site: msg.site, url: msg.url, market: msg.market || c.market, note: msg.note || undefined, mode: msg.mode || "single", counts: msg.counts || undefined, items: msg.items.map((i) => ({ fields: i.fields, missing: i.missing, pageText: i.pageText })) };
  const res = await api("/api/extension/captures", { method: "POST", body: JSON.stringify(body) });
  const { today } = await store.get("today");
  const day = new Date().toISOString().slice(0, 10);
  await store.set({ today: { day, n: ((today && today.day === day ? today.n : 0) || 0) + (res.saved || 0) } });
  return res;
}
const reportEvent = (type, site, url, reason) => api("/api/extension/events", { method: "POST", body: JSON.stringify({ type, site, url, reason }) }).catch(() => null);

// ───── وضع القائمة ─────
async function queue() {
  const { q } = await store.get("q");
  return q || { urls: [], index: 0, running: false, paused: false, stopped: null, log: [], state: S1.newQueueState(), tabId: null };
}
const saveQueue = (q) => store.set({ q });

async function startQueue(rawUrls) {
  const sets = await selectorSets();
  const urls = [...new Set(rawUrls.map((u) => u.trim()).filter(Boolean))].filter((u) => Object.values(sets).some((s) => S1.urlMatches(u, s.match)));
  if (!urls.length) return { ok: false, error: "ما في روابط من المواقع المدعومة" };
  const prev = await queue();
  const q = { urls: urls.slice(0, 200), index: 0, running: true, paused: false, stopped: null, log: [], state: Object.assign(S1.newQueueState(), { history: prev.state ? prev.state.history : [] }), tabId: null };
  await saveQueue(q);
  await chrome.alarms.create("s1-tick", { when: Date.now() + 1500 });
  return { ok: true, count: q.urls.length };
}

async function tick() {
  const q = await queue();
  const c = await config();
  if (!q.running || q.paused || q.stopped) return;
  if (q.index >= q.urls.length) {
    q.running = false;
    await saveQueue(q);
    return;
  }
  const gate = S1.canProceed(q.state, Date.now(), c.limits);
  if (!gate.ok) {
    if (gate.waitMs === null) {
      q.stopped = gate.reason === "failures" ? "المحددات بدها تحديث" : "موقوف";
      q.running = false;
      await saveQueue(q);
      await reportEvent("selectors_stale", "queue", q.urls[q.index], "3 فشل متتالي");
    } else {
      await chrome.alarms.create("s1-tick", { when: Date.now() + gate.waitMs + 1000 });
      q.waiting = gate.reason;
      await saveQueue(q);
    }
    return;
  }
  q.waiting = null;
  const url = q.urls[q.index];
  const found = await siteFor(url);
  let outcome = "failed";
  let detail = "";
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url, active: false }); // تبويب واحد بكل مرة
    tabId = tab.id;
    await waitForLoad(tabId);
    await new Promise((r) => setTimeout(r, 4000 + Math.random() * 3000)); // سرعة إنسان: وقت للصفحة تكمل
    const lexicon = (await store.get("lexicon")).lexicon || {};
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: (set, id, lex) => (window.__s1 ? window.__s1.run(set, id, lex) : { error: "content" }), args: [found.set, found.id, lexicon] });
    if (!result || result.error) throw new Error("الصفحة ما حمّلت سكربت الإضافة");
    if (result.stop) {
      outcome = "stop";
      detail = result.stop.kind + ":" + result.stop.match;
    } else if (result.items.every((i) => i.requiredMissing.length && !i.pageText)) {
      detail = "حقول ناقصة";
    } else {
      await sendCapture({ site: found.id, url, items: result.items, counts: result.counts, mode: "queue" });
      outcome = "ok";
    }
  } catch (e) {
    detail = String((e && e.message) || e);
  }
  if (tabId !== null) chrome.tabs.remove(tabId).catch(() => null);
  const fresh = await queue();
  fresh.log.push({ url, outcome, detail, at: Date.now() });
  fresh.log = fresh.log.slice(-200);
  if (outcome === "ok") {
    S1.recordSuccess(fresh.state, Date.now(), c.limits);
    fresh.index += 1;
  } else if (outcome === "stop") {
    S1.recordStop(fresh.state, detail);
    fresh.stopped = "وقفت: الصفحة طالبة تحقق. حلّها بإيدك، وبعدين كبس استئناف.";
    fresh.running = false;
    await reportEvent("stopped", found ? found.id : "unknown", url, detail);
  } else {
    S1.recordFailure(fresh.state);
    fresh.index += 1; // ما بنعيد نفس الصفحة بسرعة
  }
  await saveQueue(fresh);
  if (fresh.running && !fresh.stopped) await chrome.alarms.create("s1-tick", { when: Date.now() + S1.nextDelay(c.limits) });
  else if (fresh.stopped === null && fresh.state.failures >= c.limits.maxFailures) await tick();
}

function waitForLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(on);
      reject(new Error("الصفحة تأخرت"));
    }, 45000);
    function on(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(on);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(on);
  });
}

async function control(action) {
  const q = await queue();
  if (action === "pause") q.paused = true;
  if (action === "resume") {
    q.paused = false;
    if (q.stopped) {
      q.stopped = null;
      q.state.stopped = null;
      q.state.failures = 0;
      q.running = q.index < q.urls.length;
    }
    await chrome.alarms.create("s1-tick", { when: Date.now() + 1500 });
  }
  if (action === "cancel") {
    q.running = false;
    q.urls = [];
    q.index = 0;
    q.stopped = null;
    await chrome.alarms.clear("s1-tick");
  }
  await saveQueue(q);
  return q;
}

// ───── الرسائل ─────
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    try {
      if (msg.type === "get-site") {
        const c = await config();
        const s = await siteFor(msg.url);
        const st = await store.get(["lexicon", "updateAvailable"]);
        return reply({ ok: true, site: s ? { id: s.id, set: s.set, lexicon: st.lexicon || {}, config: { market: c.market } } : null, connected: c.connected, updateAvailable: !!st.updateAvailable });
      }
      if (msg.type === "capture") return reply(Object.assign({ ok: true }, await sendCapture(msg)));
      if (msg.type === "stopped") {
        await reportEvent("stopped", msg.site, msg.url, msg.reason);
        const q = await queue();
        if (q.running) {
          q.stopped = "وقفت: الصفحة طالبة تحقق. حلّها بإيدك، وبعدين كبس استئناف.";
          q.running = false;
          await saveQueue(q);
        }
        return reply({ ok: true });
      }
      if (msg.type === "connect") {
        await saveConfig({ systemUrl: msg.systemUrl, token: msg.token, market: msg.market || "SY", connected: false });
        const r = await api("/api/extension/ping");
        await saveConfig({ connected: true });
        await refreshSelectors();
        return reply({ ok: true, device: r.device });
      }
      if (msg.type === "refresh") return reply(Object.assign({ ok: true }, await refreshSelectors()));
      if (msg.type === "queue-start") return reply(await startQueue(msg.urls || []));
      if (msg.type === "queue-control") return reply({ ok: true, q: await control(msg.action) });
      if (msg.type === "status") {
        const st = await store.get(["today", "updateAvailable", "latest", "selectorsAt"]);
        const day = new Date().toISOString().slice(0, 10);
        return reply({ ok: true, config: Object.assign({}, await config(), { token: undefined }), q: await queue(), today: st.today && st.today.day === day ? st.today.n : 0, updateAvailable: !!st.updateAvailable, latest: st.latest || null, selectorsAt: st.selectorsAt || null });
      }
      reply({ ok: false, error: "رسالة مجهولة" });
    } catch (e) {
      reply({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "s1-tick") tick();
  if (a.name === "s1-refresh") refreshSelectors().catch(() => null);
});
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("s1-refresh", { periodInMinutes: 360 }));
chrome.runtime.onStartup.addListener(() => refreshSelectors().catch(() => null));
