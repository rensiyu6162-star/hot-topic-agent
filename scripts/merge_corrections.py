# -*- coding: utf-8 -*-
"""
合并「人工（AI 助手）逐批纠错」的批次文件 -> data/kb/corrected.jsonl
- 批次文件: data/kb/manual_batches/b*.json  内容为 [{"id": "...", "corrected": "..."}, ...]
- 以 id 为准去重；批次文件里的新版本覆盖旧版本
- 领域/原字数从 CSV 回填，输出 schema 与 batch_correct.py 一致
"""
import csv, glob, json, os

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CSV_PATH = r"C:\Users\24157\Desktop\kbg\kbg\scripts_all.csv"
BATCH_DIR = os.path.join(BASE, "data", "kb", "manual_batches")
OUT_PATH = os.path.join(BASE, "data", "kb", "corrected.jsonl")


def main():
    meta = {r["id"]: r for r in csv.DictReader(open(CSV_PATH, encoding="utf-8-sig"))}
    records = {}
    files = sorted(glob.glob(os.path.join(BATCH_DIR, "b*.json")))
    for fp in files:
        for item in json.load(open(fp, encoding="utf-8")):
            records[item["id"]] = item["corrected"].strip()
    missing = [i for i in records if i not in meta]
    if missing:
        print("警告：CSV 中找不到 id:", missing)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        for rid, corrected in records.items():
            r = meta.get(rid, {"领域": "", "文稿": ""})
            rec = {"id": rid, "领域": r["领域"], "原字数": len(r["文稿"]),
                   "纠后字数": len(corrected), "corrected": corrected,
                   "model": "trae-manual-qc"}
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    total = sum(rec["原字数"] for rec in
                ({"原字数": len(meta.get(i, {"文稿": ""})["文稿"])} for i in records))
    print(f"合并 {len(files)} 个批次，共 {len(records)} 篇 / 462，原文约 {total} 字 -> {OUT_PATH}")


if __name__ == "__main__":
    main()
