// 服务端 LLM 配置解析与调用（仅服务端使用，依赖 node:async_hooks）。
//
// Key 策略（2026-09 改为强制 BYOK）：
// - 站点公开可访问，不设访问口令；但【访客请求必须自带 API Key】（界面里填写，只存
//   浏览器 localStorage，每次随 body 上送），没有 Key 一律不允许调用模型——不再有
//   "访客没填就花机主系统 Key"的兜底，杜绝公开网址被人白嫖额度；
// - 唯一例外是系统内部调用（scheduler 定时抓取，进程内带 X-Internal-Token 头），
//   才允许使用服务端 env 的系统 Key；
// - 每个请求入口调用 setRequestLlm(cfg)，之后该请求所有 LLM 调用（含工具 handler 等深层
//   嵌套）通过 getLlm() 拿到同一份配置——用 AsyncLocalStorage 透传，避免并发请求串配置，
//   也不用把 cfg 一层层传进十几个函数。
import { AsyncLocalStorage } from "node:async_hooks";
import {
  getProviderPreset,
  type LlmConfig,
  type LlmErrorAction,
  type LlmErrorKind,
  type LlmOverride,
} from "./llm-providers";

const trimSlash = (s: string) => s.replace(/\/+$/, "");

// 系统默认配置：env 未设置时回落到 DeepSeek 官方端点
function envLlmConfig(): LlmConfig {
  return {
    provider: "deepseek",
    apiKey: process.env.OPENAI_API_KEY || "",
    baseUrl: trimSlash(
      process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1"
    ),
    model: process.env.OPENAI_MODEL || "deepseek-chat",
  };
}

// 解析一次请求的生效配置：用户填了 Key → 用用户的（平台预设 baseUrl/模型，可被上送值覆盖）；
// 没填 → 系统默认。任何字段非法/缺失都安全回落，不抛错。
export function resolveLlmConfig(override?: LlmOverride | null): LlmConfig {
  const fallback = envLlmConfig();
  const key =
    typeof override?.apiKey === "string" ? override.apiKey.trim() : "";
  if (!key) return fallback;

  const preset = getProviderPreset(override?.provider);
  const baseUrl = trimSlash(
    (typeof override?.baseUrl === "string" && override.baseUrl.trim()
      ? override.baseUrl.trim()
      : preset.baseUrl) || fallback.baseUrl
  );
  const model =
    (typeof override?.model === "string" && override.model.trim()
      ? override.model.trim()
      : preset.model) || fallback.model;
  return { provider: preset.id, apiKey: key, baseUrl, model };
}

// 是否为系统内部调用（scheduler 进程内请求带 X-Internal-Token）。
// 只有内部调用允许花系统 env 的 Key；任何外部请求都无法伪造（token 只在服务端 env）。
export function isInternalRequest(req: { headers: { get: (n: string) => string | null } }): boolean {
  const t = process.env.INTERNAL_TOKEN;
  return !!t && req.headers.get("x-internal-token") === t;
}

// 请求级配置解析（强制 BYOK 模式）：
// - 访客上送了 Key → 用访客的 Key；
// - 内部调用（定时抓取）且未上送 Key → 用系统 env Key；
// - 外部访客没填 Key → 返回 apiKey 为空的配置；调用链首个模型调用会抛 no_key，
//   路由层统一引导访客去界面填自己的 Key（llmChatJson 已内置空 Key 拦截，不会真发请求）。
export function resolveRequestLlm(
  override?: LlmOverride | null,
  internal = false
): LlmConfig {
  const hasUserKey =
    typeof override?.apiKey === "string" && !!override.apiKey.trim();
  if (hasUserKey) return resolveLlmConfig(override);
  if (internal) return envLlmConfig();
  return { ...envLlmConfig(), apiKey: "" };
}

const llmStore = new AsyncLocalStorage<LlmConfig>();

// 请求入口调用：把本请求的 LLM 配置绑定到当前异步上下文（之后所有 await 链路都可读）。
export function setRequestLlm(cfg: LlmConfig): void {
  llmStore.enterWith(cfg);
}

// 请求处理过程中任意位置获取生效配置；未绑定（脚本直调等场景）回落系统默认。
export function getLlm(): LlmConfig {
  return llmStore.getStore() ?? envLlmConfig();
}

// LLM 调用失败错误：带分类 kind，路由层据此返回「配 Key / 去充值 / 重试」引导。
// 上层 catch 到后用 llmErrorAction() 转成前端可渲染的按钮结构。
export class LlmApiError extends Error {
  kind: LlmErrorKind;
  status?: number;
  upstream?: string;
  constructor(
    kind: LlmErrorKind,
    message: string,
    status?: number,
    upstream?: string
  ) {
    super(message);
    this.name = "LlmApiError";
    this.kind = kind;
    this.status = status;
    this.upstream = upstream;
  }
}

// 余额不足特征（各平台文案不一：DeepSeek 402 Insufficient Balance、OpenAI insufficient_quota、
// 阿里云 Arrearage、火山 AccountArrears、智谱/Moonshot「余额不足/欠费」）
const BALANCE_RE =
  /余额不足|余额为\s*0|欠费|账户余额|arrear|insufficient[\s_\-]?(balance|quota|fund|credit)|out of credit|not enough (balance|credit|quota)|额度不足|额度已用尽|payment required|exhausted/i;
// Key 无效特征
const AUTH_RE =
  /invalid[\s_\-]?api[\s_\-]?key|authentication|unauthorized|api[\s_\-]?key[\s\S]{0,20}(invalid|incorrect|not valid|expired)|鉴权|认证失败|身份验证|permission denied|invalid token|access token/i;

function classifyLlmStatus(status: number, body: string): LlmErrorKind {
  if (status === 402) return "no_balance";
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 429) return BALANCE_RE.test(body) ? "no_balance" : "rate_limited";
  // 非标准状态码：按上游文案兜底分类（部分平台欠费/Key错仍返回 400/500）
  if (BALANCE_RE.test(body)) return "no_balance";
  if (AUTH_RE.test(body)) return "invalid_key";
  return "upstream";
}

// 把任意异常转成前端引导结构；非 LLM 错误返回 null（调用方按普通失败处理）。
export function llmErrorAction(
  e: unknown,
  cfg?: LlmConfig
): LlmErrorAction | null {
  if (!(e instanceof LlmApiError)) return null;
  const c = cfg ?? getLlm();
  const preset = getProviderPreset(c.provider);
  const pname = preset.name.replace("（默认）", "");
  const META: Record<LlmErrorKind, { message: string; httpStatus: number }> = {
    no_key: {
      message: "还没有配置 AI 模型的 API Key。点「配置 API Key」填上你自己的 Key（各家平台都送免费额度），就能立刻使用。",
      httpStatus: 503,
    },
    invalid_key: {
      message: `${pname}的 API Key 无效或已失效。点「检查 Key」核对，或换一个有效 Key 后重试。`,
      httpStatus: 401,
    },
    no_balance: {
      message: `${pname}账户余额已用完。点「去充值」直达充值页，充值到账后点重试即可继续（通常几分钟内到账）。`,
      httpStatus: 402,
    },
    rate_limited: {
      message: "模型服务暂时繁忙（触发速率限制），请稍等约 1 分钟后点重试。",
      httpStatus: 429,
    },
    upstream: {
      message: "模型服务暂时不可用，请稍后点重试。若反复失败，可到「AI 模型设置」里换个平台试试。",
      httpStatus: 502,
    },
  };
  const meta = META[e.kind];
  return {
    kind: e.kind,
    message: meta.message,
    httpStatus: meta.httpStatus,
    providerName: pname,
    keyUrl: preset.keyUrl || undefined,
    topupUrl: preset.topupUrl || undefined,
  };
}

// 统一的 OpenAI 兼容 /chat/completions 调用：返回解析后的 JSON。
// 非 2xx 直接抛带分类（LlmApiError.kind）的错误，路由层据此给前端返回「配 Key / 去充值」引导，
// 而不是让用户面对 "Authentica... is not valid JSON" 这种莫名其妙的报错。
// 免费通道实测会间歇性返回【请求体被截断】式 400（JSON hex 转义不完整，列号随机）、
// 502/503、429——同一请求重发即成功。这类瞬时错误做最多 3 次短退避重试；
// Key 无效/欠费类错误不重试，立刻冒泡给用户明确引导。
const RETRYABLE_KINDS = new Set<LlmErrorKind>(["upstream", "rate_limited"]);
export async function llmChatJson(
  cfg: LlmConfig,
  payload: Record<string, unknown>,
  timeoutMs = 180000
): Promise<any> {
  if (!cfg.apiKey) {
    throw new LlmApiError("no_key", "未配置 API Key");
  }
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ model: cfg.model, ...payload }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      if (!res.ok) {
        const kind = classifyLlmStatus(res.status, text);
        console.error(
          `[llm-upstream] ${res.status} kind=${kind} attempt=${attempt + 1} model=${cfg.model} body=${text.slice(0, 400)}`
        );
        throw new LlmApiError(
          kind,
          `模型服务返回 ${res.status}：${text.slice(0, 300)}`,
          res.status,
          text.slice(0, 500)
        );
      }
      try {
        return JSON.parse(text);
      } catch {
        console.error(
          `[llm-upstream] non-json attempt=${attempt + 1} model=${cfg.model} body=${text.slice(0, 400)}`
        );
        throw new LlmApiError(
          "upstream",
          `模型服务返回了无法解析的内容：${text.slice(0, 200)}`
        );
      }
    } catch (e) {
      lastErr = e;
      // 不可恢复的错误立即抛出
      if (
        e instanceof LlmApiError &&
        (e.kind === "invalid_key" || e.kind === "no_balance" || e.kind === "no_key")
      ) {
        throw e;
      }
      const retryable =
        !(e instanceof LlmApiError) || RETRYABLE_KINDS.has(e.kind);
      if (!retryable || attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
  throw lastErr;
}
