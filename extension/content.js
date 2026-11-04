/* سكربت المحتوى: بيقرأ الصفحة بالمحددات، وبيعرض الزر العائم واللوحة الجانبية، وبيوقف عند أي إشارة تحقق.
 * ما بيتصفّح بالخلفية ولا بيحل كابتشا: بيشتغل بس على الصفحة المفتوحة بإيدك أو بضغطة زر، أو بوضع القائمة بحدوده. */
(function () {
  "use strict";
  if (window.__s1) return;
  const S1 = self.S1;
  const A = self.S1Adapters.adapters;
  let site = null; // { id, set, lexicon, config }
  let host = null;

  const send = (msg) => new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError ? chrome.runtime.lastError.message : "no reply" })));

  function pageInfo() {
    return { url: location.href, title: document.title, text: document.body ? document.body.innerText : "", has: (css) => !!document.querySelector(css) };
  }

  // يقرأ الصفحة: stop | { ok, items:[...] }. items = مرشحات جاهزة للإرسال بصيغة الخادم
  function run(set, adapterId, lexicon, opts) {
    const stop = S1.detectStop(pageInfo(), set.stop);
    if (stop) return { stop };
    const adapter = A[adapterId];
    const bodyText = S1.scrubText(document.body ? document.body.innerText : "").slice(0, 12000);
    const items = [];
    let lists = [];
    if (set.list && adapterId === "meta_adlib" && !/\/ads\/library\/\?id=/.test(location.href) && !(opts && opts.single)) lists = S1.extractList(document, set);
    const sources = lists.length ? lists.map((l) => ({ ex: l, text: l.text })) : [{ ex: S1.extractFields(document, set), text: bodyText }];
    for (const { ex, text } of sources) {
      const values = adapter ? adapter.post(ex.values, { text }) : ex.values;
      const item = { fields: values, missing: ex.missing, requiredMissing: ex.requiredMissing };
      if (ex.requiredMissing.length) item.pageText = text; // الاستخراج الاحتياطي على الخادم (بلا قسم التعليقات)
      items.push(item);
    }
    const out = { ok: true, items, url: location.href };
    if (set.comments) {
      const texts = [...document.querySelectorAll(set.comments)].map((e) => e.innerText || "").slice(0, 300);
      out.counts = S1.countComments(texts, lexicon); // العدد بس بيروح، ولا نص ولا أسماء
    }
    return out;
  }
  window.__s1 = { run };

  // ───── الواجهة: زر عائم + لوحة جانبية بظل معزول ─────
  function ui() {
    if (host) return host.shadowRoot;
    host = document.createElement("div");
    host.id = "s1-host";
    host.style.cssText = "position:fixed;z-index:2147483647;inset:auto auto 16px 16px;direction:rtl;font:14px system-ui,Segoe UI,Tahoma,sans-serif";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML =
      '<style>button{cursor:pointer;border:0;border-radius:10px;padding:10px 14px;font:inherit}.fab{background:#4f46e5;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25)}' +
      '.panel{width:320px;max-height:70vh;overflow:auto;background:#fff;color:#111;border-radius:12px;padding:14px;box-shadow:0 8px 30px rgba(0,0,0,.3);margin-bottom:8px}' +
      '.bar{background:#b91c1c;color:#fff;padding:10px 14px;border-radius:10px;margin-bottom:8px;max-width:320px}.bar.info{background:#1d4ed8}' +
      'table{width:100%;border-collapse:collapse;font-size:12px}td{border-bottom:1px solid #e5e7eb;padding:4px;vertical-align:top;word-break:break-word}' +
      'select,input{width:100%;box-sizing:border-box;padding:6px;margin:4px 0;font:inherit}.ok{background:#16a34a;color:#fff}.muted{color:#6b7280;font-size:12px}</style>' +
      '<div id="bars"></div><div id="panel" hidden></div><button class="fab" id="fab">احفظ كمرشح</button>';
    document.documentElement.appendChild(host);
    root.getElementById("fab").addEventListener("click", openPanel);
    return root;
  }
  const bar = (text, cls) => {
    const b = document.createElement("div");
    b.className = "bar " + (cls || "");
    b.textContent = text;
    ui().getElementById("bars").appendChild(b);
  };
  const esc = (s) => String(s === null || s === undefined ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  async function openPanel() {
    const root = ui();
    const panel = root.getElementById("panel");
    panel.hidden = false;
    panel.innerHTML = "<p>عم أقرا الصفحة...</p>";
    const r = run(site.set, site.id, site.lexicon, { single: true });
    if (r.stop) return showStop(r.stop);
    const first = r.items[0];
    const rows = Object.entries(first.fields).map(([k, v]) => "<tr><td>" + esc(k) + "</td><td dir='auto'>" + esc(Array.isArray(v) ? v.join(" ، ") : v) + "</td></tr>").join("");
    const missing = first.requiredMissing.length ? "<p class='muted'>ناقص: " + esc(first.requiredMissing.join("، ")) + " — رح تنبعت نص الصفحة والخادم بيستخرجها.</p>" : "";
    const market = (site.config.market || "SY").toUpperCase();
    panel.innerHTML =
      "<b>معاينة قبل الإرسال</b><table>" + rows + "</table>" + missing +
      "<label>السوق<select id='mk'><option value='SY'>سوريا</option><option value='JO'>الأردن</option></select></label>" +
      "<label>ملاحظة (اختياري)<input id='nt' maxlength='300'></label>" +
      "<button class='ok' id='go'>ابعت</button> <button id='cl'>إغلاق</button><p class='muted' id='msg'></p>";
    root.getElementById("mk").value = market;
    root.getElementById("cl").onclick = () => (panel.hidden = true);
    root.getElementById("go").onclick = async () => {
      root.getElementById("msg").textContent = "عم ببعت...";
      const res = await send({ type: "capture", site: site.id, url: location.href, market: root.getElementById("mk").value, note: root.getElementById("nt").value, items: r.items, counts: r.counts || null });
      root.getElementById("msg").textContent = res.ok ? "انحفظ كمرشح ✓" : "ما انحفظ: " + (res.error || "خطأ");
    };
  }

  async function showStop(stop) {
    ui();
    bar("وقفت: الصفحة طالبة تحقق. حلّها بإيدك، وبعدين كبس استئناف من نافذة الإضافة.");
    await send({ type: "stopped", site: site ? site.id : "unknown", url: location.href, reason: stop.kind + ":" + stop.match });
  }

  async function init() {
    const info = await send({ type: "get-site", url: location.href });
    if (!info || !info.ok || !info.site) return;
    site = info.site;
    const stop = S1.detectStop(pageInfo(), site.set.stop);
    if (stop) return showStop(stop);
    ui();
    if (info.updateAvailable) bar("في نسخة جديدة من الإضافة — نزّلها من النظام", "info");
    if (!info.connected) bar("الإضافة مش متصلة بالنظام: افتح الخيارات وحط التوكن.", "info");
  }
  init();
})();
