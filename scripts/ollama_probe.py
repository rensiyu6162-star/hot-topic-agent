# -*- coding: utf-8 -*-
"""用本地 Ollama 开源模型测 ASR 纠错质量（少样本增强版）。样本同 DeepSeek 探针，便于横向对比。"""
import csv, json, os, time, urllib.request

OLLAMA = "http://127.0.0.1:11434/api/chat"
MODEL = os.environ.get("CORRECT_MODEL", "qwen3:8b")
CSV_PATH = r"C:\Users\24157\Desktop\kbg\kbg\scripts_all.csv"
CHUNK = 3500  # 与批量脚本一致
THINK = os.environ.get("THINK", "0") == "1"

SYS = (
    "你是中文短视频口播稿的语音转写纠错专家。用户给你的文稿由 ASR 自动转写，存在大量同音/近音错别字。"
    "你必须逐词逐句对照常识修复，只做以下四件事：\n"
    "1. 纠正同音/近音错字，结合上下文判断，凡是搭配不通、不像规范词语的都要换成同音近音的正确字词——"
    "尤其是中药材/食材名（如黄杞=黄芪、红早=红枣、银乔=连翘、金连花=金银花、白树=白术）、"
    "人体器官与病症（如胃賬=胃胀、乳线=乳腺）、中医证型与功效（气雪=气血、补皮=补脾、亲热解独=清热解毒）；\n"
    "2. 所有繁体字、异体字一律转成规范简体；\n"
    "3. 补全标点并合理分段；\n"
    "4. 删除“嗯啊那个”等无意义语气残留，但保留口语化表达和原意。\n"
    "严禁照抄原文（原文必然有错，尤其食疗/养生稿里的药名食材名几乎全是错的，必须逐个改成真实名称），"
    "严禁改写句子、增删观点、输出解释或任何前后缀。直接输出修正后的全文。纠错示例：\n\n"
    "输入：\n經常胃賬反酸的人，喫點山藥能脾健胃\n"
    "输出：\n经常胃胀反酸的人，吃点山药能健脾养胃。\n\n"
    "输入：\n他這個人辦事總是拖塔，一點都不靠鋪\n"
    "输出：\n他这个人办事总是拖沓，一点都不靠谱。\n\n"
    "输入：\n黄杞配红早煮水，能补皮养气，适合气雪两虚、总觉得伐力的人\n"
    "输出：\n黄芪配红枣煮水，能补脾益气，适合气血两虚、总觉得乏力的人。\n\n"
    "输入：\n银乔和金连花一起泡水，亲热解独，喉咙肿通的时候喝\n"
    "输出：\n连翘和金银花一起泡水，清热解毒，喉咙肿痛的时候喝。"
)


def chat(text):
    body = {"model": MODEL, "stream": False, "think": THINK,
            "options": {"temperature": 0, "num_ctx": 8192},
            "messages": [{"role": "system", "content": SYS},
                         {"role": "user", "content": "输入：\n" + text + "\n输出："}]}
    t0 = time.time()
    r = urllib.request.Request(OLLAMA, data=json.dumps(body).encode(),
                               headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=600) as resp:
        d = json.load(resp)
    nthink = d.get("thinking_tokens") or len(d.get("message", {}).get("thinking") or "")
    return d["message"]["content"].strip(), time.time() - t0, d.get("eval_count", 0), nthink


def chunks(text):
    if len(text) <= CHUNK:
        return [text]
    out, start = [], 0
    while start < len(text):
        end = min(start + CHUNK, len(text))
        if end < len(text):
            # 在句号/问号/感叹号边界断开
            seg = text[start:end]
            for p in ("！", "。", "？", "!", "?", "\n"):
                k = seg.rfind(p)
                if k >= CHUNK - 500:
                    end = start + k + 1
                    break
        out.append(text[start:end])
        start = end
    return out


def correct(text):
    parts, tot_t, tot_n = [], 0.0, 0
    for c in chunks(text):
        out, dt, n, _ = chat(c)
        parts.append(out)
        tot_t += dt
        tot_n += n
    return "".join(parts), tot_t, tot_n


def main():
    rows = list(csv.DictReader(open(CSV_PATH, encoding="utf-8-sig")))
    samples = [
        next(r for r in rows if r["id"] == "7646981661439135012"),  # 医学同音错字
        rows[1],                                                       # 繁体
        max(rows, key=lambda r: len(r["文稿"])),                       # 最长文（分段）
    ]
    if os.environ.get("ONLY") == "med":
        samples = samples[:1]
    for r in samples:
        out, dt, n = correct(r["文稿"])
        print("=" * 30, r["领域"], len(r["文稿"]), "字", f"{dt:.1f}s",
              f"eval={n} tok", f"{n / dt:.0f} tok/s", f"输出{len(out)}字")
        if os.environ.get("ONLY") == "med":
            print("【原文】", r["文稿"][:600])
        print("【纠后】", out[:900])
        print()


if __name__ == "__main__":
    main()
