/* المحوّلات: علي إكسبرس ومكتبة إعلانات ميتا. المحدد (CSS) بييجي من ملف المحددات عن بُعد، والمحوّل بيكمّل بتعابير النص.
 * باقي المواقع (تيمو · شي إن · أمازون ...) بتنضاف بمهمة B14 بنفس الشكل: ملف محددات + دالة post هون. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.S1Adapters = factory();
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  const pad = (n) => String(n).padStart(2, "0");

  // «Started running on 12 Oct 2025» · «Oct 12, 2025» · «2025-10-12» ← YYYY-MM-DD
  function parseAdDate(text) {
    const s = String(text || "");
    let m = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})/);
    if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
    m = s.match(/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS[m[1].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[1].toLowerCase()])}-${pad(m[2])}`;
    return null;
  }

  const FORMATS = [
    [/\bcarousel\b|شرائح/i, "carousel"],
    [/\bvideo\b|فيديو|0:\d\d\s*\/\s*\d+:\d\d/i, "video"],
    [/\bimage\b|صورة/i, "image"],
  ];

  const adapters = {
    aliexpress: {
      site: "aliexpress",
      label: "علي إكسبرس",
      post(values) {
        const out = Object.assign({}, values);
        if (Array.isArray(out.imageUrl)) out.imageUrl = out.imageUrl[0] || null;
        return out;
      },
    },
    meta_adlib: {
      site: "meta_adlib",
      label: "مكتبة إعلانات ميتا",
      // text = نص البطاقة أو الصفحة (بلا قسم تعليقات: المكتبة ما فيها)
      post(values, ctx) {
        const text = String((ctx && ctx.text) || "");
        const out = Object.assign({}, values);
        if (Array.isArray(out.imageUrl)) out.imageUrl = out.imageUrl[0] || null;
        const started = text.match(/(?:Started running on|بدأ عرضه في|بدأ العرض في)\s*([^\n·|]+)/i);
        out.adStartDate = parseAdDate(started ? started[1] : text);
        const versions = text.match(/(\d+)\s+ads?\s+use\s+this\s+creative|يستخدم\s+(\d+)\s+إعلان/i);
        out.adVersions = versions ? Number(versions[1] || versions[2]) : /multiple versions/i.test(text) ? null : 1;
        const countries = text.match(/(?:Shown in|Countries|يُعرض في|الدول)\s*:?\s*([A-Za-z؀-ۿ ,]+)/i);
        out.adCountries = countries ? countries[1].split(/[,،]/).map((c) => c.trim()).filter(Boolean).slice(0, 30) : null;
        out.format = null;
        for (const [re, name] of FORMATS) {
          if (re.test(text)) {
            out.format = name;
            break;
          }
        }
        return out;
      },
    },
  };

  return { adapters, parseAdDate };
});
