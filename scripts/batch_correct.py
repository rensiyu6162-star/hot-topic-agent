# -*- coding: utf-8 -*-
"""
本地开源模型批量纠错（Ollama + Qwen2.5-7B），零 API 成本。
- 输入: 桌面 kbg/scripts_all.csv（462 篇 ASR 口播稿）
- 输出: data/kb/corrected.jsonl（断点续跑，重跑自动跳过已完成 id）
- 超长文按边界切段逐段纠错后拼接；单篇失败重试 3 次并记录，不中断全量。
"""
import csv, json, os, time, urllib.request, urllib.error

OLLAMA = "http://127.0.0.1:11434/api/chat"
MODEL = os.environ.get("CORRECT_MODEL", "qwen3:8b")
CSV_PATH = r"C:\Users\24157\Desktop\kbg\kbg\scripts_all.csv"
OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "kb")
OUT_PATH = os.path.join(OUT_DIR, "corrected.jsonl")
CHUNK = 3500          # 单段最大字数（约 5k token，给输出留足上下文）
MAX_RETRY = 3

SYS = (
    "你是中文短视频口播稿的语音转写纠错专家。用户给你的文稿由 ASR 自动转写，存在大量错误。"
    "你必须逐句对照语音常识进行修复，只做以下四件事：\n"
    "1. 纠正同音/近音错字，结合上下文医学、生活常识判断，例如“胃胀”不是“胃賬”、"
    "“拖沓”不是“拖塔”、药材名“蒲公英”“丝瓜络”可能被转写成发音相近的错词；\n"
    "2. 所有繁体字、异体字一律转成规范简体；\n"
    "3. 补全标点并合理分段；\n"
    "4. 删除“嗯啊那个”等无意义语气残留，但保留口语化表达和原意。\n"
    "严禁照抄原文（原文必然有错），严禁改写句子、增删观点、输出解释或任何前后缀。"
    "直接输出修正后的全文。下面是两个纠错示例：\n\n"
    "输入：\n經常胃賬反酸的人，喫點山藥能脾健胃\n"
    "输出：\n经常胃胀反酸的人，吃点山药能健脾养胃。\n\n"
    "输入：\n他這個人辦事總是拖塔，一點都不靠鋪\n"
    "输出：\n他这个人办事总是拖沓，一点都不靠谱。"
)
SYS_CHUNK = SYS + "这是长稿的一个片段，请只纠错该片段，不要补开头结尾。"


def chat(text, system=SYS, timeout=900):
    body = {"model": MODEL, "stream": False, "think": False,
            "options": {"temperature": 0, "num_ctx": 8192},
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": "输入：\n" + text + "\n输出："}]}
    r = urllib.request.Request(OLLAMA, data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=timeout) as resp:
        return json.load(resp)["message"]["content"].strip()


def split_text(t, limit=CHUNK):
    """按段落/句子边界切，尽量不切断句子。"""
    if len(t) <= limit:
        return [t]
    parts, start = [], 0
    while start < len(t):
        end = min(start + limit, len(t))
        if end < len(t):
            window = t[start:end]
            cut = max(window.rfind("\n"), window.rfind("。"), window.rfind("！"),
                      window.rfind("？"), window.rfind("；"))
            if cut > limit * 0.5:
                end = start + cut + 1
        parts.append(t[start:end])
        start = end
    return parts


def correct_one(text):
    chunks = split_text(text)
    outs = []
    for i, c in enumerate(chunks):
        last_err = None
        for attempt in range(MAX_RETRY):
            try:
                outs.append(chat(c, SYS if len(chunks) == 1 else SYS_CHUNK))
                break
            except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
                last_err = e
                time.sleep(3 * (attempt + 1))
        else:
            raise RuntimeError(f"片段纠错失败: {last_err}")
    return "\n".join(outs)


def load_done():
    done = {}
    if os.path.exists(OUT_PATH):
        for line in open(OUT_PATH, encoding="utf-8"):
            r = json.loads(line)
            done[r["id"]] = r
    return done


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8-sig")))
    done = load_done()
    todo = [r for r in rows if r["id"] not in done]
    print(f"共 {len(rows)} 篇，已完成 {len(done)}，待处理 {len(todo)}，模型 {MODEL}")

    f = open(OUT_PATH, "a", encoding="utf-8")
    t_start = time.time()
    for idx, r in enumerate(todo, 1):
        t0 = time.time()
        try:
            corrected = correct_one(r["文稿"])
            rec = {"id": r["id"], "领域": r["领域"], "原字数": len(r["文稿"]),
                   "纠后字数": len(corrected), "corrected": corrected,
                   "model": MODEL, "elapsed": round(time.time() - t0, 1)}
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            f.flush()
            print(f"[{idx}/{len(todo)}] {r['领域']} {len(r['文稿'])}字 {rec['elapsed']}s OK")
        except Exception as e:
            print(f"[{idx}/{len(todo)}] id={r['id']} 失败: {e}")
    f.close()
    print(f"本轮结束，用时 {(time.time()-t_start)/60:.1f} 分钟，输出 {OUT_PATH}")


if __name__ == "__main__":
    main()
