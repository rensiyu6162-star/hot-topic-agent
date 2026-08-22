import { NextRequest, NextResponse } from "next/server";

// DeepSeek 余额查询接口的 base（去掉 /v1 后缀）
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || "https://api.deepseek.com/v1";
const BALANCE_BASE = OPENAI_BASE_URL.replace(/\/v1\/?$/, "");

// 查询用户自己的 DeepSeek 账户余额。
// Key 由前端逐次传入，仅用于本次转发查询，服务端不存储、不记录。
export async function POST(req: NextRequest) {
  try {
    const { apiKey } = await req.json();
    const key = (apiKey || "").trim();
    if (!key) {
      return NextResponse.json(
        { error: "请先填写你的 DeepSeek API Key" },
        { status: 400 }
      );
    }

    const res = await fetch(`${BALANCE_BASE}/user/balance`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });

    if (res.status === 401) {
      return NextResponse.json(
        { error: "API Key 无效，请检查后重试" },
        { status: 401 }
      );
    }

    const json = await res.json();
    const info = json?.balance_infos?.[0];
    return NextResponse.json({
      isAvailable: !!json?.is_available,
      currency: info?.currency || "CNY",
      totalBalance: info?.total_balance ?? "0",
      grantedBalance: info?.granted_balance ?? "0",
      toppedUpBalance: info?.topped_up_balance ?? "0",
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: `查询失败: ${e.message}` },
      { status: 500 }
    );
  }
}
