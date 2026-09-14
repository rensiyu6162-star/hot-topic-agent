import { NextRequest, NextResponse } from "next/server";
import { getProviderPreset, type LlmOverride } from "../../../lib/llm-providers";
import { LlmApiError, llmChatJson, llmErrorAction, resolveRequestLlm } from "../../../lib/llm";

// 连通性测试：前端「测试连接」按钮调用。用当前配置发一条最小请求，
// 成功返回模型名与回执样例，失败返回上游错误原文（Key 错/欠费/模型名错都能看清）。
export async function POST(req: NextRequest) {
  let override: LlmOverride | null = null;
  try {
    const body = await req.json();
    override = body?.llm ?? null;
  } catch {
    /* 无 body = 测系统默认 */
  }

  // 强制 BYOK：测试连接只测访客自己上送的 Key，不允许拿系统 Key 做测试
  const cfg = resolveRequestLlm(override, false);
  const usingOwnKey = !!(override && typeof override.apiKey === "string" && override.apiKey.trim());

  if (!cfg.apiKey) {
    const action = llmErrorAction(new LlmApiError("no_key", "未配置 API Key"), cfg);
    return NextResponse.json(
      {
        ok: false,
        error: action?.message || "没有可用的 API Key：你未填写自己的 Key，且系统默认 Key 也未配置。",
        ...(action ? { llmError: action } : {}),
      },
      { status: 200 }
    );
  }
  if (!cfg.baseUrl) {
    return NextResponse.json(
      { ok: false, error: "未填写接口地址（Base URL）。" },
      { status: 200 }
    );
  }
  if (!cfg.model) {
    const preset = getProviderPreset(override?.provider);
    return NextResponse.json(
      {
        ok: false,
        error:
          preset.id === "doubao"
            ? "豆包（火山方舟）需要填写「接入点 ID」作为模型名（形如 ep-xxxx），不是模型显示名。"
            : "未填写模型名。",
      },
      { status: 200 }
    );
  }

  try {
    const json = await llmChatJson(
      cfg,
      {
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
        temperature: 0,
      },
      30000
    );
    const sample = String(
      json?.choices?.[0]?.message?.content ?? ""
    ).trim();
    return NextResponse.json({
      ok: true,
      provider: cfg.provider,
      model: cfg.model,
      usingOwnKey,
      sample: sample.slice(0, 50),
    });
  } catch (e) {
    // Key 无效/欠费/限流同样给结构化引导（前端在测试结果旁显示「去充值 / 去申请 Key」直达链接）
    const action = llmErrorAction(e, cfg);
    return NextResponse.json(
      {
        ok: false,
        error: action?.message || (e as Error)?.message || String(e),
        ...(action ? { llmError: action } : {}),
      },
      { status: 200 }
    );
  }
}
