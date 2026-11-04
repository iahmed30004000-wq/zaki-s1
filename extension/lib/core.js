/* منطق الإضافة الصافي: أرقام · خصوصية · قراءة الصفحة بالمحددات · إشارات التوقف · حدود وضع القائمة.
 * ملف واحد بلا تبعيات: بيشتغل بعامل الخلفية (importScripts) وبسكربت المحتوى وبالاختبارات (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.S1 = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
  const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
  const normDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => AR_DIGITS.indexOf(d)).replace(/[۰-۹]/g, (d) => FA_DIGITS.indexOf(d));

  // «1,234 sold» · «12K+» · «1.2万» · «٣٤» ← رقم أو null
  function parseCount(text) {
    if (text === null || text === undefined) return null;
    const s = normDigits(text).replace(/[,،\s]/g, "");
    const m = s.match(/(\d+(?:\.\d+)?)(万|亿|[kKmM])?/);
    if (!m) return null;
    const mult = { 万: 1e4, 亿: 1e8, k: 1e3, K: 1e3, m: 1e6, M: 1e6 }[m[2]] || 1;
    return Math.round(parseFloat(m[1]) * mult);
  }

  const CURRENCY_SYMBOLS = [
    [/US\s?\$|USD|\$/i, "USD"],
    [/€|EUR/i, "EUR"],
    [/£|GBP/i, "GBP"],
    [/JOD|د\.?\s?أ|JD/i, "JOD"],
    [/SAR|ر\.?\s?س/i, "SAR"],
    [/AED|د\.?\s?إ/i, "AED"],
    [/SYP|ل\.?\s?س/i, "SYP"],
    [/CNY|RMB|¥|￥|元/i, "CNY"],
  ];

  // «US $12.50 - 15» · «12,50 €» ← { amount: "12.50", currency: "USD" }
  function parseMoney(text) {
    if (text === null || text === undefined) return null;
    const s = normDigits(text);
    const num = s.match(/\d[\d.,\s]*/);
    if (!num) return null;
    let raw = num[0].replace(/\s/g, "").replace(/[.,]+$/, "");
    if (/,\d{1,2}$/.test(raw) && !/\./.test(raw)) raw = raw.replace(",", ".");
    else raw = raw.replace(/,/g, "");
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    let currency = null;
    for (const [re, code] of CURRENCY_SYMBOLS) {
      if (re.test(s)) {
        currency = code;
        break;
      }
    }
    return { amount: n.toFixed(2), currency };
  }

  // خصوصية: بنشيل الإيميلات وأرقام الهواتف من أي نص قبل الإرسال
  function scrubText(text) {
    return String(text === null || text === undefined ? "" : text)
      .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "")
      .replace(/(?:\+|00)?\d[\d\s().-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 8 ? "" : m))
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // تعليقات النية والتشكيك بتنعدّ هون من القاموس، وبيروح العدد بس (ولا نص ولا أسماء)
  function countComments(texts, lexicon) {
    const lower = (a) => (a || []).map((w) => String(w).toLowerCase()).filter(Boolean);
    const intent = lower(lexicon && lexicon.intent);
    const skeptic = lower(lexicon && lexicon.skeptic);
    let i = 0;
    let k = 0;
    for (const t of texts || []) {
      const s = String(t).toLowerCase();
      if (intent.some((w) => s.includes(w))) i += 1;
      if (skeptic.some((w) => s.includes(w))) k += 1;
    }
    return { intent: i, skeptic: k, sample: (texts || []).length };
  }

  // «https://*.aliexpress.com/item/*» ← regex. النجمة = أي شي بلا فراغ
  function globToRegExp(glob) {
    const esc = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^\\s]*");
    return new RegExp("^" + esc + "$", "i");
  }
  const urlMatches = (url, patterns) => (patterns || []).some((p) => globToRegExp(p).test(url));

  // إشارات التوقف: كابتشا · تحقق · دخول. page = { url, title, text, has(css) }
  function detectStop(page, rules) {
    if (!rules) return null;
    const url = String(page.url || "");
    for (const u of rules.url || []) if (url.toLowerCase().includes(String(u).toLowerCase())) return { kind: "url", match: u };
    for (const c of rules.css || []) {
      try {
        if (page.has(c)) return { kind: "css", match: c };
      } catch (e) {
        /* محدد غلط: بنتجاهله */
      }
    }
    // النص: العنوان + أول 2000 حرف، وبالكلمة الكاملة (عشان «Verified purchase» ما توقف الصفحة)
    const hay = ((page.title || "") + " " + String(page.text || "").slice(0, 2000)).toLowerCase();
    for (const t of rules.text || []) {
      const w = String(t).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (new RegExp("(^|[^\\p{L}])" + w + "([^\\p{L}]|$)", "u").test(hay)) return { kind: "text", match: t };
    }
    return null;
  }

  function readOne(el, spec) {
    const mode = spec.read || "text";
    if (mode === "text") return (el.innerText || el.textContent || "").trim();
    if (mode === "src") return el.currentSrc || el.getAttribute("src") || el.getAttribute("data-src") || "";
    if (mode === "href") return el.href || el.getAttribute("href") || "";
    if (mode === "content") return el.getAttribute("content") || "";
    if (mode.startsWith("attr:")) return el.getAttribute(mode.slice(5)) || "";
    return (el.textContent || "").trim();
  }

  function applyParse(raw, spec) {
    if (raw === "" || raw === null || raw === undefined) return null;
    if (spec.regex) {
      const m = String(raw).match(new RegExp(spec.regex, "i"));
      if (!m) return null;
      raw = m[1] !== undefined ? m[1] : m[0];
    }
    switch (spec.parse) {
      case "money":
        return parseMoney(raw);
      case "int":
        return parseCount(raw);
      case "float": {
        const n = parseFloat(normDigits(raw).replace(/,/g, "."));
        return Number.isFinite(n) ? n : null;
      }
      case "ratio": {
        const n = parseFloat(normDigits(raw));
        return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : null;
      }
      default:
        return String(raw).trim() || null;
    }
  }

  // قراءة حقول صفحة (أو بطاقة) بملف المحددات. root: document أو عنصر
  function extractFields(root, set) {
    const values = {};
    const missing = [];
    for (const [name, spec] of Object.entries((set && set.fields) || {})) {
      let out = null;
      try {
        if (spec.multiple) {
          const items = [...root.querySelectorAll(spec.css)].map((el) => applyParse(readOne(el, spec), spec)).filter((x) => x !== null && x !== "");
          out = items.length ? [...new Set(items.map((x) => (typeof x === "object" ? JSON.stringify(x) : x)))].slice(0, spec.limit || 12) : null;
        } else {
          const el = root.querySelector(spec.css);
          out = el ? applyParse(readOne(el, spec), spec) : null;
        }
      } catch (e) {
        out = null;
      }
      if (out && typeof out === "object" && !Array.isArray(out) && "amount" in out) {
        values[name] = out.amount;
        if (out.currency && !values.currency) values.currency = out.currency;
      } else if (out !== null) values[name] = out;
      else missing.push(name);
    }
    const requiredMissing = ((set && set.required) || []).filter((r) => values[r] === undefined || values[r] === null || values[r] === "");
    return { values, missing, requiredMissing };
  }

  // صفحات قوائم: كل بطاقة بحقولها (حتى max بطاقة)
  function extractList(doc, set) {
    const list = set && set.list;
    if (!list) return [];
    const cards = [...doc.querySelectorAll(list.item)].slice(0, list.max || 20);
    return cards.map((card) => Object.assign(extractFields(card, { fields: list.fields, required: list.required }), { text: scrubText((card.innerText || "").slice(0, 1500)) }));
  }

  // ───── حدود وضع القائمة (docs/02-plan.md الجزء العاشر قسم 4) ─────
  const DEFAULT_LIMITS = { minDelayMs: 45000, maxDelayMs: 90000, perHour: 40, perDay: 200, breakEvery: 20, breakMs: 600000, maxFailures: 3 };
  const HOUR = 3600000;
  const DAY = 86400000;
  const newQueueState = () => ({ history: [], sinceBreak: 0, failures: 0, breakUntil: 0, stopped: null });

  const nextDelay = (limits = DEFAULT_LIMITS, rand = Math.random) => Math.round(limits.minDelayMs + rand() * (limits.maxDelayMs - limits.minDelayMs));

  // ممكن أفتح الصفحة الجاية هلأ؟ وإلا كم بستنى ولشو
  function canProceed(state, now, limits = DEFAULT_LIMITS) {
    if (state.stopped) return { ok: false, reason: "stopped", waitMs: null };
    if (state.failures >= limits.maxFailures) return { ok: false, reason: "failures", waitMs: null };
    if (state.breakUntil > now) return { ok: false, reason: "break", waitMs: state.breakUntil - now };
    const inHour = state.history.filter((t) => now - t < HOUR).sort((a, b) => a - b);
    if (inHour.length >= limits.perHour) return { ok: false, reason: "hour", waitMs: inHour[inHour.length - limits.perHour] + HOUR - now };
    const inDay = state.history.filter((t) => now - t < DAY).sort((a, b) => a - b);
    if (inDay.length >= limits.perDay) return { ok: false, reason: "day", waitMs: inDay[inDay.length - limits.perDay] + DAY - now };
    return { ok: true, waitMs: 0 };
  }
  function recordSuccess(state, now, limits = DEFAULT_LIMITS) {
    state.history = state.history.filter((t) => now - t < DAY).concat(now);
    state.failures = 0;
    state.sinceBreak += 1;
    if (state.sinceBreak >= limits.breakEvery) {
      state.sinceBreak = 0;
      state.breakUntil = now + limits.breakMs;
    }
    return state;
  }
  const recordFailure = (state) => {
    state.failures += 1;
    return state;
  };
  const recordStop = (state, reason) => {
    state.stopped = reason || "stop";
    return state;
  };

  // الوقت المتوقع (بالمللي ثانية) لعدد صفحات: محاكاة بمتوسط التأخير مع كل الحدود
  function estimateMs(n, limits = DEFAULT_LIMITS, startHistory = []) {
    const st = Object.assign(newQueueState(), { history: [...startHistory] });
    const avg = (limits.minDelayMs + limits.maxDelayMs) / 2;
    let now = 0;
    for (let i = 0; i < n; i++) {
      for (let guard = 0; guard < 1000; guard++) {
        const c = canProceed(st, now, limits);
        if (c.ok) break;
        if (c.waitMs === null) return Infinity;
        now += c.waitMs + 1;
      }
      recordSuccess(st, now, limits);
      now += avg;
    }
    return Math.round(now);
  }

  return { parseCount, parseMoney, scrubText, countComments, globToRegExp, urlMatches, detectStop, extractFields, extractList, DEFAULT_LIMITS, newQueueState, nextDelay, canProceed, recordSuccess, recordFailure, recordStop, estimateMs };
});
