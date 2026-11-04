(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const send = (m) => new Promise((r) => chrome.runtime.sendMessage(m, (x) => r(x || { ok: false })));
  const fmt = (ms) => {
    if (!Number.isFinite(ms)) return "غير محدد";
    const m = Math.round(ms / 60000);
    return m < 60 ? m + " دقيقة" : Math.floor(m / 60) + " ساعة و" + (m % 60) + " دقيقة";
  };

  function bar(text, cls) {
    const d = document.createElement("div");
    d.className = "bar " + (cls || "");
    d.textContent = text;
    $("bars").appendChild(d);
  }

  async function render() {
    $("bars").innerHTML = "";
    const s = await send({ type: "status" });
    if (!s.ok) return bar("خطأ بقراءة الحالة");
    const q = s.q;
    const state = $("state");
    if (!s.config.connected) {
      state.textContent = "مش متصلة";
      state.className = "tag stop";
      bar("افتح الخيارات وحط رابط النظام وتوكن الجهاز.", "info");
    } else if (q.stopped) {
      state.textContent = "وقف بتحقق";
      state.className = "tag stop";
      bar(q.stopped);
    } else if (q.paused) {
      state.textContent = "موقوفة مؤقتاً";
      state.className = "tag pause";
    } else {
      state.textContent = q.running ? "شغّالة" : "متصلة";
      state.className = "tag ok";
    }
    if (s.updateAvailable) bar("في نسخة جديدة من الإضافة — نزّلها من النظام", "info");
    $("today").textContent = "لقطات اليوم: " + s.today;
    $("queueBox").hidden = !(q.running || q.stopped || q.urls.length);
    $("prog").max = Math.max(q.urls.length, 1);
    $("prog").value = q.index;
    $("qtext").textContent = q.index + " من " + q.urls.length + (q.waiting ? " — بستنى (" + ({ hour: "الحد الساعي", day: "الحد اليومي", break: "استراحة" }[q.waiting] || q.waiting) + ")" : "");
    $("open").onclick = () => s.config.systemUrl && chrome.tabs.create({ url: s.config.systemUrl + "/extension" });
  }

  $("opts").onclick = () => chrome.runtime.openOptionsPage();
  $("pause").onclick = async () => (await send({ type: "queue-control", action: "pause" }), render());
  $("resume").onclick = async () => (await send({ type: "queue-control", action: "resume" }), render());
  $("cancel").onclick = async () => (await send({ type: "queue-control", action: "cancel" }), render());
  $("urls").addEventListener("input", () => {
    const n = $("urls").value.split(/\s+/).filter(Boolean).length;
    $("estimate").textContent = n ? n + " رابط — الوقت المتوقع حسب الحدود: " + fmt(self.S1.estimateMs(n)) : "";
  });
  $("start").onclick = async () => {
    const r = await send({ type: "queue-start", urls: $("urls").value.split(/\s+/) });
    if (!r.ok) bar(r.error || "ما بدأت");
    else $("urls").value = "";
    render();
  };
  render();
  setInterval(render, 5000);
})();
