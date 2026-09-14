// 历史热点自动沉淀：定时抓取/分析产出的内容，切片后写入本地 RAG 知识库。
// 由 scheduler 在一次定时任务成功后调用；任何失败静默，不影响主任务。

const RAG_URL = process.env.RAG_URL || "http://127.0.0.1:8091";
const CHUNK = 500;

export interface IngestDoc {
  title: string;
  body: string;            // 分析/成稿正文
  category?: string;       // 领域（自由文本，命中文库十类时可过滤）
  url?: string;
  platforms?: string[];
  date?: string;           // YYYY-MM-DD
  docId?: string;          // 幂等用（如 同步码:日期:标题hash）
}

function splitBody(text: string): string[] {
  const t = text.trim();
  if (t.length <= CHUNK) return t ? [t] : [];
  const parts: string[] = [];
  let start = 0;
  while (start < t.length) {
    let end = Math.min(start + CHUNK, t.length);
    if (end < t.length) {
      const w = t.slice(start, end);
      const cut = Math.max(w.lastIndexOf("\n"), w.lastIndexOf("。"), w.lastIndexOf("！"), w.lastIndexOf("？"));
      if (cut > CHUNK * 0.5) end = start + cut + 1;
    }
    parts.push(t.slice(start, end).trim());
    start = end;
  }
  return parts.filter((p) => p.length >= 20);
}

export async function ingestHotDocs(docs: IngestDoc[]): Promise<number> {
  const items: { text: string; meta: Record<string, unknown> }[] = [];
  for (const d of docs) {
    const chunks = splitBody(`${d.title}\n${d.body}`);
    chunks.forEach((text, i) => {
      items.push({
        text,
        meta: {
          source: "hot-history",
          doc_id: d.docId ?? d.url ?? d.title,
          title: d.title,
          chunk: i,
          ...(d.category ? { category: d.category } : {}),
          ...(d.url ? { url: d.url } : {}),
          ...(d.platforms?.length ? { platforms: d.platforms } : {}),
          ...(d.date ? { date: d.date } : {}),
        },
      });
    });
  }
  if (!items.length) return 0;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60000);
    const res = await fetch(`${RAG_URL}/add`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return 0;
    const data = (await res.json()) as { added?: number };
    return data.added ?? items.length;
  } catch {
    return 0;
  }
}
