// Upstash Redis REST 封装：同步(/api/sync)与定时任务(/api/schedule)共用。
// 与 Vercel Storage 的 KV 环境变量兼容；VPS 自建部署需在容器里注入同名变量。

const REST_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
const REST_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";

export function kvConfigured(): boolean {
  return Boolean(REST_URL && REST_TOKEN);
}

// 执行一条 Redis 命令（命令以 JSON 数组形式放在 body 里，支持大 value）
export async function kv(command: (string | number)[]): Promise<any> {
  const res = await fetch(REST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REST_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(json?.error || `KV 请求失败(${res.status})`);
  }
  return json?.result;
}
