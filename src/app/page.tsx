"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolLogs?: string[];
}

interface DetailData {
  report: string;
  sites: { title: string; url: string; source?: string; core?: boolean }[];
  videos: { title: string; url: string; app?: string; source?: string; core?: boolean }[];
}

interface DetailState {
  open: boolean;
  loading: boolean;
  data: DetailData | null;
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

const PLATFORMS = ["微博", "知乎", "B站", "抖音", "小红书", "头条", "百度"];
const DOMAINS = ["科技数码", "职场成长", "美食探店", "娱乐八卦", "财经理财", "健康养生", "教育学习", "旅行出行"];

export default function Home() {
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([...PLATFORMS]);
  const [domainOptions, setDomainOptions] = useState<string[]>([...DOMAINS]);
  const [selectedDomains, setSelectedDomains] = useState<string[]>([...DOMAINS]);
  const [showDomainInput, setShowDomainInput] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  // 领域/平台收进标题栏的下拉菜单（both 为移动端合并下拉）
  const [openMenu, setOpenMenu] = useState<null | "domain" | "platform" | "both">(null);
  // 顶部完整选择区是否还在可视范围内（滚出后才在标题栏显示下拉入口）
  const [selectorsVisible, setSelectorsVisible] = useState(true);
  const [sessions, setSessions] = useState<Session[]>([
    { id: DEFAULT_SESSION_ID, title: "新会话", messages: [WELCOME] },
  ]);
  const [activeId, setActiveId] = useState<string>(DEFAULT_SESSION_ID);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);
  const [pendingDeleteDomain, setPendingDeleteDomain] = useState<string | null>(
    null
  );
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
  // 每条热点的「查看详情」展开状态（key = 消息序号:行号）
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const selectorsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
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

  // 顶部领域/平台选择区滚出可视范围时，才在标题栏显示下拉入口
  useEffect(() => {
    const el = selectorsRef.current;
    const root = scrollRef.current;
    if (!el || !root) return;
    const ob = new IntersectionObserver(
      ([entry]) => setSelectorsVisible(entry.isIntersecting),
      { root, threshold: 0 }
    );
    ob.observe(el);
    return () => ob.disconnect();
  }, [activeId]);

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
    setSelectedDomains((prev) => {
      // 从“全选”状态点某个领域 → 只聚焦它，让每次点击都能明显改变筛选结果
      const allSelected = prev.length === domainOptions.length;
      if (allSelected) return [d];
      if (prev.includes(d)) return prev.filter((x) => x !== d);
      return [...prev, d];
    });
  };

  const selectAllDomains = () => setSelectedDomains([...domainOptions]);
  const clearDomains = () => setSelectedDomains([]);
  const selectAllPlatforms = () => setSelectedPlatforms([...PLATFORMS]);
  const clearPlatforms = () => setSelectedPlatforms([]);

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

  const deleteDomain = (d: string) => {
    setDomainOptions((prev) => prev.filter((x) => x !== d));
    setSelectedDomains((prev) => prev.filter((x) => x !== d));
    setPendingDeleteDomain(null);
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
    const allSelected =
      selectedDomains.length > 0 &&
      selectedDomains.length === domainOptions.length;
    const domainStr =
      allSelected || selectedDomains.length === 0
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

  const renderDomainChips = (autoFocusInput = false) => {
    const ordered = [
      ...domainOptions.filter((d) => selectedDomains.includes(d)),
      ...domainOptions.filter((d) => !selectedDomains.includes(d)),
    ];
    return (
      <div className="flex flex-wrap gap-2 items-center">
        {ordered.map((d) => {
          const active = selectedDomains.includes(d);
          const custom = !DOMAINS.includes(d);
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
              {custom && !active && (
                <span
                  role="button"
                  title="删除自定义领域"
                  onClick={(e) => {
                    e.stopPropagation();
                    setPendingDeleteDomain(d);
                  }}
                  className="ml-0.5 text-gray-400 hover:text-red-500 leading-none"
                >
                  ✕
                </span>
              )}
            </button>
          );
        })}
        {showDomainInput ? (
          <input
            ref={(el) => {
              if (autoFocusInput && el) el.focus({ preventScroll: true });
            }}
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
    );
  };

  const renderPlatformChips = () => {
    const ordered = [
      ...PLATFORMS.filter((p) => selectedPlatforms.includes(p)),
      ...PLATFORMS.filter((p) => !selectedPlatforms.includes(p)),
    ];
    return (
      <div className="flex flex-wrap gap-2 items-center">
        {ordered.map((p) => {
          const active = selectedPlatforms.includes(p);
          return (
            <button
              key={p}
              onClick={() => togglePlatform(p)}
              className={`px-3 py-1 rounded-full text-xs border transition ${
                active
                  ? "bg-indigo-500 text-white border-indigo-500"
                  : "bg-white text-gray-600 border-gray-300 hover:border-indigo-300"
              }`}
            >
              {p}
            </button>
          );
        })}
      </div>
    );
  };

  // 区块标题（左侧标签 + 右上角 全选/清空）
  const renderDomainHeader = () => (
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs text-gray-400">关注领域</span>
      <div className="flex items-center gap-2">
        <button
          onClick={selectAllDomains}
          className="text-xs text-gray-400 hover:text-emerald-500 transition"
        >
          全选
        </button>
        <span className="h-3 w-px bg-gray-200" />
        <button
          onClick={clearDomains}
          className="text-xs text-gray-400 hover:text-emerald-500 transition"
        >
          清空
        </button>
      </div>
    </div>
  );

  const renderPlatformHeader = () => (
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs text-gray-400">抓取平台</span>
      <div className="flex items-center gap-2">
        <button
          onClick={selectAllPlatforms}
          className="text-xs text-gray-400 hover:text-indigo-500 transition"
        >
          全选
        </button>
        <span className="h-3 w-px bg-gray-200" />
        <button
          onClick={clearPlatforms}
          className="text-xs text-gray-400 hover:text-indigo-500 transition"
        >
          清空
        </button>
      </div>
    </div>
  );

  // 去掉多余的 Markdown 符号（行首 #/##/### 标题符号、** 加粗、* 强调）后再展示
  const cleanMarkdown = (text: string) =>
    text
      .replace(/^\s*#{1,6}\s+/gm, "")
      .replace(/\*+/g, "");

  // 把一行文字里的 【xxx】 渲染成跑道圆形胶囊
  const renderLineWithTags = (text: string, keyPrefix: string) => {
    const parts = text.split(/(【[^】]*】)/g);
    return parts.map((part, idx) => {
      const m = part.match(/^【([^】]*)】$/);
      if (m) {
        // 兜底：模型有时把多个领域塞进同一个【】（如「女性成长、反bl」），
        // 这里按顿号/逗号/斜杠拆开，一个领域渲染成一个独立胶囊。
        const tags = m[1]
          .split(/[、，,\/]+/)
          .map((t) => t.trim())
          .filter(Boolean);
        return tags.map((tag, j) => (
          <span
            key={`${keyPrefix}-${idx}-${j}`}
            className="inline-flex items-center rounded-full bg-emerald-50 text-emerald-600 text-[10px] leading-none px-1.5 py-0.5 mx-0.5 align-middle"
          >
            {tag}
          </span>
        ));
      }
      return <span key={`${keyPrefix}-${idx}`}>{part}</span>;
    });
  };

  // 去掉行首序号和 ⭐，得到"平台｜标题 【标签】"主体
  const stripLead = (line: string) =>
    line
      .replace(/^\s*\d+[.、)]\s*/, "")
      .replace(/⭐/g, "")
      .trim();

  // 从热点行里提取纯话题标题（去掉序号、⭐、"平台｜"前缀、【】标签、Markdown 符号）
  const extractTopic = (line: string) =>
    stripLead(line)
      .replace(/^[^｜|【\n]{1,10}[｜|]\s*/, "") // 去掉"平台｜"前缀（若有）
      .replace(/【[^】]*】/g, "")
      .replace(/[*#`]+/g, "")
      .trim();

  // 从热点行里提取平台（行格式为"序号. 平台｜标题 …"，取 ｜ 前的平台名）
  const extractPlatform = (line: string) => {
    const m = stripLead(line).match(/^([^｜|【\n]{1,10})[｜|]/);
    return m ? m[1].trim() : "";
  };

  // 点击「查看详情」：首次拉取详情并展开，之后仅切换展开/收起
  const toggleDetail = async (key: string, topic: string, platform = "") => {
    const cur = details[key];
    if (cur && cur.data) {
      setDetails((p) => ({ ...p, [key]: { ...cur, open: !cur.open } }));
      return;
    }
    if (cur && cur.loading) return;
    setDetails((p) => ({
      ...p,
      [key]: { open: true, loading: true, data: null },
    }));
    try {
      const res = await fetch("/api/detail", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic, platform }),
      });
      const data = (await res.json()) as DetailData;
      setDetails((p) => ({ ...p, [key]: { open: true, loading: false, data } }));
    } catch {
      setDetails((p) => ({
        ...p,
        [key]: {
          open: true,
          loading: false,
          data: { report: "详情获取失败，请稍后重试。", sites: [], videos: [] },
        },
      }));
    }
  };

  // 渲染 AI 正文：逐行解析，热点条目支持 hover「查看详情」原地展开
  const renderAssistantContent = (content: string, msgIndex: number) => {
    const lines = content.split("\n");
    return lines.map((line, li) => {
      if (line.trim() === "") return <div key={li} className="h-2" />;
      const isItem = /^\s*\d+[.、)]\s/.test(line);
      if (!isItem) {
        return (
          <div key={li} className="whitespace-pre-wrap">
            {renderLineWithTags(cleanMarkdown(line), `${msgIndex}-${li}`)}
          </div>
        );
      }
      const topic = extractTopic(line);
      const platform = extractPlatform(line);
      const key = `${msgIndex}:${li}`;
      const st = details[key];
      return (
        <div key={li} className="group">
          <div className="whitespace-pre-wrap">
            {renderLineWithTags(cleanMarkdown(line), key)}
            <button
              onClick={() => toggleDetail(key, topic, platform)}
              className="align-middle ml-2 whitespace-nowrap text-[11px] leading-none px-2 py-1 rounded-full border border-indigo-300 text-indigo-500 hover:bg-indigo-50 transition opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
            >
              {st?.open ? "收起" : "查看详情"}
            </button>
          </div>
          {st?.open && (
            <div className="mt-2 mb-2 rounded-xl bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600 space-y-3">
              {st.loading ? (
                <div className="text-gray-400">正在生成详情…</div>
              ) : st.data ? (
                <>
                  <div>
                    <div className="font-semibold text-gray-700 mb-1">
                      📄 详细报道
                    </div>
                    <div className="whitespace-pre-wrap leading-relaxed">
                      {cleanMarkdown(st.data.report)}
                    </div>
                  </div>
                  {st.data.sites?.length > 0 && (
                    <div>
                      <div className="font-semibold text-gray-700 mb-1">
                        🔗 参考网站
                      </div>
                      <div className="flex flex-col gap-1">
                        {st.data.sites.map((s, k) => (
                          <a
                            key={k}
                            href={s.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-indigo-500 hover:underline break-words"
                          >
                            {s.title}
                            {s.core && (
                              <span className="ml-1 align-middle text-[10px] px-1 py-px rounded bg-emerald-100 text-emerald-600">
                                核心来源
                              </span>
                            )}
                            {s.source && (
                              <span className="ml-1 text-xs text-gray-400">
                                — {s.source}
                              </span>
                            )}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                  {st.data.videos?.length > 0 && (
                    <div>
                      <div className="font-semibold text-gray-700 mb-1">
                        🎬 参考视频
                      </div>
                      <div className="flex flex-col gap-1">
                        {st.data.videos.map((v, k) => (
                          <a
                            key={k}
                            href={v.url}
                            target="_blank"
                            rel="noreferrer"
                            onClick={
                              v.app
                                ? (e) => {
                                    e.preventDefault();
                                    openVideo(v);
                                  }
                                : undefined
                            }
                            className="text-indigo-500 hover:underline break-words"
                          >
                            {v.title}
                            {v.core && (
                              <span className="ml-1 align-middle text-[10px] px-1 py-px rounded bg-emerald-100 text-emerald-600">
                                核心来源
                              </span>
                            )}
                            {v.source && (
                              <span className="ml-1 text-xs text-gray-400">
                                — {v.source}
                              </span>
                            )}
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : null}
            </div>
          )}
        </div>
      );
    });
  };

  // 打开参考视频：带 app deep link 的（抖音）在移动端先尝试唤起 App，
  // 约 1.5s 内页面仍可见（说明没跳过去）则回退到移动端搜索页
  const openVideo = (v: { url: string; app?: string }) => {
    if (!v.app) {
      window.open(v.url, "_blank", "noopener");
      return;
    }
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    if (!isMobile) {
      window.open(v.url, "_blank", "noopener");
      return;
    }
    const start = Date.now();
    const timer = setTimeout(() => {
      if (!document.hidden && Date.now() - start < 2500) {
        window.location.href = v.url;
      }
    }, 1500);
    document.addEventListener("visibilitychange", () => clearTimeout(timer), {
      once: true,
    });
    window.location.href = v.app;
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

      {/* 删除自定义领域二次确认 */}
      {pendingDeleteDomain && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setPendingDeleteDomain(null)}
          />
          <div className="relative z-10 w-full max-w-xs bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="space-y-1">
              <div className="font-bold text-gray-800">删除自定义领域</div>
              <p className="text-sm text-gray-500 leading-relaxed">
                确定删除「
                <span className="text-gray-700">{pendingDeleteDomain}</span>
                」吗？
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPendingDeleteDomain(null)}
                className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
              >
                取消
              </button>
              <button
                onClick={() => deleteDomain(pendingDeleteDomain)}
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
      <header className="bg-white border-b px-4 py-3 shadow-sm space-y-2 shrink-0 pt-[max(0.75rem,env(safe-area-inset-top))]">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              onClick={() => setSidebarOpen(true)}
              className="text-gray-500 hover:text-indigo-600 transition text-lg leading-none px-1 shrink-0"
              title="会话列表"
            >
              ☰
            </button>
            <span className="text-base sm:text-lg font-bold text-indigo-600 whitespace-nowrap">
              <span className="hidden sm:inline">🔥 </span>热点抓取 Agent
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* 顶部选择区滚出视野后：领域 / 平台 收成下拉入口 */}
            {!selectorsVisible && (
              <>
                {/* PC：两个下拉，带数字 */}
                <div className="hidden sm:flex items-center gap-1.5 min-w-0">
                  <div className="relative">
                    <button
                      onClick={() =>
                        setOpenMenu(openMenu === "domain" ? null : "domain")
                      }
                      className={`text-xs border rounded-full px-2.5 py-1 whitespace-nowrap transition ${
                        openMenu === "domain"
                          ? "border-emerald-400 text-emerald-600 bg-emerald-50"
                          : "border-gray-300 text-gray-500 hover:border-emerald-300"
                      }`}
                    >
                      领域 {selectedDomains.length}/{domainOptions.length} ▾
                    </button>
                    {openMenu === "domain" && (
                      <div className="absolute right-0 top-full mt-2 z-30 w-72 max-w-[80vw] bg-white border rounded-xl shadow-lg p-3">
                        {renderDomainHeader()}
                        {renderDomainChips(true)}
                      </div>
                    )}
                  </div>
                  <div className="relative">
                    <button
                      onClick={() =>
                        setOpenMenu(openMenu === "platform" ? null : "platform")
                      }
                      className={`text-xs border rounded-full px-2.5 py-1 whitespace-nowrap transition ${
                        openMenu === "platform"
                          ? "border-indigo-400 text-indigo-600 bg-indigo-50"
                          : "border-gray-300 text-gray-500 hover:border-indigo-300"
                      }`}
                    >
                      平台 {selectedPlatforms.length}/{PLATFORMS.length} ▾
                    </button>
                    {openMenu === "platform" && (
                      <div className="absolute right-0 top-full mt-2 z-30 w-72 max-w-[80vw] bg-white border rounded-xl shadow-lg p-3">
                        {renderPlatformHeader()}
                        {renderPlatformChips()}
                      </div>
                    )}
                  </div>
                </div>

                {/* 移动端：一个合并下拉，不显示数字 */}
                <div className="relative flex sm:hidden min-w-0">
                  <button
                    onClick={() =>
                      setOpenMenu(openMenu === "both" ? null : "both")
                    }
                    className={`text-xs border rounded-full px-2.5 py-1 whitespace-nowrap transition ${
                      openMenu === "both"
                        ? "border-indigo-400 text-indigo-600 bg-indigo-50"
                        : "border-gray-300 text-gray-500 hover:border-indigo-300"
                    }`}
                  >
                    领域 / 平台 ▾
                  </button>
                  {openMenu === "both" && (
                    <div className="fixed left-3 right-3 top-[calc(env(safe-area-inset-top)+3.5rem)] z-30 bg-white border rounded-xl shadow-lg p-3 space-y-3">
                      <div>
                        {renderDomainHeader()}
                        {renderDomainChips(true)}
                      </div>
                      <div className="border-t pt-3">
                        {renderPlatformHeader()}
                        {renderPlatformChips()}
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
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
          </div>
        </div>
      </header>

      {/* 下拉菜单点击外部关闭 */}
      {openMenu && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => setOpenMenu(null)}
        />
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="max-w-[57.6rem] mx-auto w-full space-y-4">
          {/* 顶部完整选择区：滚出视野后才在标题栏出现下拉入口 */}
          <div ref={selectorsRef} className="space-y-2">
            <div>
              {renderDomainHeader()}
              {renderDomainChips(selectorsVisible)}
            </div>
            <div>
              {renderPlatformHeader()}
              {renderPlatformChips()}
            </div>
          </div>
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                  msg.role === "user"
                    ? "max-w-[85%] bg-indigo-500 text-white"
                    : msg.content === WELCOME.content
                    ? "max-w-[85%] bg-white text-gray-800 shadow-sm border"
                    : "w-full bg-white text-gray-800 shadow-sm border"
                }`}
              >
                {msg.toolLogs && msg.toolLogs.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5 border-b pb-2">
                    {msg.toolLogs.map((log, j) => (
                      <span
                        key={j}
                        className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-500 text-xs px-2.5 py-0.5 border border-gray-200"
                      >
                        🔧 {log}
                      </span>
                    ))}
                  </div>
                )}
                {msg.role === "assistant" && msg.content !== WELCOME.content
                  ? renderAssistantContent(msg.content, i)
                  : msg.content}
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-end">
              <div className="bg-white rounded-2xl px-4 py-3 text-sm text-gray-400 shadow-sm border">
                思考中...
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Quick Actions：每次新对话/重新打开都常驻，方便一键发送常用指令 */}
      <div className="px-4 pb-2">
        <div className="max-w-[57.6rem] mx-auto w-full flex flex-wrap gap-2">
          {[
            { label: "帮我抓取今日热点", prompt: "帮我抓取今日热点", send: true },
            { label: "根据领域筛选热点", prompt: "根据XX领域筛选热点", send: false },
            { label: "帮我生成视频脚本", prompt: "帮我生成视频脚本", send: true },
          ].map((q) => (
            <button
              key={q.label}
              disabled={loading}
              onClick={() => {
                if (q.send) {
                  sendMessage(q.prompt);
                } else {
                  setInput(q.prompt);
                  inputRef.current?.focus();
                }
              }}
              className="text-xs bg-indigo-50 text-indigo-600 px-3 py-1.5 rounded-full hover:bg-indigo-100 transition disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {q.label}
            </button>
          ))}
        </div>
      </div>

      {/* Input */}
      <div className="border-t bg-white px-4 py-3 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="flex gap-2 max-w-[57.6rem] mx-auto">
          <input
            ref={inputRef}
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
