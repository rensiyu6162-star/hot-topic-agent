# -*- coding: utf-8 -*-
"""
离线建索引：/data/input/corrected.jsonl -> FAISS + meta.jsonl
在 rag 镜像内一次性运行：
  docker run --rm --network container:rag -v rag-data:/data rag:latest python build_index.py
"""
import json
import os
import re
import time
import urllib.request

import faiss
import numpy as np

DATA = os.environ.get("RAG_DATA", "/data")
INPUT = os.path.join(DATA, "input", "corrected.jsonl")
SERVICE = "http://127.0.0.1:8091"
CHUNK_SIZE = 520     # 中文口播稿每块目标字数
OVERLAP = 80         # 相邻块重叠字数（避免切断观点）
BATCH = 16         # bge 轻量，16 批内存无忧；0.6B 嵌入时才需降到 4 防 swap


def clean_placeholders(text: str) -> str:
    """清洗人工纠错稿中的占位符（不影响原始 corrected.jsonl）：
    - 删除（原音崩坏）整段标记及其前导标点
    - 删除连续 2+ 个（？）的纯噪音组
    - 删除单个（？）未知词占位
    - 收敛残留的重复标点 / 空白
    """
    text = re.sub(r"[，。、；：！？\s]*（原音崩坏）", "", text)
    text = re.sub(r"（？）（？）+", "", text)
    text = text.replace("（？）", "")
    text = re.sub(r"[，。、；：！？]{2,}", lambda m: m.group(0)[-1], text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([，。；：！？])", r"\1", text)
    return text.strip()


def chunk_text(text: str) -> list[str]:
    paras = [p.strip() for p in text.replace("\r\n", "\n").split("\n") if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paras:
        # 单段超长则按句号硬切
        while len(p) > CHUNK_SIZE:
            cut = p.rfind("。", 0, CHUNK_SIZE)
            cut = cut if cut > CHUNK_SIZE * 0.6 else CHUNK_SIZE
            piece, p = p[: cut + 1], p[cut + 1:]
            if buf:
                chunks.append(buf + piece)
                buf = ""
            else:
                chunks.append(piece)
        if len(buf) + len(p) <= CHUNK_SIZE:
            buf += p
        else:
            if buf:
                chunks.append(buf)
            buf = (buf[-OVERLAP:] if chunks and len(buf) > OVERLAP else "") + p
    if buf:
        chunks.append(buf)
    return [c for c in chunks if len(c.strip()) >= 20]  # 丢掉碎片


def _wait_embed(timeout=300):
    """等 /health 里 embed_loaded=true（避免与容器 startup 预热线程并发加载模型导致 500）"""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            with urllib.request.urlopen(SERVICE + "/health", timeout=10) as r:
                h = json.load(r)
            if h.get("embed_loaded"):
                print("embed 模型已就绪", flush=True)
                return
        except Exception:
            pass
        time.sleep(3)
    raise SystemExit("embed 模型 300 秒内未就绪")


def main():
    _wait_embed()
    docs = [json.loads(l) for l in open(INPUT, encoding="utf-8") if l.strip()]
    print(f"载入文稿 {len(docs)} 篇")
    jobs = []
    for d in docs:
        cleaned = clean_placeholders(d["corrected"])
        for i, c in enumerate(chunk_text(cleaned)):
            jobs.append((d, i, c))
    print(f"切片共 {len(jobs)} 块")

    index = None
    metas = []
    for start in range(0, len(jobs), BATCH):
        group = jobs[start:start + BATCH]
        payload = json.dumps({"texts": [g[2] for g in group], "is_query": False}).encode()
        req = urllib.request.Request(SERVICE + "/embed", data=payload,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=600) as resp:
            data = json.load(resp)
        vecs = np.array(data["vectors"], dtype="float32")
        if index is None:
            index = faiss.IndexFlatIP(int(data["dim"]))
        index.add(vecs)
        for d, i, c in group:
            metas.append({"doc_id": d["id"], "category": d["领域"], "chunk": i,
                          "source": "kb462", "text": c})
        print(f"  已索引 {min(start+BATCH,len(jobs))}/{len(jobs)}", flush=True)

    faiss.write_index(index, os.path.join(DATA, "faiss.index"))
    with open(os.path.join(DATA, "meta.jsonl"), "w", encoding="utf-8") as f:
        for m in metas:
            f.write(json.dumps(m, ensure_ascii=False) + "\n")
    print(f"完成：{index.ntotal} 向量 -> {DATA}")


if __name__ == "__main__":
    main()
