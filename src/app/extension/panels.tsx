"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";

const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await res.json().catch(() => null);
  return { ok: res.ok, data: d, message: res.ok ? "تمّ" : (d?.error?.message ?? "صار خطأ") };
};

// «جهاز جديد»: التوكن بيظهر مرة وحدة، بعدها الخادم ما بيعرفه (بصمة بس)
export function NewDevice() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [msg, setMsg] = useState("");
  async function create() {
    setMsg("...");
    const r = await call("POST", "/api/extension/devices", { name });
    setMsg(r.ok ? "" : r.message);
    if (r.ok) {
      setToken(r.data.token);
      setName("");
      router.refresh();
    }
  }
  return (
    <fieldset>
      <legend>جهاز جديد</legend>
      <div className="row">
        <input aria-label="اسم الجهاز" placeholder="اسم الجهاز (مثلاً: لابتوب المكتب)" value={name} onChange={(e) => setName(e.target.value)} />
        <button type="button" onClick={create}>أنشئ</button>
        <span className="muted" aria-live="polite">{msg}</span>
      </div>
      {token && (
        <div role="alert" data-testid="new-token">
          <p><strong>انسخ التوكن هلأ: ما بيظهر مرة تانية.</strong></p>
          <input readOnly dir="ltr" value={token} aria-label="التوكن" onFocus={(e) => e.currentTarget.select()} size={60} />
          <p className="muted">الصقه بخيارات الإضافة ← «اتصل». لو ضاع، ألغِ الجهاز واعمل واحد جديد.</p>
        </div>
      )}
    </fieldset>
  );
}

export function RevokeButton({ id }: { id: string }) {
  const router = useRouter();
  return (
    <button type="button" onClick={async () => { if (confirm("بدك تلغي هالجهاز؟ التوكن بيوقف فوراً.")) { await call("DELETE", `/api/extension/devices/${id}`); router.refresh(); } }}>
      ألغِ
    </button>
  );
}

// نشر نسخة محددات جديدة (JSON): بتصير الفعّالة، والإضافات بتاخدها بدون إعادة تثبيت
export function PublishSelectors({ sample }: { sample: string }) {
  const router = useRouter();
  const [text, setText] = useState(sample);
  const [msg, setMsg] = useState("");
  async function publish() {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return setMsg("الـ JSON فيه غلط بالكتابة");
    }
    setMsg("...");
    const r = await call("POST", "/api/extension/selectors/admin", body);
    setMsg(r.ok ? `اننشرت النسخة ${r.data.version} لـ${r.data.site}` : r.message);
    if (r.ok) router.refresh();
  }
  return (
    <div>
      <textarea aria-label="ملف المحددات (JSON)" dir="ltr" rows={14} cols={80} value={text} onChange={(e) => setText(e.target.value)} />
      <p className="row"><button type="button" onClick={publish}>انشر كنسخة جديدة</button><span className="muted" aria-live="polite" data-testid="publish-msg">{msg}</span></p>
    </div>
  );
}

export function ActivateButton({ site, version }: { site: string; version: number }) {
  const router = useRouter();
  return (
    <button type="button" onClick={async () => { await call("PATCH", "/api/extension/selectors/admin", { site, version }); router.refresh(); }}>
      فعّل هالنسخة
    </button>
  );
}
