(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => r(x || { ok: false, error: "ما في رد" })));
  const say = (t, ok) => {
    $("msg").textContent = t;
    $("msg").style.color = ok ? "#166534" : "#991b1b";
  };

  send({ type: "status" }).then((s) => {
    if (!s.ok) return;
    $("url").value = s.config.systemUrl || "";
    $("market").value = s.config.market || "SY";
    if (!s.config.systemUrl) fetch(chrome.runtime.getURL("defaults.json")).then((r) => r.json()).then((d) => d.systemUrl && ($("url").value = d.systemUrl)).catch(() => null);
    if (s.config.connected) say("متصل ✓", true);
  });

  $("connect").onclick = async () => {
    say("عم أتصل...", true);
    const r = await send({ type: "connect", systemUrl: $("url").value.trim(), token: $("token").value.trim(), market: $("market").value });
    if (r.ok) {
      $("token").value = "";
      say("متصل ✓ — الجهاز: " + (r.device || ""), true);
    } else say("ما اتصلت: " + (r.error || "خطأ"));
  };
  $("refresh").onclick = async () => {
    const r = await send({ type: "refresh" });
    say(r.ok ? "انحدّثت المحددات (" + r.sets + " موقع) — نسخة الإضافة الأحدث: " + r.version : "ما انحدّثت: " + (r.error || "خطأ"), r.ok);
  };
})();
