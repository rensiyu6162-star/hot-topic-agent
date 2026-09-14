// 数字漂移确定性守卫（2026-09 评测实证）：口播稿/报道里的百分比与速率数字本应全部
// 照抄资料，但模型会"顺口"把 98% 写成 99%（记忆/顺口改写，防不胜防）。
// 规则：输出中的【百分比】若与资料原文不一致——资料里有同形态百分数字时取数值最接近的
// 原值替换；资料里根本没有百分比时把该百分比泛化为定性表述（不留假数字）。
// 速率/数量类（如 300 Token/s）不做改写：它们有 priceGuard 与 prompt 纪律覆盖，且单位多样。
export function fixNumberDrift(text: string, material: string): string {
  if (!text) return text;
  const mat = material || "";
  const matPcts = [...mat.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map((m) =>
    Number(m[1])
  );
  const matSet = new Set(matPcts);
  return text.replace(/(\d+(?:\.\d+)?)\s*%/g, (full, ns, offset: number) => {
    const n = Number(ns);
    if (matSet.has(n)) return full;
    if (matPcts.length) {
      // 取资料中数值最接近的百分比原值替换（漂移通常只差几个点）
      let best = matPcts[0];
      let bestD = Math.abs(best - n);
      for (const p of matPcts) {
        const d = Math.abs(p - n);
        if (d < bestD) {
          best = p;
          bestD = d;
        }
      }
      return `${best}%`;
    }
    // 资料无任何百分比 → 该数字是编造，按上下文方向泛化（不留假数字）
    const before = text.slice(Math.max(0, offset - 8), offset);
    return /只有|仅|才|不到|低于|低|砍到|压缩到|节省/.test(before) ? "极低" : "极高";
  });
}
