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

// 口播稿「网感硬纪律」：从真实翻车成稿反推的 AI 腔禁令，两个脚本生成入口共用
// （api/script 弹窗生成 + api/chat 的 generate_video_script 工具）。
// 关键教训：给模型列"示例口语词"（如"你发现没""说白了"）会被逐词复读成 AI 腔——
// 所有脚本长一个味。所以这里只给禁令与正向标准，绝不给可复读的示例词。
export const ANTI_AI_RULES = `【网感硬纪律】以下为硬性要求，写完逐条自检，违反任意一条即为不合格稿：
1. 第一句必须是事件里具体的事实、原话或数字（谁+干了什么/说了什么），而且整句要短——不超过约20个字、3秒出头能念完，背景信息一律往后放；禁止抽象论点、人生感悟或万能句式开头（如"XX里最爽的事不是A，是B"这类任何话题都能套的开头）；
2. 禁用AI腔句式及其变体："你发现没""你有没有发现""但你以为这就完了？""听懂没？""说白了""我告诉你""注意到了吗""这才是最X的"，以及"XX不是A来的，是B出来的"式对仗金句；
3. 不替观众解读：禁止"潜台词就是""意思就是""表面是X实际是Y"式解说词；只呈现可证事实与直接引语，让观众自己品；需要点破时用另一个事实点破，严禁替当事人编造内心戏、动机或没有出处的情绪；
4. 不渲染无资料支撑的场面（"现场直接炸了""全场沸腾"这类无出处的情绪描写禁止）；资料里的原话引用时保持原样，不加工不润色；
5. 结尾禁止格言、鸡汤、人生道理收束；结尾钩子必须取自资料里真实存在的争议点、反差或后续悬念，每条稿换不同的收束方式，不要条条都二选一提问；禁止万能套话（"你站哪边""评论区告诉我""站队""你怎么看""你觉得呢""评论区聊聊"等一律不许出现），资料信息不足、没有真实争议时用事实点到为止收尾，不要硬凑互动；
6. 每一句都要有新信息，同一意思不得换说法重复；长句全部拆成口语短句，但不许堆语气词凑节奏；
7. 主题本身是玩梗/颜值/娱乐向内容时，全稿必须保持玩梗吐槽的语气，把梗本身讲透（梗怎么来的、网友怎么玩、当事人或圈内圈外什么反应），主题里的梗是主菜——禁止滑向"其实他很努力/很谦逊/实力才是底气"式励志叙事稀释笑点；与梗相对的另一面（如赛程成绩）只能当反差佐料一笔带过，不能反客为主；
8. 节奏与用词：一句≤20字、两三句一个转折或新信息；禁用书面腔（"值得注意的是""诚然""不禁让人""某种意义上""在这个时代"），禁用主持人式总结过渡（"说到这里""话又说回来"）——成稿读出来必须像朋友在饭桌上讲这事，不像在台上念稿。`;

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

// 渲染原文摘录块：网感在原文里——语感（口语措辞/节奏/梗用法）从原文学，
// 结构从拆解学。旧的"5条拆解+1条原文片段"配比被证明学得到结构学不到语感。
export function renderExcerpts(list: ScriptTemplate[]): string {
  const withRaw = list.filter((t) => (t.原文摘录 || "").trim());
  if (!withRaw.length) return "";
  return withRaw
    .map(
      (t, i) =>
        `【爆款原文 ${i + 1}｜选题：${t.选题角度}】\n「${(t.原文摘录 || "").trim()}」`
    )
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

// 话题 2-gram：中文无分词，用相邻双字近似关键词
function bigramsOf(s: string): string[] {
  const t = (s || "").replace(/\s+/g, "");
  const grams: string[] = [];
  for (let i = 0; i < t.length - 1; i++) grams.push(t.slice(i, i + 2));
  return grams;
}

// 相关性预采样：旧逻辑 randomPick(40) 纯随机，导致每次送进排序的样例都不同
// （风格漂移），且贴题模板可能根本进不了候选。改为先按"话题2-gram 在模板
// 文本中的命中数"打分排序，取分数最高的前段，再从剩余随机补足——贴题优先、
// 保留多样性；全 0 分（话题词与模板无重叠）退化为纯随机原行为。
function presample(pool: ScriptTemplate[], topic: string, n: number): ScriptTemplate[] {
  if (pool.length <= n) return pool.slice();
  const grams = bigramsOf(topic);
  const scored = pool.map((t) => {
    const text = `${t.选题角度}${t.可复用套路}${t.开头钩子 || ""}${(t.结构脉络 || []).join("")}`;
    let s = 0;
    for (const g of grams) if (text.includes(g)) s++;
    return { t, s };
  });
  scored.sort((a, b) => b.s - a.s);
  if ((scored[0]?.s ?? 0) <= 0) return randomPick(pool, n);
  const headCount = Math.min(Math.floor(n * 0.6), scored.filter((x) => x.s > 0).length);
  const head = scored.slice(0, headCount).map((x) => x.t);
  const rest = scored.slice(headCount).map((x) => x.t);
  return [...head, ...randomPick(rest, n - head.length)];
}

// 相关性抽样：不再按单领域随机抓，而是把（可能跨领域的）候选模板的「选题角度+套路」
// 列成清单，让模型按【和当前话题套路是否贴合】挑出最相关的 n 条，跨领域也能选。
// 候选过多时先按相关性预采样到 40 条控制排序 prompt 体量；排序失败则回退到随机取样。
// llm: 由调用方注入的"给一段 prompt、返回一段文本"的函数，避免本模块依赖具体路由的 LLM 封装。
export async function pickRelevantTemplates(
  topic: string,
  domainStr: string,
  n: number,
  llm: (prompt: string) => Promise<string>
): Promise<ScriptTemplate[]> {
  const pool = collectCandidates(domainStr);
  if (pool.length <= n) return pool.slice();
  const ranking = presample(pool, topic, 40);
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
  } catch (e) {
    // LLM 排序结果解析失败：记录后静默回退到随机挑样例
    console.warn("[templates] LLM 模板排序结果解析失败，回退随机挑选:", (e as Error)?.message || e);
  }
  return randomPick(pool, n);
}


