"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolLogs?: string[];
}

interface Session {
  id: string;
  title: string;
  messages: Message[];
}

const WELCOME: Message = {
  role: "assistant",
  content: `欢迎使用热点抓取 Agent！已默认选中所有平台。\n\n你可以对我说：\n- "帮我抓取今日热点"\n- "根据XX领域筛选热点"\n- "帮我生成视频脚本"`,
};

const DEFAULT_SESSION_ID = "default";
const genId = () =>
  `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const newSession = (): Session => ({
  id: genId(),
  title: "新会话",
  messages: [WELCOME],
});

const PLATFORMS = ["微博", "知乎", "B站", "抖音", "小红书", "快手", "头条", "百度"];
const DOMAINS = ["科技数码", "职场成长", "美食探店", "娱乐八卦", "财经理财", "健康养生", "教育学习", "旅行出行"];

export default function Home() {
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([...PLATFORMS]);
  const [domainOptions, setDomainOptions] = useState<string[]>([...DOMAINS]);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([...DOMAINS]);
  const [showDomainInput, setShowDomainInput] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  const [sessions, setSessions] = useState<Session[]>([
    { id: DEFAULT_SESSION_ID, title: "新会话", messages: [WELCOME] },
  ]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_SESSION_ID);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeSession = sessions.find((s) => s.id === activeId) ?? sessions[0];
  const messages = activeSession?.messages ?? [];
  const setActiveMessages = (updater: (prev: Message[]) => Message[]) => {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId ? { ...s, messages: updater(s.messages) } : s
      )
    );
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 首次加载：从 localStorage 恢复领域设置与会话
  useEffect(() => {
    try {
      const savedOptions = localStorage.getItem("domainOptions");
      const savedSelected = localStorage.getItem("selectedDomains");
      if (savedOptions) setDomainOptions(JSON.parse(savedOptions));
      if (savedSelected) setSelectedDomains(JSON.parse(savedSelected));

      const savedSessions = localStorage.getItem("sessions");
      const savedActive = localStorage.getItem("activeSessionId");
      if (savedSessions) {
        const parsed = JSON.parse(savedSessions);
        if (Array.isArray(parsed) && parsed.length > 0) {
          setSessions(parsed);
          const validActive =
            savedActive && parsed.some((s: Session) => s.id === savedActive);
          setActiveId(validActive ? savedActive! : parsed[0].id);
        }
      } else {
        // 迁移旧版单会话聊天记录
        const savedMessages = localStorage.getItem("chatMessages");
        if (savedMessages) {
          const parsed = JSON.parse(savedMessages);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const migrated: Session = {
              id: DEFAULT_SESSION_ID,
              title: "历史会话",
              messages: parsed,
            };
            setSessions([migrated]);
            setActiveId(migrated.id);
          }
        }
      }
    } catch {}
    setHydrated(true);
  }, []);

  // 领域设置与会话变化时持久化（恢复完成后才写，避免用默认值覆盖）
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("domainOptions", JSON.stringify(domainOptions));
      localStorage.setItem("selectedDomains", JSON.stringify(selectedDomains));
      localStorage.setItem("sessions", JSON.stringify(sessions));
      localStorage.setItem("activeSessionId", activeId);
    } catch {}
  }, [hydrated, domainOptions, selectedDomains, sessions, activeId]);

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

  const createSession = () => {
    const s = newSession();
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setSidebarOpen(false);
  };

  const deleteSession = (id: string) => {
    const next = sessions.filter((s) => s.id !== id);
    if (next.length === 0) {
      const fresh = newSession();
      setSessions([fresh]);
      setActiveId(fresh.id);
    } else {
      setSessions(next);
      if (id === activeId) setActiveId(next[0].id);
    }
  };

  const switchSession = (id: string) => {
    setActiveId(id);
    setSidebarOpen(false);
  };

  const startRename = (s: Session) => {
    setRenamingId(s.id);
    setRenameInput(s.title);
  };

  const commitRename = () => {
    const t = renameInput.trim();
    if (t && renamingId) {
      setSessions((prev) =>
        prev.map((s) => (s.id === renamingId ? { ...s, title: t } : s))
      );
    }
    setRenamingId(null);
    setRenameInput("");
  };

  const sendMessage = async (text?: string) => {
    const msg = text || input.trim();
    if (!msg || loading) return;
    setInput("");
    const userMsg: Message = { role: "user", content: msg };
    setSessions((prev) =>
      prev.map((s) => {
        if (s.id !== activeId) return s;
        const isFirstUser = !s.messages.some((m) => m.role === "user");
        return {
          ...s,
          title: isFirstUser ? msg.slice(0, 20) : s.title,
          messages: [...s.messages, userMsg],
        };
      })
    );
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
      setActiveMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content || "抱歉，出了点问题。",
          toolLogs: data.toolLogs,
        },
      ]);
    } catch {
      setActiveMessages((prev) => [
        ...prev,
        { role: "assistant", content: "请求失败，请检查网络或服务配置。" },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="h-[100dvh] flex flex-col bg-gray-50 overflow-hidden">
      {/* 会话侧边栏 */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-40 flex">
          <div
            className="absolute inset-0 bg-black/30"
            onClick={() => setSidebarOpen(false)}
          />
          <div className="relative z-50 w-72 max-w-[80%] h-full bg-white shadow-xl flex flex-col">
            <div className="px-4 py-3 border-b flex items-center justify-between shrink-0">
              <span className="font-bold text-gray-700">会话</span>
              <button
                onClick={createSession}
                className="text-xs text-indigo-600 border border-indigo-200 rounded-lg px-2 py-1 hover:bg-indigo-50 transition"
              >
                ＋ 新建
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {sessions.map((s) => {
                const active = s.id === activeId;
                return (
                  <div
                    key={s.id}
                    onClick={() => switchSession(s.id)}
                    className={`group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer transition ${
                      active
                        ? "bg-indigo-50 text-indigo-700"
                        : "hover:bg-gray-100 text-gray-700"
                    }`}
                  >
                    {renamingId === s.id ? (
                      <input
                        autoFocus
                        value={renameInput}
                        onClick={(e) => e.stopPropagation()}
                        onChange={(e) => setRenameInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") {
                            setRenamingId(null);
                            setRenameInput("");
                          }
                        }}
                        onBlur={commitRename}
                        className="flex-1 min-w-0 text-sm border border-indigo-300 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-400"
                      />
                    ) : (
                      <span className="flex-1 min-w-0 truncate text-sm">
                        {s.title}
                      </span>
                    )}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        startRename(s);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-indigo-600 transition text-xs shrink-0"
                      title="重命名"
                    >
                      ✎
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSession(s.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 transition text-xs shrink-0"
                      title="删除"
                    >
                      🗑
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b px-4 py-3 shadow-sm space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSidebarOpen(true)}
              className="text-gray-500 hover:text-indigo-600 transition text-lg leading-none px-1"
              title="会话列表"
            >
              ☰
            </button>
            <span className="text-lg font-bold text-indigo-600">🔥 热点抓取 Agent</span>
          </div>
          <button
            onClick={createSession}
            className="text-xs text-indigo-600 border border-indigo-200 rounded-lg px-2 py-1 hover:bg-indigo-50 transition"
          >
            ＋ 新会话
          </button>
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
