// AI 服务商预设（纯数据 + 类型，前后端共用，不得引入 node API）。
// 所有预设均为 OpenAI 兼容的 /chat/completions 接口——切换平台只需换 baseUrl/模型名/Key。
// 默认 DeepSeek（与服务端 env 默认一致）。

export type LlmProviderId =
  | "deepseek"
  | "openai"
  | "moonshot"
  | "zhipu"
  | "qwen"
  | "doubao"
  | "custom";

export interface LlmProviderPreset {
  id: LlmProviderId;
  name: string;
  // OpenAI 兼容 baseUrl（含 /v1 等版本前缀）
  baseUrl: string;
  // 默认模型名；custom / 豆包(需接入点ID) 留空由用户填
  model: string;
  // 申请 Key 的地址，前端设置弹窗里展示
  keyUrl: string;
  // 充值直达页（余额不足时「去充值」按钮直接跳到这里，而不是平台首页）
  topupUrl: string;
  // 模型输入框占位提示
  modelPlaceholder?: string;
}

export const LLM_PROVIDERS: LlmProviderPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek（默认）",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyUrl: "https://platform.deepseek.com/api_keys",
    topupUrl: "https://platform.deepseek.com/top_up",
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    keyUrl: "https://platform.openai.com/api-keys",
    topupUrl: "https://platform.openai.com/settings/organization/billing/overview",
  },
  {
    id: "moonshot",
    name: "Kimi（月之暗面）",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
    topupUrl: "https://platform.moonshot.cn/console/pay",
  },
  {
    id: "zhipu",
    name: "智谱 GLM",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-4-flash",
    keyUrl: "https://open.bigmodel.cn/usercenter/apikeys",
    topupUrl: "https://open.bigmodel.cn/finance/pay",
  },
  {
    id: "qwen",
    name: "通义千问（阿里云）",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1#/api-key",
    topupUrl: "https://usercenter2.console.aliyun.com/finance/fund-management/recharge",
  },
  {
    id: "doubao",
    name: "豆包（火山方舟）",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    model: "",
    keyUrl: "https://console.volcengine.com/ark/region:ark+cn-beijing/apiKey",
    topupUrl: "https://console.volcengine.com/finance/fund/recharge",
    modelPlaceholder: "填接入点 ID，如 ep-2025xxxxxx",
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    baseUrl: "",
    model: "",
    keyUrl: "",
    topupUrl: "",
    modelPlaceholder: "模型名，如 my-model",
  },
];

export const DEFAULT_PROVIDER: LlmProviderPreset = LLM_PROVIDERS[0];

export function getProviderPreset(id: string | undefined | null): LlmProviderPreset {
  return LLM_PROVIDERS.find((p) => p.id === id) || DEFAULT_PROVIDER;
}

// 前端随请求上送的 LLM 覆盖配置（BYOK：用户自带 Key；不填 Key 则服务端用系统默认）
export interface LlmOverride {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export interface LlmConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  // 仅服务端内部使用：标记该配置来自服务端 env（scheduler 系统调用），
  // 允许在主通道故障时动用 env 备用 Key；访客上送的 BYOK 配置不带此标记。
  systemOwned?: boolean;
}

// LLM 调用失败时的「可操作引导」（纯数据，前后端共用）：
// 前端按 kind 渲染按钮——no_key/invalid_key 弹设置配 Key，no_balance 直达 topupUrl 充值。
export type LlmErrorKind =
  | "no_key" // 没配 Key（用户没填且服务端默认也没配）
  | "invalid_key" // 401/403：Key 无效、失效或被禁用
  | "no_balance" // 402/欠费：账户余额不足
  | "rate_limited" // 429：触发速率限制，稍后重试即可
  | "upstream"; // 其它上游故障（5xx/网络/返回异常）

export interface LlmErrorAction {
  kind: LlmErrorKind;
  // 给用户看的一句话说明（已含平台名，前端直接展示）
  message: string;
  // 建议 HTTP 状态码（路由返回时用）
  httpStatus: number;
  // 平台展示名（如 "DeepSeek"）
  providerName: string;
  // 申请/管理 Key 的直达页（可空：自定义平台没有）
  keyUrl?: string;
  // 充值直达页（可空：自定义平台没有）
  topupUrl?: string;
}
