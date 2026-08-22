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

// 同步码：hot-xxxx-xxxx-xxxx，去掉易混字符（0/o/1/l 等）
const genSyncCode = () => {
  const alpha = "abcdefghijkmnpqrstuvwxyz23456789";
  const seg = (n: number) =>
    Array.from(
      { length: n },
      () => alpha[Math.floor(Math.random() * alpha.length)]
    ).join("");
  return `hot-${seg(4)}-${seg(4)}-${seg(4)}`;
};

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
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // 跨设备同步（同步码方案，无需登录）
  const [syncCode, setSyncCode] = useState("");
  const [showSync, setShowSync] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const pushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipPush = useRef(false);

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

      const savedCode = localStorage.getItem("syncCode");
      if (savedCode) setSyncCode(savedCode);

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

  // ===== 跨设备同步 =====
  const buildPayload = () => ({
    sessions,
    activeId,
    domainOptions,
    selectedDomains,
  });

  const applyPayload = (p: any) => {
    if (!p) return;
    skipPush.current = true; // 应用云端数据后不要立刻回推
    if (Array.isArray(p.sessions) && p.sessions.length > 0) {
      setSessions(p.sessions);
      const valid =
        p.activeId && p.sessions.some((s: Session) => s.id === p.activeId);
      setActiveId(valid ? p.activeId : p.sessions[0].id);
    }
    if (Array.isArray(p.domainOptions)) setDomainOptions(p.domainOptions);
    if (Array.isArray(p.selectedDomains)) setSelectedDomains(p.selectedDomains);
  };

  const pushSync = async (code: string) => {
    if (!code) return;
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, payload: buildPayload() }),
      });
      const data = await res.json();
      if (res.ok) setLastSyncAt(data.updatedAt || Date.now());
    } catch {}
  };

  const pullSync = async (code: string, silent = false): Promise<boolean> => {
    if (!code) return false;
    if (!silent) {
      setSyncBusy(true);
      setSyncMsg(null);
    }
    try {
      const res = await fetch(`/api/sync?code=${encodeURIComponent(code)}`);
      const data = await res.json();
      if (!res.ok) {
        if (!silent) setSyncMsg({ ok: false, text: data.error || "拉取失败" });
        return false;
      }
      applyPayload(data.payload);
      setLastSyncAt(data.updatedAt || 0);
      if (!silent) setSyncMsg({ ok: true, text: "已从云端拉取最新数据" });
      return true;
    } catch {
      if (!silent) setSyncMsg({ ok: false, text: "网络异常，请稍后重试" });
      return false;
    } finally {
      if (!silent) setSyncBusy(false);
    }
  };

  const enableSync = async () => {
    const code = genSyncCode();
    setSyncBusy(true);
    setSyncMsg(null);
    try {
      const res = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, payload: buildPayload() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSyncMsg({ ok: false, text: data.error || "启用失败" });
        return;
      }
      setSyncCode(code);
      try {
        localStorage.setItem("syncCode", code);
      } catch {}
      setLastSyncAt(data.updatedAt || Date.now());
      setSyncMsg({ ok: true, text: "已启用同步，请在其他设备输入此码" });
    } catch {
      setSyncMsg({ ok: false, text: "网络异常，请稍后重试" });
    } finally {
      setSyncBusy(false);
    }
  };

  const importCode = async () => {
    const c = codeInput.trim();
    if (!c) return;
    const ok = await pullSync(c, false);
    if (ok) {
      setSyncCode(c);
      try {
        localStorage.setItem("syncCode", c);
      } catch {}
      setSyncMsg({ ok: true, text: "已导入并绑定该同步码" });
      setCodeInput("");
    }
  };

  const disableSync = () => {
    setSyncCode("");
    try {
      localStorage.removeItem("syncCode");
    } catch {}
    setSyncMsg({ ok: true, text: "已停用同步，数据仅保留在本设备" });
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(syncCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  // 首次加载后，若已绑定同步码则自动拉一次云端最新数据
  useEffect(() => {
    if (!hydrated) return;
    if (syncCode) pullSync(syncCode, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  // 数据变化时防抖自动上传（已绑定同步码时）
  useEffect(() => {
    if (!hydrated || !syncCode) return;
    if (skipPush.current) {
      skipPush.current = false;
      return;
    }
    if (pushTimer.current) clearTimeout(pushTimer.current);
    pushTimer.current = setTimeout(() => pushSync(syncCode), 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, domainOptions, selectedDomains, activeId, syncCode, hydrated]);

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
    setPendingDelete(null);
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
      {/* 删除会话二次确认 */}
      {pendingDelete && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setPendingDelete(null)}
          />
          <div className="relative z-10 w-full max-w-xs bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="space-y-1">
              <div className="font-bold text-gray-800">删除会话</div>
              <p className="text-sm text-gray-500 leading-relaxed">
                确定删除会话「
                <span className="text-gray-700">{pendingDelete.title}</span>
                」吗？该会话的聊天记录将被清除，此操作不可撤销。
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDelete(null)}
                className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
              >
                取消
              </button>
              <button
                onClick={() => deleteSession(pendingDelete.id)}
                className="text-sm px-3 py-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 跨设备同步 */}
      {showSync && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowSync(false)}
          />
          <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <span className="font-bold text-gray-800">跨设备同步</span>
              <button
                onClick={() => setShowSync(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              用一串「同步码」在多台设备间共享会话与设置，无需注册登录。在新设备打开本站，输入同一串码即可拉取数据。
            </p>

            {syncCode ? (
              <div className="space-y-3">
                <div className="text-xs text-gray-400">你的同步码</div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-gray-50 border rounded-lg px-3 py-2 text-sm font-mono tracking-wide select-all">
                    {syncCode}
                  </code>
                  <button
                    onClick={copyCode}
                    className="text-xs shrink-0 px-3 py-2 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
                  >
                    {copied ? "已复制" : "复制"}
                  </button>
                </div>
                <p className="text-xs text-gray-400">
                  在其他设备打开本站 → 点「🔄 同步」→ 输入此码即可。
                  {lastSyncAt > 0 && (
                    <>
                      <br />
                      上次同步：{new Date(lastSyncAt).toLocaleString()}
                    </>
                  )}
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={() => pushSync(syncCode)}
                    disabled={syncBusy}
                    className="text-sm px-3 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
                  >
                    立即上传
                  </button>
                  <button
                    onClick={() => pullSync(syncCode)}
                    disabled={syncBusy}
                    className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition"
                  >
                    {syncBusy ? "处理中…" : "从云端拉取"}
                  </button>
                  <button
                    onClick={disableSync}
                    className="text-sm px-3 py-1.5 rounded-lg border text-gray-400 hover:text-red-500 hover:border-red-300 transition ml-auto"
                  >
                    停用同步
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <button
                  onClick={enableSync}
                  disabled={syncBusy}
                  className="w-full text-sm px-3 py-2 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition"
                >
                  {syncBusy ? "处理中…" : "启用同步（生成我的同步码）"}
                </button>
                <div className="flex items-center gap-2 text-xs text-gray-300">
                  <div className="flex-1 h-px bg-gray-200" />
                  或输入已有同步码
                  <div className="flex-1 h-px bg-gray-200" />
                </div>
                <div className="flex items-center gap-2">
                  <input
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !syncBusy && importCode()}
                    placeholder="hot-xxxx-xxxx-xxxx"
                    className="flex-1 border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  />
                  <button
                    onClick={importCode}
                    disabled={syncBusy || !codeInput.trim()}
                    className="text-sm shrink-0 px-3 py-2 rounded-lg border text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition"
                  >
                    {syncBusy ? "…" : "导入"}
                  </button>
                </div>
              </div>
            )}

            {syncMsg && (
              <div
                className={`text-xs ${
                  syncMsg.ok ? "text-emerald-600" : "text-red-500"
                }`}
              >
                {syncMsg.text}
              </div>
            )}

            <p className="text-[11px] text-gray-400 leading-relaxed border-t pt-3">
              ⚠️ 持有同步码的人都能读写你的数据，请勿公开分享。多台设备同时编辑时，以最后一次上传为准。
            </p>
          </div>
        </div>
      )}

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
                        setPendingDelete(s);
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
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                setSyncMsg(null);
                setShowSync(true);
              }}
              className={`text-xs border rounded-lg px-2 py-1 transition ${
                syncCode
                  ? "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                  : "text-gray-500 border-gray-200 hover:text-indigo-600 hover:border-indigo-300"
              }`}
              title={syncCode ? "同步已启用，点击管理" : "跨设备同步"}
            >
              🔄 {syncCode ? "已同步" : "同步"}
            </button>
            <button
              onClick={createSession}
              className="text-xs text-indigo-600 border border-indigo-200 rounded-lg px-2 py-1 hover:bg-indigo-50 transition"
            >
              ＋ 新会话
            </button>
          </div>
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
