// 爆款口播模板库的共享读取/挑选逻辑。
// 模板由 collector/analyze_scripts.py 从真实高播放口播文稿拆解而来，
// 并由该脚本自动同步到 api/chat/templates.json（路径写死在 analyze_scripts.py 里，勿移动该 json）。
// 之前这套逻辑只存在于 api/chat/route.ts 内部，导致 api/script（弹窗里"生成脚本/润色梗概"
// 真正调用的那个路由）完全没用上这 461 条模板。抽到这里供两个路由共用。
import scriptTemplates from "../chat/templates.json";

export type ScriptTemplate = {
  id: string;
  领域: string;
  选题角度: string;
  开头钩子: string;
  结构脉络: string[];
  金句话术: string[];
  结尾CTA: string;
  情绪基调: string;
  可复用套路: string;
  原文摘录?: string;
};

// 按领域分组，模块加载时建一次索引。
const TEMPLATES_BY_DOMAIN: Record<string, ScriptTemplate[]> = (() => {
  const map: Record<string, ScriptTemplate[]> = {};
  for (const t of scriptTemplates as ScriptTemplate[]) {
    const d = (t.领域 || "").trim();
    if (!d) continue;
    (map[d] ||= []).push(t);
  }
  return map;
})();

// 把模板渲染成 prompt 里的参考样例文本
export function renderTemplates(list: ScriptTemplate[]): string {
  return list
    .map((t, i) => {
      const 脉络 = (t.结构脉络 || []).map((s) => `    - ${s}`).join("\n");
      const 金句 = (t.金句话术 || []).map((s) => `「${s}」`).join(" ");
      return `【爆款样例 ${i + 1}】
  · 选题角度：${t.选题角度}
  · 开头钩子：${t.开头钩子}
  · 结构脉络：
${脉络}
  · 金句话术：${金句}
  · 结尾CTA：${t.结尾CTA}
  · 情绪基调：${t.情绪基调}
  · 可复用套路：${t.可复用套路}`;
    })
    .join("\n\n");
}

// 只渲染"结构骨架"部分（不含金句/CTA），供写梗概这类短输出参考——
// 梗概只需要走向和套路，塞进金句反而会诱导模型把梗概写成成稿。
export function renderTemplateOutlines(list: ScriptTemplate[]): string {
  return list
    .map((t, i) => {
      const 脉络 = (t.结构脉络 || []).map((s) => `    - ${s}`).join("\n");
      return `【爆款样例 ${i + 1}】
  · 选题角度：${t.选题角度}
  · 结构脉络：
${脉络}
  · 情绪基调：${t.情绪基调}
  · 可复用套路：${t.可复用套路}`;
    })
    .join("\n\n");
}

// 收集候选模板：一条热点常常跨多个领域（如"明星偷税"沾 影视娱乐+财经理财+法制普法）。
// 把领域串里出现的【所有】已知领域的模板池合并去重作为候选；一个都没匹配上就放开到全库。
// 结构套路本身跨领域通用，所以候选放宽反而更好——最终由相关性排序在候选里挑最贴的。
export function collectCandidates(domainStr: string): ScriptTemplate[] {
  const all = scriptTemplates as ScriptTemplate[];
  const raw = (domainStr || "").trim();
  if (!raw) return all;
  const hits = Object.keys(TEMPLATES_BY_DOMAIN).filter((k) => raw.includes(k));
  if (hits.length === 0) return all;
  const merged: ScriptTemplate[] = [];
  const seen = new Set<string>();
  for (const k of hits) {
    for (const t of TEMPLATES_BY_DOMAIN[k]) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        merged.push(t);
      }
    }
  }
  return merged.length ? merged : all;
}

export function randomPick(pool: ScriptTemplate[], n: number): ScriptTemplate[] {
  if (pool.length <= n) return pool.slice();
  const idxs = new Set<number>();
  while (idxs.size < n) idxs.add(Math.floor(Math.random() * pool.length));
  return [...idxs].map((i) => pool[i]);
}

// 相关性抽样：不再按单领域随机抓，而是把（可能跨领域的）候选模板的「选题角度+套路」
// 列成清单，让模型按【和当前话题套路是否贴合】挑出最相关的 n 条，跨领域也能选。
// 候选过多时先随机预采样到 40 条控制排序 prompt 体量；排序失败则回退到随机取样。
// llm: 由调用方注入的"给一段 prompt、返回一段文本"的函数，避免本模块依赖具体路由的 LLM 封装。
export async function pickRelevantTemplates(
  topic: string,
  domainStr: string,
  n: number,
  llm: (prompt: string) => Promise<string>
): Promise<ScriptTemplate[]> {
  const pool = collectCandidates(domainStr);
  if (pool.length <= n) return pool.slice();
  const ranking = pool.length > 40 ? randomPick(pool, 40) : pool;
  const menu = ranking
    .map(
      (t) =>
        `id:${t.id} | 领域:${t.领域} | 选题角度:${t.选题角度} | 套路:${t.可复用套路}`
    )
    .join("\n");
  const rankPrompt = `我要为下面这个话题写短视频脚本。请从候选爆款模板里挑出【套路最适合这个话题】的 ${n} 条，可以跨领域，只看结构/钩子/套路搭不搭，不必局限于话题所属领域。按相关度从高到低排。

话题：${topic}

候选模板：
${menu}

只返回一个 JSON 数组，元素是选中模板的 id 字符串，最多 ${n} 个，最相关的排最前。例如 ["123","456"]。不要任何解释或多余文字。`;
  try {
    const res = await llm(rankPrompt);
    const txt = String(res)
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();
    const ids = JSON.parse(txt) as unknown;
    if (Array.isArray(ids)) {
      const byId: Record<string, ScriptTemplate> = {};
      for (const t of ranking) byId[t.id] = t;
      const picked = ids
        .map((id) => byId[String(id)])
        .filter((t): t is ScriptTemplate => Boolean(t))
        .slice(0, n);
      if (picked.length) return picked;
    }
  } catch {
    // 排序失败静默回退
  }
  return randomPick(pool, n);
}


