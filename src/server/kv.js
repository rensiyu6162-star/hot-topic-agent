// 本地 JSON 文件 KV 存储：替代 Upstash Redis REST。
// 纯 JS 文件（不是 .ts），这样 Node.js 可以直接 require，不经过 Next.js 编译管线。
// 用在同步(/api/sync)与定时任务(/api/schedule)两处。

const fs = require("fs");
const path = require("path");

const STORE_DIR =
  process.env.LOCAL_KV_DIR || path.join(process.cwd(), "data", "kv");
const STORE_FILE = path.join(STORE_DIR, "store.json");

// ===== 轻量 async 锁（单进程足够防并发读写交错）=====
let _lock = Promise.resolve();
function acquireLock() {
  let release = () => {};
  const next = new Promise((resolve) => {
    release = resolve;
  });
  const prev = _lock;
  _lock = prev.then(() => next);
  return release;
}

function ensureDir() {
  try {
    fs.mkdirSync(STORE_DIR, { recursive: true });
  } catch {}
}

function loadStore() {
  ensureDir();
  try {
    const raw = fs.readFileSync(STORE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveStore(s) {
  ensureDir();
  const tmp = STORE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s), "utf-8");
  fs.renameSync(tmp, STORE_FILE);
}

function purgeExpired(s, now) {
  for (const k of Object.keys(s)) {
    if (s[k].e !== 0 && s[k].e <= now) delete s[k];
  }
}

// ===== 公开 API =====

function kvConfigured() {
  return true;
}

async function kv(command) {
  if (!command || command.length === 0) return null;

  const op = String(command[0]).toUpperCase();
  const release = acquireLock();
  try {
    const store = loadStore();
    const now = Date.now();
    purgeExpired(store, now);

    switch (op) {
      case "GET": {
        const key = String(command[1]);
        const ent = store[key];
        if (!ent) return null;
        if (ent.e !== 0 && ent.e <= now) {
          delete store[key];
          saveStore(store);
          return null;
        }
        return String(ent.v);
      }

      case "SET": {
        const key = String(command[1]);
        const val = String(command[2]);
        let expireAt = 0;
        if (command.length >= 5) {
          const opt = String(command[3]).toUpperCase();
          const num = Number(command[4]);
          if (opt === "PX" && num > 0) expireAt = now + num;
          else if (opt === "EX" && num > 0) expireAt = now + num * 1000;
        }
        store[key] = { v: val, e: expireAt };
        saveStore(store);
        return "OK";
      }

      case "DEL": {
        const key = String(command[1]);
        const existed = key in store;
        delete store[key];
        saveStore(store);
        return existed ? 1 : 0;
      }

      case "SADD": {
        const setKey = String(command[1]);
        const member = String(command[2]);
        const ent = store[setKey];
        const arr = ent && Array.isArray(ent.v) ? ent.v.slice() : [];
        if (!arr.includes(member)) arr.push(member);
        store[setKey] = { v: arr, e: 0 };
        saveStore(store);
        return 1;
      }

      case "SREM": {
        const setKey = String(command[1]);
        const member = String(command[2]);
        const ent = store[setKey];
        if (!ent || !Array.isArray(ent.v)) return 0;
        const arr = ent.v.slice();
        const idx = arr.indexOf(member);
        if (idx < 0) return 0;
        arr.splice(idx, 1);
        store[setKey] = { v: arr, e: ent.e };
        saveStore(store);
        return 1;
      }

      case "SMEMBERS": {
        const setKey = String(command[1]);
        const ent = store[setKey];
        if (!ent || !Array.isArray(ent.v)) return [];
        return ent.v.slice();
      }

      default:
        throw new Error(`本地 KV 不支持的命令: ${op}`);
    }
  } finally {
    release();
  }
}

module.exports = { kv, kvConfigured };
