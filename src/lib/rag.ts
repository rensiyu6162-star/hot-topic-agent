// 本地零成本 RAG 检索客户端：embedding 粗召回 + reranker 精排，全部跑在内网 CPU 容器。
// hot-web 以 --network host 运行，默认直连宿主机 127.0.0.1:8091。
// 任何失败一律静默降级（知识库是增强项，绝不能拖垮主链路）。

const RAG_URL = process.env.RAG_URL || "http://127.0.0.1:8091";
const DEFAULT_TIMEOUT_MS = 45000;

// 知识库语料的十个领域（与建库 meta.category 完全一致，用于精确过滤）
export const KB_CATEGORIES = [
  "法制普法", "历史文化", "情感两性", "科技互联网", "财经理财",
  "职场成长", "影视娱乐", "社会热点", "健康养生", "育儿教育",
] as const;

export interface RagHit {
  text: string;
  score: number;
  dense_score?: number;
  meta?: {
    category?: string;
    doc_id?: string;
    chunk?: number;
    source?: string;
    [k: string]: unknown;
  };
}

export interface RetrieveOptions {
  topK?: number;
  minScore?: number;
  category?: string;
  timeoutMs?: number;
}

export async function retrieveKnowledge(
  query: string,
  opts: RetrieveOptions = {}
): Promise<RagHit[]> {
  const q = query.trim();
  if (q.length < 4) return []; // 太短的查询（"你好"）不检索
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(`${RAG_URL}/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: q,
        top_k: opts.topK ?? 4,
        rerank: true,
        category: opts.category ?? null,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: RagHit[] };
    const min = opts.minScore ?? 0.3;
    return (data.results ?? []).filter((r) => typeof r.score === "number" && r.score >= min);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// 拼成给 LLM 的参考块。定位：真实爆款口播稿语料——学钩子/节奏/结构，不抄内容。
export function formatKnowledge(hits: RagHit[]): string {
  if (!hits.length) return "";
  const blocks = hits.map((h, i) => {
    const cat = h.meta?.category ? `（领域：${h.meta.category}）` : "";
    return `【参考文稿${i + 1}】${cat}\n${h.text}`;
  });
  return (
    `【知识库参考·真实爆款口播稿语料】下面是知识库中与本轮需求语义最相关的 ${hits.length} 段真实高表现口播文稿（已按相关度排序）。` +
    `你可以借鉴它们的开头钩子、信息节奏、互动话术和结构安排，但【严禁】整句照抄或复述原文情节，` +
    `必须结合用户本轮的具体主题重新创作；若文稿内容与用户主题无关则忽略。\n\n${blocks.join("\n\n---\n\n")}`
  );
}
