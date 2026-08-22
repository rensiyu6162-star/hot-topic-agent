"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolLogs?: string[];
}

const PLATFORMS = ["微博", "知乎", "B站", "抖音", "小红书", "快手", "头条", "百度"];
const DOMAINS = ["科技数码", "职场成长", "美食探店", "娱乐八卦", "财经理财", "健康养生", "教育学习", "旅行出行"];

export default function Home() {
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([...PLATFORMS]);
  const [domainOptions, setDomainOptions] = useState<string[]>([...DOMAINS]);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([...DOMAINS]);
  const [showDomainInput, setShowDomainInput] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: `欢迎使用热点抓取 Agent！已默认选中所有平台。\n\n你可以对我说：\n- "帮我抓取今日热点"\n- "根据XX领域筛选热点"\n- "帮我生成视频脚本"`,
    },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 首次加载：从 localStorage 恢复上次的领域设置
  useEffect(() => {
    try {
      const savedOptions = localStorage.getItem("domainOptions");
      const savedSelected = localStorage.getItem("selectedDomains");
      if (savedOptions) setDomainOptions(JSON.parse(savedOptions));
      if (savedSelected) setSelectedDomains(JSON.parse(savedSelected));
    } catch {}
    setHydrated(true);
  }, []);

  // 领域设置变化时持久化（恢复完成后才写，避免用默认值覆盖）
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("domainOptions", JSON.stringify(domainOptions));
      localStorage.setItem("selectedDomains", JSON.stringify(selectedDomains));
    } catch {}
  }, [hydrated, domainOptions, selectedDomains]);

  const togglePlatform = (p: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const toggleDomain = (d: string) => {
    setSelectedDomains((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    );
  };

  const addCustomDomain = () => {
    const d = domainInput.trim();
    if (!d) {
      setShowDomainInput(false);
      return;
    }
    setDomainOptions((prev) => (prev.includes(d) ? prev : [...prev, d]));
    setSelectedDomains((prev) => (prev.includes(d) ? prev : [...prev, d]));
    setDomainInput("");
    setShowDomainInput(false);
  };

  const sendMessage = async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput("");
    const userMsg: Message = { role: "user", content: msg };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);

    // 全选默认视为“全部领域”，不做重排；否则把选中的领域传给后端
    const isAllDefault =
      domainOptions.length === DOMAINS.length &&
      selectedDomains.length === DOMAINS.length;
    const domainStr =
      isAllDefault || selectedDomains.length === 0
        ? ""
        : selectedDomains.join("、");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMsg].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          domain: domainStr,
          platforms: selectedPlatforms,
        }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content || "抱歉，出了点问题。",
          toolLogs: data.toolLogs,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "请求失败，请检查网络或服务配置。" },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="h-[100dvh] flex flex-col bg-gray-50 overflow-hidden">
      {/* Header */}
      <header className="bg-white border-b px-4 py-3 shadow-sm space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <span className="text-lg font-bold text-indigo-600">🔥 热点抓取 Agent</span>
        </div>

        {/* 关注领域：多选，默认全选，可叉掉，可 + 添加自定义细分领域 */}
        <div>
          <div className="text-xs text-gray-400 mb-1">
            关注领域（默认全选，点选中项可叉掉，点 ＋ 添加你感兴趣的细分领域）
          </div>
          <div className="flex flex-wrap gap-2 items-center">
            {domainOptions.map((d) => {
              const active = selectedDomains.includes(d);
              return (
                <button
                  key={d}
                  onClick={() => toggleDomain(d)}
                  className={`px-3 py-1 rounded-full text-xs border transition flex items-center gap-1 ${
                    active
                      ? "bg-emerald-500 text-white border-emerald-500"
                      : "bg-white text-gray-500 border-gray-300 hover:border-emerald-300"
                  }`}
                >
                  <span>{d}</span>
                  {active && <span className="opacity-80 leading-none">✕</span>}
                </button>
              );
            })}
            {showDomainInput ? (
              <input
                autoFocus
                value={domainInput}
                onChange={(e) => setDomainInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addCustomDomain();
                  if (e.key === "Escape") {
                    setShowDomainInput(false);
                    setDomainInput("");
                  }
                }}
                onBlur={addCustomDomain}
                placeholder="输入领域后回车"
                className="px-2 py-1 rounded-full text-xs border border-emerald-400 focus:outline-none focus:ring-1 focus:ring-emerald-400 w-32"
              />
            ) : (
              <button
                onClick={() => setShowDomainInput(true)}
                className="px-3 py-1 rounded-full text-xs border border-dashed border-gray-400 text-gray-500 hover:border-emerald-400 hover:text-emerald-500 transition"
              >
                ＋ 添加
              </button>
            )}
          </div>
        </div>

        {/* 抓取平台 */}
        <div>
          <div className="text-xs text-gray-400 mb-1">抓取平台</div>
          <div className="flex flex-wrap gap-2">
            {PLATFORMS.map((p) => (
              <button
                key={p}
                onClick={() => togglePlatform(p)}
                className={`px-3 py-1 rounded-full text-xs border transition ${
                  selectedPlatforms.includes(p)
                    ? "bg-indigo-500 text-white border-indigo-500"
                    : "bg-white text-gray-600 border-gray-300 hover:border-indigo-300"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-indigo-500 text-white"
                  : "bg-white text-gray-800 shadow-sm border"
              }`}
            >
              {msg.toolLogs && msg.toolLogs.length > 0 && (
                <div className="mb-2 text-xs text-gray-400 border-b pb-2 space-y-0.5">
                  {msg.toolLogs.map((log, j) => (
                    <div key={j}>🔧 {log}</div>
                  ))}
                </div>
              )}
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-white rounded-2xl px-4 py-3 text-sm text-gray-400 shadow-sm border">
              思考中...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Quick Actions */}
      {messages.length <= 1 && (
        <div className="px-4 pb-2 flex flex-wrap gap-2">
          {["帮我抓取今日热点", "筛选相关热点并生成脚本", "有哪些爆款选题"].map(
            (hint) => (
              <button
                key={hint}
                onClick={() => sendMessage(hint)}
                className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-full hover:bg-indigo-100 transition"
              >
                {hint}
              </button>
            )
          )}
        </div>
      )}

      {/* Input */}
      <div className="border-t bg-white px-4 py-3 shrink-0">
        <div className="flex gap-2 max-w-3xl mx-auto">
          <input
            className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            placeholder="输入你的需求，例如：帮我看看今天有什么热点"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            disabled={loading}
          />
          <button
            onClick={() => sendMessage()}
            disabled={loading || !input.trim()}
            className="bg-indigo-500 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            发送
          </button>
        </div>
      </div>
    </main>
  );
}
