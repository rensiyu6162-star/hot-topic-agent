"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolLogs?: string[];
  emptyNote?: string;
  domains?: string[]; // 该条用户消息发送时锁定的领域（用于在气泡上直观显示本轮生效领域）
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
  error?: boolean;
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

// 领域最多同时选中的数量：选满后再点会弹窗让用户挑一个替换
const MAX_DOMAINS = 3;

export default function Home() {
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([...PLATFORMS]);
  const [domainOptions, setDomainOptions] = useState<string[]>([...DOMAINS]);
  // 默认什么都不选中 → 单纯呈现所有平台 top 热点（保留热点标签，不做领域分类筛选）
  const [selectedDomains, setSelectedDomains] = useState<string[]>([]);
  // 选满 MAX_DOMAINS 后再点的那个领域，暂存于此并弹出「替换哪个」弹窗；null=未触发
  const [replaceCandidate, setReplaceCandidate] = useState<string | null>(null);
  const [showDomainInput, setShowDomainInput] = useState(false);
  const [domainInput, setDomainInput] = useState("");
  // 添加/编辑领域时填写的释义（含义说明），传给后端做精确判定
  const [noteInput, setNoteInput] = useState("");
  // 正在编辑的自创领域名（null 表示当前是「新增」而非「编辑」）
  const [editingDomain, setEditingDomain] = useState<string | null>(null);
  // 点击「确认」后模型识别出的候选释义列表
  const [meaningOptions, setMeaningOptions] = useState<string[]>([]);
  // 是否正在请求候选释义
  const [meaningLoading, setMeaningLoading] = useState(false);
  // 已点过「确认」（用于控制界面进入第二步展示候选释义）
  const [meaningConfirmed, setMeaningConfirmed] = useState(false);
  // 记录上一次「确认」时的名称，名称变化后需要重新确认
  const [meaningForName, setMeaningForName] = useState("");
  // 每个自创领域对应的释义：{ 领域名: 释义 }
  const [domainNotes, setDomainNotes] = useState<Record<string, string>>({});
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
  // 隐藏设备标识：首次访问自动生成并存本地，仅用于「定时任务」在服务端认领任务、静默回传结果。
  // 未启用同步码时，定时任务就用它当身份；用户无感，界面不出现。
  const [deviceId, setDeviceId] = useState("");
  const [showSync, setShowSync] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [syncBusy, setSyncBusy] = useState(false);
  const [syncMsg, setSyncMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<number>(0);
  const [copied, setCopied] = useState(false);
  // 每条热点的「查看详情」展开状态（key = 消息序号:行号）
  const [details, setDetails] = useState<Record<string, DetailState>>({});
  // 消息多选删除：长按(移动端)/悬浮工具栏删除按钮(桌面端) 唤起编辑态，勾选后统一删除
  const [selectMode, setSelectMode] = useState(false);
  const [selectedMsgs, setSelectedMsgs] = useState<number[]>([]);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  // 设置菜单（同步 / 定时任务）
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);
  const [schedEnabled, setSchedEnabled] = useState(true);
  const [schedEveryDays, setSchedEveryDays] = useState(1);
  const [schedTimes, setSchedTimes] = useState<string[]>(["09:00"]);
  // 开始日期默认当天，结束日期选填（空=一直执行）
  const [schedStartDate, setSchedStartDate] = useState("");
  const [schedEndDate, setSchedEndDate] = useState("");
  // 结束日期为空时展示「永久运行」占位，点击后切换为原生日期选择器
  const [schedEndEditing, setSchedEndEditing] = useState(false);
  // 是否处于可编辑状态：已保存过配置时先进入只读态（按钮显示「编辑」），点编辑后才可改
  const [schedEditMode, setSchedEditMode] = useState(true);
  // 定时任务专属的领域 / 平台选择（与主页面互不影响；打开时默认填充主页面当前选择）
  const [schedDomains, setSchedDomains] = useState<string[]>([]);
  const [schedPlatforms, setSchedPlatforms] = useState<string[]>([]);
  // 定时任务里领域选满 MAX_DOMAINS 后再点触发的「替换哪个」弹窗
  const [schedReplaceCandidate, setSchedReplaceCandidate] = useState<string | null>(null);
  const [schedBusy, setSchedBusy] = useState(false);
  const [schedMsg, setSchedMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [schedLoaded, setSchedLoaded] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      const savedNotes = localStorage.getItem("domainNotes");
      if (savedOptions) setDomainOptions(JSON.parse(savedOptions));
      if (savedSelected) {
        const arr = JSON.parse(savedSelected);
        // 兼容旧数据：以前可能存了全选(8个)，现在上限是 MAX_DOMAINS，超出则截断
        if (Array.isArray(arr)) setSelectedDomains(arr.slice(0, MAX_DOMAINS));
      }
      if (savedNotes) setDomainNotes(JSON.parse(savedNotes));

      const savedCode = localStorage.getItem("syncCode");
      if (savedCode) setSyncCode(savedCode);

      // 隐藏设备标识：没有就生成一个（复用同步码格式，满足服务端 code 校验）
      let dev = localStorage.getItem("deviceId");
      if (!dev) {
        dev = genSyncCode();
        try {
          localStorage.setItem("deviceId", dev);
        } catch {}
      }
      setDeviceId(dev);

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

  // 领域设置变化时持久化（轻量：只序列化领域相关数据，不碰 sessions）
  // 拆分出来是为了让“领域切换”这类高频操作不再同步序列化整个会话历史，
  // 否则每点一个领域芯片都会 JSON.stringify(sessions) 卡住主线程 → 切换迟钝。
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("domainOptions", JSON.stringify(domainOptions));
      localStorage.setItem("selectedDomains", JSON.stringify(selectedDomains));
      localStorage.setItem("domainNotes", JSON.stringify(domainNotes));
    } catch {}
  }, [hydrated, domainOptions, selectedDomains, domainNotes]);

  // 会话变化时才持久化 sessions（重数据单独一个 effect）
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem("sessions", JSON.stringify(sessions));
      localStorage.setItem("activeSessionId", activeId);
    } catch {}
  }, [hydrated, sessions, activeId]);

  // ===== 跨设备同步 =====
  const buildPayload = () => ({
    sessions,
    activeId,
    domainOptions,
    selectedDomains,
    domainNotes,
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
    if (p.domainNotes && typeof p.domainNotes === "object")
      setDomainNotes(p.domainNotes);
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

  // 定时任务身份：优先用同步码（有则结果并入同步数据、可跨设备），否则用隐藏设备标识（无感、仅本设备）
  const scheduleCode = syncCode || deviceId;

  // 仅拉取并合并「⏰ 定时任务」专属会话，不动其它会话/领域设置（供无同步码时静默回传结果用）
  const pullScheduled = async (code: string) => {
    if (!code) return;
    try {
      const res = await fetch(`/api/sync?code=${encodeURIComponent(code)}`);
      if (!res.ok) return;
      const data = await res.json();
      const p = data?.payload;
      const cloudSessions = Array.isArray(p?.sessions) ? p.sessions : [];
      const sched = cloudSessions.find((s: any) => s?.id === "scheduled");
      if (!sched) return;
      skipPush.current = true; // 合并云端定时结果后不要立刻回推
      setSessions((prev) => {
        const others = prev.filter((s) => s.id !== "scheduled");
        return [sched, ...others]; // 定时会话置顶，其余保持不动
      });
    } catch {}
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

  // ===== 定时任务 =====
  // 本地今天（YYYY-MM-DD），用于开始日期默认填充
  const todayStr = () => {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${mm}-${dd}`;
  };

  // 定时任务里的领域选择：逻辑与主页面 toggleDomain 完全一致（上限 MAX_DOMAINS，选满再点弹替换）
  const toggleSchedDomain = (d: string) => {
    if (schedDomains.includes(d)) {
      setSchedDomains((prev) => prev.filter((x) => x !== d));
      return;
    }
    if (schedDomains.length >= MAX_DOMAINS) {
      setSchedReplaceCandidate(d);
      return;
    }
    setSchedDomains((prev) => [...prev, d]);
  };
  const confirmSchedReplaceDomain = (victim: string) => {
    if (!schedReplaceCandidate) return;
    setSchedDomains((prev) =>
      prev.map((x) => (x === victim ? schedReplaceCandidate : x))
    );
    setSchedReplaceCandidate(null);
  };
  const toggleSchedPlatform = (p: string) => {
    setSchedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  // 与 sendMessage 保持一致地构造领域/平台/释义快照，供服务端定时抓取复用
  const buildScheduleSnapshot = () => {
    // 与主页面一致：空选=不锁定领域(呈现全部热点)，选了才逐个过滤
    const domain = schedDomains.length === 0 ? "" : schedDomains.join("、");
    const glossary: Record<string, string> = {};
    for (const d of schedDomains) {
      const note = domainNotes[d];
      if (note && note.trim()) glossary[d] = note.trim();
    }
    return {
      domain,
      platforms: schedPlatforms,
      glossary,
      allDomains: domainOptions,
    };
  };

  const openSchedule = async () => {
    setSettingsOpen(false);
    setSchedMsg(null);
    setSchedReplaceCandidate(null);
    setShowSchedule(true);
    // 默认填充：开始日期=今天、结束日期=空、领域/平台=主页面当前选择
    setSchedStartDate(todayStr());
    setSchedEndDate("");
    setSchedEndEditing(false);
    setSchedTimes(["09:00"]);
    setSchedDomains([...selectedDomains].slice(0, MAX_DOMAINS));
    setSchedPlatforms([...selectedPlatforms]);
    // 没有同步码 = 全新配置，直接可编辑
    setSchedEditMode(true);
    if (!scheduleCode) return;
    setSchedLoaded(false);
    try {
      const res = await fetch(`/api/schedule?code=${encodeURIComponent(scheduleCode)}`);
      const data = await res.json();
      if (res.ok && data.config) {
        const cfg = data.config;
        setSchedEnabled(cfg.enabled !== false);
        setSchedEveryDays(cfg.everyDays || 1);
        setSchedTimes(
          Array.isArray(cfg.times) && cfg.times.length
            ? cfg.times
            : ["09:00"]
        );
        // 已有配置：回显开始/结束日期与领域/平台
        setSchedStartDate(cfg.anchor || todayStr());
        setSchedEndDate(cfg.endDate || "");
        setSchedEndEditing(false);
        // 已存在配置 → 先进入只读态，按钮显示「编辑」
        setSchedEditMode(false);
        const snap = cfg.snapshot || {};
        setSchedDomains(
          typeof snap.domain === "string" && snap.domain
            ? snap.domain.split("、").filter(Boolean).slice(0, MAX_DOMAINS)
            : []
        );
        setSchedPlatforms(
          Array.isArray(snap.platforms) ? snap.platforms : [...selectedPlatforms]
        );
      }
    } catch {}
    setSchedLoaded(true);
  };

  const saveSchedule = async () => {
    if (!scheduleCode) return;
    const times = Array.from(new Set(schedTimes.filter((t) => /^\d{1,2}:\d{2}$/.test(t)))).slice(0, 3);
    if (times.length === 0) {
      setSchedMsg({ ok: false, text: "至少配置一个触发时间" });
      return;
    }
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(schedStartDate)
      ? schedStartDate
      : todayStr();
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(schedEndDate) ? schedEndDate : "";
    if (endDate && endDate < startDate) {
      setSchedMsg({ ok: false, text: "结束日期不能早于开始日期" });
      return;
    }
    if (schedPlatforms.length === 0) {
      setSchedMsg({ ok: false, text: "至少选择一个抓取平台" });
      return;
    }
    setSchedBusy(true);
    setSchedMsg(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: scheduleCode,
          enabled: schedEnabled,
          everyDays: schedEveryDays,
          times,
          startDate,
          endDate,
          snapshot: buildScheduleSnapshot(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        const rangeText = endDate
          ? `${startDate} 起至 ${endDate}`
          : `${startDate} 起长期执行`;
        setSchedMsg({
          ok: true,
          text: schedEnabled
            ? `已保存：${rangeText}，每 ${schedEveryDays} 天于 ${times.join("、")} 自动抓取热点，结果会自动回到本设备`
            : "已保存（定时任务已停用）",
        });
        // 保存成功后自动关闭弹窗（稍留时间让用户看到提示）
        setTimeout(() => setShowSchedule(false), 900);
      } else {
        setSchedMsg({ ok: false, text: data.error || "保存失败" });
      }
    } catch (e: any) {
      setSchedMsg({ ok: false, text: `保存失败：${e.message}` });
    } finally {
      setSchedBusy(false);
    }
  };

  const deleteScheduleCfg = async () => {
    if (!scheduleCode) return;
    setSchedBusy(true);
    setSchedMsg(null);
    try {
      const res = await fetch("/api/schedule", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: scheduleCode }),
      });
      if (res.ok) {
        // 回到弹窗初始态（与首次打开一致）
        setSchedEnabled(true);
        setSchedEveryDays(1);
        setSchedTimes(["09:00"]);
        setSchedStartDate(todayStr());
        setSchedEndDate("");
        setSchedEndEditing(false);
        setSchedEditMode(true);
        setSchedReplaceCandidate(null);
        setSchedDomains([...selectedDomains].slice(0, MAX_DOMAINS));
        setSchedPlatforms([...selectedPlatforms]);
        setSchedMsg({ ok: true, text: "已删除定时任务" });
      } else {
        const data = await res.json();
        setSchedMsg({ ok: false, text: data.error || "删除失败" });
      }
    } catch (e: any) {
      setSchedMsg({ ok: false, text: `删除失败：${e.message}` });
    } finally {
      setSchedBusy(false);
    }
  };


  // 首次加载后：已绑定同步码则拉全量云端数据（含定时结果）；否则用隐藏设备标识静默拉回定时结果
  useEffect(() => {
    if (!hydrated) return;
    if (syncCode) pullSync(syncCode, true);
    else if (deviceId) pullScheduled(deviceId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, deviceId]);

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
  }, [sessions, domainOptions, selectedDomains, domainNotes, activeId, syncCode, hydrated]);

  const togglePlatform = (p: string) => {
    setSelectedPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]
    );
  };

  const toggleDomain = (d: string) => {
    // 已选中 → 取消选中
    if (selectedDomains.includes(d)) {
      setSelectedDomains((prev) => prev.filter((x) => x !== d));
      return;
    }
    // 未选中且已选满上限 → 弹窗让用户挑一个替换
    if (selectedDomains.length >= MAX_DOMAINS) {
      setReplaceCandidate(d);
      return;
    }
    // 未选满 → 直接加入
    setSelectedDomains((prev) => [...prev, d]);
  };

  // 在「替换哪个」弹窗里点选某个已选领域：用 replaceCandidate 顶掉它
  const confirmReplaceDomain = (victim: string) => {
    if (!replaceCandidate) return;
    setSelectedDomains((prev) =>
      prev.map((x) => (x === victim ? replaceCandidate : x))
    );
    setReplaceCandidate(null);
  };

  const clearDomains = () => setSelectedDomains([]);
  const selectAllPlatforms = () => setSelectedPlatforms([...PLATFORMS]);
  const clearPlatforms = () => setSelectedPlatforms([]);

  // 打开「新增领域」弹窗
  const openAddDomain = () => {
    setEditingDomain(null);
    setDomainInput("");
    setNoteInput("");
    resetMeaning();
    setShowDomainInput(true);
  };

  // 打开「编辑领域」弹窗，回显名称与释义
  const openEditDomain = (d: string) => {
    setEditingDomain(d);
    setDomainInput(d);
    setNoteInput(domainNotes[d] || "");
    resetMeaning();
    setShowDomainInput(true);
  };

  const closeDomainInput = () => {
    setShowDomainInput(false);
    setEditingDomain(null);
    setDomainInput("");
    setNoteInput("");
    resetMeaning();
  };

  // 清空候选释义相关状态
  const resetMeaning = () => {
    setMeaningOptions([]);
    setMeaningLoading(false);
    setMeaningConfirmed(false);
    setMeaningForName("");
  };

  // 点击「确认」：让模型识别领域含义并给出候选释义
  const confirmDomainMeaning = async () => {
    const name = domainInput.trim();
    if (!name) return;
    setMeaningConfirmed(true);
    setMeaningForName(name);
    setMeaningLoading(true);
    setMeaningOptions([]);
    try {
      const resp = await fetch("/api/domain-meaning", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await resp.json();
      setMeaningOptions(Array.isArray(data?.options) ? data.options : []);
    } catch {
      setMeaningOptions([]);
    } finally {
      setMeaningLoading(false);
    }
  };

  // 保存领域（新增或编辑）：名称必填，释义可选
  const saveDomain = () => {
    const name = domainInput.trim();
    const note = noteInput.trim();
    if (!name) {
      closeDomainInput();
      return;
    }
    const old = editingDomain;
    if (old && old !== name) {
      // 编辑时改了名字：在选项/已选里替换旧名，并迁移释义
      setDomainOptions((prev) =>
        prev.map((x) => (x === old ? name : x)).filter((x, i, a) => a.indexOf(x) === i)
      );
      setSelectedDomains((prev) =>
        prev.includes(old)
          ? prev.map((x) => (x === old ? name : x)).filter((x, i, a) => a.indexOf(x) === i)
          : prev
      );
      setDomainNotes((prev) => {
        const next = { ...prev };
        delete next[old];
        if (note) next[name] = note;
        return next;
      });
    } else {
      // 新增，或编辑时名字没变
      setDomainOptions((prev) => (prev.includes(name) ? prev : [...prev, name]));
      setSelectedDomains((prev) => (prev.includes(name) ? prev : [...prev, name]));
      setDomainNotes((prev) => {
        const next = { ...prev };
        if (note) next[name] = note;
        else delete next[name];
        return next;
      });
    }
    closeDomainInput();
  };

  const deleteDomain = (d: string) => {
    setDomainOptions((prev) => prev.filter((x) => x !== d));
    setSelectedDomains((prev) => prev.filter((x) => x !== d));
    setDomainNotes((prev) => {
      const next = { ...prev };
      delete next[d];
      return next;
    });
    setPendingDeleteDomain(null);
    // 若正在编辑的就是被删的领域，一并关闭弹窗
    if (editingDomain === d) closeDomainInput();
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

    // 本轮生效的领域：
    // - 空选（默认）→ 不锁定领域，单纯呈现所有平台 top 热点（后端仍会打热点标签）
    // - 选了 1~MAX_DOMAINS 个 → 把所选领域【逐个】传给后端，按领域过滤 + 近30天兜底
    const domainStr = selectedDomains.join("、");
    // 气泡标注：空选时不标（就是全部热点），选了才逐个标注
    const stampDomains = [...selectedDomains];

    const userMsg: Message = {
      role: "user",
      content: msg,
      domains: stampDomains.length > 0 ? stampDomains : undefined,
    };
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

    // 把用户为(生效)自创领域填写的释义一并传给后端，用于精确判定
    const glossary: Record<string, string> = {};
    for (const d of selectedDomains) {
      const note = domainNotes[d];
      if (note && note.trim()) glossary[d] = note.trim();
    }

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
          glossary,
          allDomains: domainOptions,
        }),
      });
      const data = await res.json();
      setActiveMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.content || "抱歉，出了点问题。",
          toolLogs: data.toolLogs,
          emptyNote: data.emptyNote || undefined,
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
    void autoFocusInput;
    // 选中的领域前置、未选的沉到后面；各组内部保持 domainOptions 原始顺序（组内稳定，避免同组乱跳）。
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
              title={domainNotes[d] || undefined}
              className={`px-3 py-1 rounded-full text-xs border transition flex items-center gap-1 ${
                active
                  ? "bg-emerald-500 text-white border-emerald-500"
                  : "bg-white text-gray-500 border-gray-300 hover:border-emerald-300"
              }`}
            >
              <span>{d}</span>
              {custom && (
                <span
                  role="button"
                  title="编辑自定义领域"
                  onClick={(e) => {
                    e.stopPropagation();
                    openEditDomain(d);
                  }}
                  className={`ml-0.5 leading-none ${
                    active
                      ? "text-white/80 hover:text-white"
                      : "text-gray-400 hover:text-emerald-500"
                  }`}
                >
                  ✎
                </span>
              )}
            </button>
          );
        })}
        <button
          onClick={openAddDomain}
          className="px-3 py-1 rounded-full text-xs border border-dashed border-gray-400 text-gray-500 hover:border-emerald-400 hover:text-emerald-500 transition"
        >
          ＋ 添加
        </button>
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

  // 区块标题（左侧标签 + 右上角 清空）。领域最多选 MAX_DOMAINS 个，故不再提供「全选」
  const renderDomainHeader = () => (
    <div className="flex items-center justify-between mb-2">
      <span className="text-xs text-gray-400">
        关注领域<span className="text-gray-300">（不选=全部热点，最多选 {MAX_DOMAINS} 个）</span>
      </span>
      <div className="flex items-center gap-2">
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

  // 点击「查看详情」：首次拉取详情并展开，之后仅切换展开/收起（失败态也可正常展开收起，重试走独立按钮）
  const toggleDetail = async (key: string, topic: string, platform = "") => {
    const cur = details[key];
    if (cur && cur.data) {
      setDetails((p) => ({ ...p, [key]: { ...cur, open: !cur.open } }));
      return;
    }
    if (cur && cur.loading) return;
    await loadDetail(key, topic, platform);
  };

  // 实际拉取详情（首次点击与「重试」共用）：失败时置 error 标记，供 UI 显示重试按钮
  const loadDetail = async (key: string, topic: string, platform = "") => {
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
      // 服务端 500 或返回"详情获取失败…"这类兜底文案，同样按失败处理，展示重试按钮
      const failed =
        !res.ok || /^详情获取失败/.test((data?.report || "").trim());
      setDetails((p) => ({
        ...p,
        [key]: { open: true, loading: false, data, error: failed },
      }));
    } catch {
      setDetails((p) => ({
        ...p,
        [key]: {
          open: true,
          loading: false,
          data: { report: "详情获取失败，请稍后重试。", sites: [], videos: [] },
          error: true,
        },
      }));
    }
  };

  // ========== 消息多选删除 ==========
  const isWelcomeMsg = (i: number) => messages[i]?.content === WELCOME.content;

  // 触发删除的那条，连同配对的问/答一起自动选中：
  // 点在「回答」上→带上上一条「提问」；点在「提问」上→带上下一条「回答」。欢迎语不参与。
  const pairIndicesFor = (i: number): number[] => {
    const msg = messages[i];
    if (!msg) return [];
    const res = [i];
    if (msg.role === "assistant") {
      if (i - 1 >= 0 && messages[i - 1].role === "user") res.push(i - 1);
    } else if (i + 1 < messages.length && messages[i + 1].role === "assistant") {
      res.push(i + 1);
    }
    return res.filter((idx) => !isWelcomeMsg(idx));
  };

  const enterSelectMode = (i: number) => {
    setSelectMode(true);
    setSelectedMsgs(pairIndicesFor(i));
  };

  const toggleSelect = (i: number) => {
    if (isWelcomeMsg(i)) return;
    setSelectedMsgs((prev) =>
      prev.includes(i) ? prev.filter((x) => x !== i) : [...prev, i]
    );
  };

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedMsgs([]);
  };

  const deleteSelected = () => {
    if (selectedMsgs.length === 0) return;
    const del = new Set(selectedMsgs);
    setActiveMessages((prev) => prev.filter((_, idx) => !del.has(idx)));
    setDetails({}); // 删除后序号会平移，清空详情缓存避免 key 错位
    exitSelectMode();
  };

  const copyMessage = async (content: string, idx: number) => {
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(content);
        ok = true;
      }
    } catch {}
    if (!ok) {
      // 回退：非安全上下文(如 http://IP)下 navigator.clipboard 不可用，用临时 textarea + execCommand
      try {
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {}
    }
    if (ok) {
      setCopiedIdx(idx);
      setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1500);
    }
  };

  // 移动端长按唤起编辑态（500ms）；滑动/松手则取消计时
  const startLongPress = (i: number) => {
    if (isWelcomeMsg(i) || selectMode) return;
    longPressTimer.current = setTimeout(() => enterSelectMode(i), 500);
  };
  const cancelLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
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
              className={`align-middle ml-2 whitespace-nowrap text-[11px] leading-none px-2 py-1 rounded-full border transition ${
                st
                  ? "opacity-100 border-emerald-300 text-emerald-600 hover:bg-emerald-50"
                  : "border-indigo-300 text-indigo-500 hover:bg-indigo-50 opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              }`}
            >
              {st?.open ? "收起" : st ? "展开" : "查看详情"}
            </button>
          </div>
          {st?.open && (
            <div className="mt-2 mb-2 rounded-xl bg-gray-50 border border-gray-200 p-3 text-xs text-gray-600 space-y-3">
              {st.loading ? (
                <div className="text-gray-400">正在生成详情…</div>
              ) : st.error ? (
                <div className="flex items-center gap-3">
                  <span className="text-gray-500">
                    {cleanMarkdown(st.data?.report || "详情获取失败，请稍后重试。")}
                  </span>
                  <button
                    onClick={() => loadDetail(key, topic, platform)}
                    className="whitespace-nowrap text-[11px] leading-none px-2 py-1 rounded-full border border-indigo-300 text-indigo-500 hover:bg-indigo-50 transition"
                  >
                    ↻ 刷新重试
                  </button>
                </div>
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

      {/* 添加 / 编辑自定义领域 */}
      {replaceCandidate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setReplaceCandidate(null)}
          />
          <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="font-bold text-gray-800">最多选 {MAX_DOMAINS} 个领域</div>
            <p className="text-sm text-gray-500">
              已选满 {MAX_DOMAINS} 个。要把
              <span className="mx-1 font-medium text-emerald-600">{replaceCandidate}</span>
              替换掉下面哪一个？
            </p>
            <div className="flex flex-col gap-2">
              {selectedDomains.map((d) => (
                <button
                  key={d}
                  onClick={() => confirmReplaceDomain(d)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-emerald-400 hover:bg-emerald-50 transition text-left"
                >
                  替换「{d}」
                </button>
              ))}
            </div>
            <button
              onClick={() => setReplaceCandidate(null)}
              className="w-full px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-600 transition"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {schedReplaceCandidate && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setSchedReplaceCandidate(null)}
          />
          <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="font-bold text-gray-800">最多选 {MAX_DOMAINS} 个领域</div>
            <p className="text-sm text-gray-500">
              已选满 {MAX_DOMAINS} 个。要把
              <span className="mx-1 font-medium text-emerald-600">{schedReplaceCandidate}</span>
              替换掉下面哪一个？
            </p>
            <div className="flex flex-col gap-2">
              {schedDomains.map((d) => (
                <button
                  key={d}
                  onClick={() => confirmSchedReplaceDomain(d)}
                  className="w-full px-3 py-2 rounded-lg border border-gray-200 text-sm text-gray-700 hover:border-emerald-400 hover:bg-emerald-50 transition text-left"
                >
                  替换「{d}」
                </button>
              ))}
            </div>
            <button
              onClick={() => setSchedReplaceCandidate(null)}
              className="w-full px-3 py-2 rounded-lg text-sm text-gray-400 hover:text-gray-600 transition"
            >
              取消
            </button>
          </div>
        </div>
      )}


      {showDomainInput && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={closeDomainInput}
          />
          <div className="relative z-10 w-full max-w-sm bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="font-bold text-gray-800">
              {editingDomain ? "编辑领域" : "添加领域"}
            </div>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-xs text-gray-400">领域名称</label>
                <div className="flex gap-2">
                  <input
                    autoFocus
                    value={domainInput}
                    onChange={(e) => {
                      setDomainInput(e.target.value);
                      // 名称变化后需要重新确认
                      if (e.target.value.trim() !== meaningForName) {
                        setMeaningConfirmed(false);
                        setMeaningOptions([]);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmDomainMeaning();
                      if (e.key === "Escape") closeDomainInput();
                    }}
                    placeholder="例如：反bl"
                    className="flex-1 px-3 py-2 rounded-lg text-sm border border-gray-300 focus:outline-none focus:ring-1 focus:ring-emerald-400"
                  />
                  <button
                    onClick={confirmDomainMeaning}
                    disabled={!domainInput.trim() || meaningLoading}
                    className="shrink-0 text-sm px-3 py-2 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {meaningLoading ? "识别中…" : "确认"}
                  </button>
                </div>
                <p className="text-[11px] text-gray-400">
                  点「确认」让模型识别含义，给出可选释义（也可自己填写，释义可选）
                </p>
              </div>

              {/* 第二步：模型给出的候选释义 */}
              {meaningConfirmed && (
                <div className="space-y-1.5">
                  <label className="text-xs text-gray-400">可选释义</label>
                  {meaningLoading ? (
                    <div className="text-xs text-gray-400 py-1">正在识别「{domainInput.trim()}」的含义…</div>
                  ) : meaningOptions.length > 0 ? (
                    <div className="flex flex-col gap-1.5">
                      {meaningOptions.map((opt, i) => {
                        const active = noteInput.trim() === opt;
                        return (
                          <button
                            key={i}
                            onClick={() => setNoteInput(opt)}
                            className={
                              "text-left text-xs px-3 py-2 rounded-lg border transition " +
                              (active
                                ? "border-emerald-400 bg-emerald-50 text-emerald-700"
                                : "border-gray-200 text-gray-600 hover:border-emerald-300 hover:bg-emerald-50/40")
                            }
                          >
                            {opt}
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-400 py-1">没有识别到合适的释义，可在下方自行填写。</div>
                  )}
                </div>
              )}

              <div className="space-y-1">
                <label className="text-xs text-gray-400">
                  释义（可选，帮助更精准地判断该领域）
                </label>
                <textarea
                  value={noteInput}
                  onChange={(e) => setNoteInput(e.target.value)}
                  rows={3}
                  placeholder="用一两句话说明这个领域具体指什么，避免被泛化误判"
                  className="w-full px-3 py-2 rounded-lg text-sm border border-gray-300 focus:outline-none focus:ring-1 focus:ring-emerald-400 resize-none"
                />
              </div>
            </div>
            <div className="flex justify-between items-center">
              {editingDomain ? (
                <button
                  onClick={() => setPendingDeleteDomain(editingDomain)}
                  className="text-sm px-3 py-1.5 rounded-lg border border-red-300 text-red-500 hover:bg-red-50 transition"
                >
                  删除
                </button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <button
                  onClick={closeDomainInput}
                  className="text-sm px-3 py-1.5 rounded-lg border text-gray-600 hover:bg-gray-50 transition"
                >
                  取消
                </button>
                <button
                  onClick={saveDomain}
                  className="text-sm px-3 py-1.5 rounded-lg bg-emerald-500 text-white hover:bg-emerald-600 transition"
                >
                  保存
                </button>
              </div>
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

      {/* 定时任务配置弹窗 */}
      {showSchedule && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowSchedule(false)}
          />
          <div className="relative z-10 w-full max-w-md bg-white rounded-2xl shadow-xl p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4">
                <span className="font-bold text-gray-800">⏰ 定时任务</span>
                <label className="flex items-center gap-1.5 text-sm text-gray-700 font-normal">
                  <input
                    type="checkbox"
                    checked={schedEnabled}
                    disabled={!schedEditMode}
                    onChange={(e) => setSchedEnabled(e.target.checked)}
                    className="w-4 h-4 disabled:opacity-70"
                  />
                  启用
                </label>
              </div>
              <button
                onClick={() => setShowSchedule(false)}
                className="text-gray-400 hover:text-gray-600 text-lg leading-none"
              >
                ✕
              </button>
            </div>

            {(
              <div className="space-y-4">
                <div
                  className={`space-y-4 transition ${
                    !schedEnabled
                      ? "opacity-40 pointer-events-none grayscale"
                      : !schedEditMode
                      ? "pointer-events-none [&_input]:opacity-50 [&_select]:opacity-50 [&_button]:opacity-50"
                      : ""
                  }`}
                >
                  <div className="space-y-2 text-sm text-gray-700">
                  <div className="flex items-center gap-2">
                    <span>开始日期</span>
                    <input
                      type="date"
                      value={schedStartDate}
                      onChange={(e) => setSchedStartDate(e.target.value)}
                      className="border rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <span>结束日期</span>
                    <input
                      type={schedEndDate ? "date" : "text"}
                      value={schedEndDate}
                      min={schedStartDate || undefined}
                      placeholder="永久运行"
                      onFocus={(e) => {
                        e.currentTarget.type = "date";
                        try {
                          (e.currentTarget as any).showPicker?.();
                        } catch {}
                      }}
                      onBlur={(e) => {
                        if (!e.currentTarget.value) e.currentTarget.type = "text";
                      }}
                      onChange={(e) => setSchedEndDate(e.target.value)}
                      className="border rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                    />
                    {schedEndDate && (
                      <button
                        onClick={() => setSchedEndDate("")}
                        className="text-xs text-gray-400 hover:text-gray-600"
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 text-sm text-gray-700">
                  <span>频率：每</span>
                  <select
                    value={schedEveryDays}
                    onChange={(e) => setSchedEveryDays(Number(e.target.value))}
                    className="border rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  >
                    {[1, 2, 3, 5, 7, 14, 30].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                  <span>天</span>
                </div>

                <div className="space-y-2">
                  <div className="text-sm text-gray-700">
                    触发时间
                  </div>
                  {schedTimes.map((t, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        type="time"
                        value={t}
                        onChange={(e) => {
                          const next = [...schedTimes];
                          next[i] = e.target.value;
                          setSchedTimes(next);
                        }}
                        className="border rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      />
                      {schedTimes.length > 1 && (
                        <button
                          onClick={() =>
                            setSchedTimes(schedTimes.filter((_, j) => j !== i))
                          }
                          className="text-gray-400 hover:text-red-500 text-sm px-2"
                        >
                          删除
                        </button>
                      )}
                    </div>
                  ))}
                  {schedTimes.length < 3 && (
                    <button
                      onClick={() =>
                        setSchedTimes([
                          ...schedTimes,
                          schedTimes.length >= 2 ? "16:00" : "12:00",
                        ])
                      }
                      className="text-xs text-indigo-500 hover:text-indigo-600"
                    >
                      + 添加时间
                    </button>
                  )}
                </div>

                {/* 关注领域：逻辑与主页面一致（不选=全部热点，最多 3 个） */}
                <div className="space-y-1.5">
                  <div className="text-sm text-gray-700">
                    关注领域
                    <span className="text-gray-300">
                      （不选 = 抓取全部热点，最多选 {MAX_DOMAINS} 个）
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {domainOptions.map((d) => {
                      const on = schedDomains.includes(d);
                      return (
                        <button
                          key={d}
                          onClick={() => toggleSchedDomain(d)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition ${
                            on
                              ? "bg-indigo-500 text-white border-indigo-500"
                              : "bg-white text-gray-600 border-gray-200 hover:border-indigo-300"
                          }`}
                        >
                          {d}
                        </button>
                      );
                    })}
                    {schedDomains.length > 0 && (
                      <button
                        onClick={() => setSchedDomains([])}
                        className="text-xs px-2 py-1 text-gray-400 hover:text-gray-600"
                      >
                        清空
                      </button>
                    )}
                  </div>
                </div>

                {/* 平台选择 */}
                <div className="space-y-1.5">
                  <div className="text-sm text-gray-700">
                    抓取平台
                    <span className="text-gray-300">（至少选 1 个）</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {PLATFORMS.map((p) => {
                      const on = schedPlatforms.includes(p);
                      return (
                        <button
                          key={p}
                          onClick={() => toggleSchedPlatform(p)}
                          className={`text-xs px-2.5 py-1 rounded-full border transition ${
                            on
                              ? "bg-emerald-500 text-white border-emerald-500"
                              : "bg-white text-gray-600 border-gray-200 hover:border-emerald-300"
                          }`}
                        >
                          {p}
                        </button>
                      );
                    })}
                  </div>
                </div>
                </div>


                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    onClick={deleteScheduleCfg}
                    disabled={schedBusy}
                    className="text-sm px-3 py-1.5 rounded-lg border text-gray-400 hover:text-red-500 hover:border-red-300 disabled:opacity-50 transition"
                  >
                    删除任务
                  </button>
                  {schedEditMode ? (
                    <button
                      onClick={saveSchedule}
                      disabled={schedBusy}
                      className="text-sm px-6 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 disabled:opacity-50 transition ml-auto"
                    >
                      {schedBusy ? "处理中…" : "保存"}
                    </button>
                  ) : (
                    <button
                      onClick={() => setSchedEditMode(true)}
                      className="text-sm px-6 py-1.5 rounded-lg bg-indigo-500 text-white hover:bg-indigo-600 transition ml-auto"
                    >
                      编辑
                    </button>
                  )}
                </div>

                {schedMsg && (
                  <div
                    className={`text-xs ${
                      schedMsg.ok ? "text-emerald-600" : "text-red-500"
                    }`}
                  >
                    {schedMsg.text}
                  </div>
                )}
              </div>
            )}
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
                      领域 ▾
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
            <div className="relative">
              <button
                onClick={() => setSettingsOpen((v) => !v)}
                className={`text-xs border rounded-lg px-2 py-1 transition ${
                  syncCode
                    ? "text-emerald-600 border-emerald-200 hover:bg-emerald-50"
                    : "text-gray-500 border-gray-200 hover:text-indigo-600 hover:border-indigo-300"
                }`}
                title="设置（同步 / 定时任务）"
              >
                ⚙️ 设置
              </button>
              {settingsOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setSettingsOpen(false)}
                  />
                  <div className="absolute right-0 top-full mt-1 z-50 w-36 bg-white border rounded-xl shadow-lg py-1 text-sm">
                    <button
                      onClick={() => {
                        setSettingsOpen(false);
                        setSyncMsg(null);
                        setShowSync(true);
                      }}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-700"
                    >
                      🔄 同步{syncCode ? "（已启用）" : ""}
                    </button>
                    <button
                      onClick={openSchedule}
                      className="w-full text-left px-3 py-2 hover:bg-gray-50 text-gray-700"
                    >
                      ⏰ 定时任务
                    </button>
                  </div>
                </>
              )}
            </div>
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
          {messages.map((msg, i) => {
            const isWelcome = msg.content === WELCOME.content;
            const isUser = msg.role === "user";
            const checked = selectedMsgs.includes(i);
            return (
              <div key={i} className="flex items-start gap-2">
                {selectMode &&
                  (isWelcome ? (
                    <div className="w-4 shrink-0" />
                  ) : (
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSelect(i)}
                      className="mt-3 h-4 w-4 shrink-0 accent-indigo-500 cursor-pointer"
                    />
                  ))}
                <div
                  className={`group/msg flex flex-1 min-w-0 flex-col ${
                    isUser ? "items-end" : "items-start"
                  }`}
                >
                  {/* 用户消息上方标注本轮锁定的领域，切换领域后当轮回答即可直观区分 */}
                  {isUser && msg.domains && msg.domains.length > 0 && (
                    <div className="mb-1 flex flex-wrap justify-end gap-1">
                      {msg.domains.map((d) => (
                        <span
                          key={d}
                          className="rounded-full bg-indigo-50 text-indigo-600 text-[10px] px-2 py-0.5 border border-indigo-200"
                        >
                          {d}
                        </span>
                      ))}
                    </div>
                  )}
                  <div
                    onClick={
                      selectMode && !isWelcome ? () => toggleSelect(i) : undefined
                    }
                    onTouchStart={() => startLongPress(i)}
                    onTouchEnd={cancelLongPress}
                    onTouchMove={cancelLongPress}
                    className={`rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                      isUser
                        ? "max-w-[85%] bg-indigo-500 text-white"
                        : isWelcome
                        ? "max-w-[85%] bg-white text-gray-800 shadow-sm border"
                        : "w-full bg-white text-gray-800 shadow-sm border"
                    } ${selectMode && !isWelcome ? "cursor-pointer select-none" : ""}`}
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
                    <div className={selectMode ? "pointer-events-none" : ""}>
                      {msg.role === "assistant" && !isWelcome
                        ? renderAssistantContent(msg.content, i)
                        : msg.content}
                    </div>
                  </div>
                  {/* 多领域·未搜到领域的独立气泡：与回答同侧(左)、堆叠在下方，互不重叠 */}
                  {msg.role === "assistant" && msg.emptyNote && (
                    <div className="mt-2 max-w-[85%] rounded-2xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-700 shadow-sm">
                      {msg.emptyNote}
                    </div>
                  )}
                  {/* AI 输出端工具栏常驻；用户输出端悬浮才显示。点删除唤起编辑态 */}
                  {!selectMode && !isWelcome && (
                    <div
                      className={`mt-1 hidden sm:flex gap-1 transition ${
                        isUser
                          ? "opacity-0 group-hover/msg:opacity-100"
                          : "opacity-100"
                      }`}
                    >
                      <button
                        onClick={() => copyMessage(msg.content, i)}
                        title={copiedIdx === i ? "已复制" : "复制"}
                        className={`rounded p-1 transition ${
                          copiedIdx === i
                            ? "text-emerald-500"
                            : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"
                        }`}
                      >
                        {copiedIdx === i ? (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                        ) : (
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
                        )}
                      </button>
                      <button
                        onClick={() => enterSelectMode(i)}
                        title="删除"
                        className="text-gray-400 hover:text-red-500 hover:bg-red-50 rounded p-1 transition"
                      >
                        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><line x1="10" y1="11" x2="10" y2="17" /><line x1="14" y1="11" x2="14" y2="17" /></svg>
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
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
      {!selectMode && (
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
      )}

      {/* Input / 编辑态删除栏 */}

      {selectMode ? (
        <div className="border-t bg-white px-4 py-3 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <div className="flex items-center gap-3 max-w-[57.6rem] mx-auto">
            <span className="text-sm text-gray-500">
              已选 {selectedMsgs.length} 条
            </span>
            <div className="flex-1" />
            <button
              onClick={exitSelectMode}
              className="px-4 py-2 rounded-lg text-sm border text-gray-600 hover:bg-gray-50 transition"
            >
              取消
            </button>
            <button
              onClick={deleteSelected}
              disabled={selectedMsgs.length === 0}
              className="bg-red-500 text-white px-5 py-2 rounded-lg text-sm font-medium hover:bg-red-600 disabled:opacity-50 disabled:cursor-not-allowed transition"
            >
              删除
            </button>
          </div>
        </div>
      ) : (
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
      )}
    </main>
  );
}
