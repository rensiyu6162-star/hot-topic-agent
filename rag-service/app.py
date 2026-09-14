# -*- coding: utf-8 -*-
"""
零成本本地 RAG 模型服务（CPU）。
- Embedding: BAAI/bge-base-zh-v1.5（fp32，~0.4GB，768 维）——3.6G 小内存机器跑 0.6B 嵌入模型会触发 swap 抖动，故用轻量 bge
- Reranker:   BAAI/bge-reranker-base（int8 动态量化除分类头，~0.4GB）——CPU 重排从 5-15s 降到 1-3s
- 向量检索:   FAISS IndexFlatIP（768 维，语料 <10 万条无需近似索引）
仅绑 127.0.0.1，不对公网暴露。
"""
import json
import os
import threading
from typing import Any

import faiss
import numpy as np
import torch
import torch.nn as nn
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

DATA_DIR = os.environ.get("RAG_DATA", "/data")
INDEX_PATH = os.path.join(DATA_DIR, "faiss.index")
META_PATH = os.path.join(DATA_DIR, "meta.jsonl")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-base-zh-v1.5")
RERANK_MODEL = os.environ.get("RERANK_MODEL", "BAAI/bge-reranker-base")
# bge 用 CLS 池化 + 中文查询指令前缀（Qwen3-Embedding 才用末位池化 + Instruct 前缀）
EMBED_POOL = os.environ.get("EMBED_POOL", "cls")          # cls | last
EMBED_QUERY_PREFIX = os.environ.get(
    "EMBED_QUERY_PREFIX",
    "为这个句子生成表示以用于检索相关文章：")
_dim = None  # 加载模型后从 config 读取实际维度（bge=768，Qwen3-0.6B=1024）
MAX_LEN = 512           # bge 上下文 512；口播稿切片约 500 字在范围内
RETRIEVE_TOPN = 15
FINAL_TOPK = 6

torch.set_num_threads(int(os.environ.get("TORCH_THREADS", "3")))

app = FastAPI(title="local-rag", docs_url=None, redoc_url=None)
_lock = threading.Lock()
_load_lock = threading.Lock()   # 模型加载锁：防止预热线程与请求线程并发 from_pretrained

_embed_tok = _embed_model = _rerank_tok = _rerank_model = None
_index = None
_meta: list[dict[str, Any]] = []


def _load_model(cls, name, quant_skip=()):
    """加载模型。
    quant_skip 为空 -> fp32 全精度（embedding 向量对量化敏感，必须 fp32）；
    否则仅对不在 quant_skip 名称集合内的 Linear 做 int8 动态量化
    （reranker 的 lm_head 输出 Yes/No logits，量化会显著劣化排序，必须跳过）。
    """
    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(name)
    model = cls.from_pretrained(name, torch_dtype=torch.float32, low_cpu_mem_usage=True)
    if quant_skip:
        targets = {mod for n, mod in model.named_modules()
                   if isinstance(mod, nn.Linear) and not any(s in n for s in quant_skip)}
        model = torch.quantization.quantize_dynamic(model, targets, dtype=torch.qint8)
    model.eval()
    return tok, model


def _last_token_pool(seq, mask):
    # Qwen3-Embedding：取每条序列最后一个有效 token（右 padding）
    left = mask.sum(dim=1) - 1
    idx = left.view(-1, 1, 1).expand(-1, 1, seq.size(-1))
    return seq.gather(1, idx).squeeze(1)


def _ensure_embed():
    global _embed_tok, _embed_model, _dim
    if _embed_model is None:
        with _load_lock:                      # 防止与 startup 预热线程并发加载导致竞态
            if _embed_model is None:
                from transformers import AutoModel
                print(f"[rag] loading embed {EMBED_MODEL}", flush=True)
                _embed_tok, _embed_model = _load_model(AutoModel, EMBED_MODEL)
                _dim = int(_embed_model.config.hidden_size)
                print(f"[rag] embed ready dim={_dim} pool={EMBED_POOL}", flush=True)


def _ensure_rerank():
    global _rerank_tok, _rerank_model
    if _rerank_model is None:
        with _load_lock:
            if _rerank_model is None:
                from transformers import AutoModelForSequenceClassification
                print(f"[rag] loading reranker {RERANK_MODEL}", flush=True)
                # bge-reranker：BERT 分类器，分类头不量化（score 对量化敏感），其余 Linear int8
                _rerank_tok, _rerank_model = _load_model(
                    AutoModelForSequenceClassification, RERANK_MODEL, quant_skip=("classifier",))
                print("[rag] reranker ready", flush=True)


def _embed_texts(texts: list[str], is_query: bool) -> np.ndarray:
    _ensure_embed()
    if is_query and EMBED_QUERY_PREFIX:
        texts = [EMBED_QUERY_PREFIX + t for t in texts]
    with torch.no_grad():
        batch = _embed_tok(texts, padding=True, truncation=True, max_length=MAX_LEN,
                           return_tensors="pt")
        out = _embed_model(**batch)
        if EMBED_POOL == "cls":
            emb = out.last_hidden_state[:, 0]            # bge：CLS 池化
        else:
            emb = _last_token_pool(out.last_hidden_state, batch["attention_mask"])
        emb = torch.nn.functional.normalize(emb, p=2, dim=1)
    return emb.float().numpy()


def _load_store():
    """读磁盘索引；空库时需先 _ensure_embed() 拿到维度再建空索引。"""
    global _index, _meta
    if _index is not None:
        return
    if os.path.exists(INDEX_PATH) and os.path.exists(META_PATH):
        _index = faiss.read_index(INDEX_PATH)
        _meta = [json.loads(l) for l in open(META_PATH, encoding="utf-8") if l.strip()]
        print(f"[rag] index loaded: {_index.ntotal} vectors", flush=True)
    elif _dim is not None:
        _index = faiss.IndexFlatIP(_dim)
        _meta = []
        print(f"[rag] empty index initialized dim={_dim}", flush=True)


def _rerank(query: str, docs: list[str]) -> list[float]:
    """bge-reranker：query+document 拼接做二分类，sigmoid(logits) 越大越相关。批量前向。"""
    _ensure_rerank()
    scores = []
    BATCH = int(os.environ.get("RERANK_BATCH", "8"))
    RR_MAXLEN = int(os.environ.get("RERANK_MAXLEN", "512"))  # bge 上下文 512
    with torch.no_grad():
        for i in range(0, len(docs), BATCH):
            grp = docs[i:i + BATCH]
            enc = _rerank_tok([query] * len(grp), grp, padding=True, truncation=True,
                              max_length=RR_MAXLEN, return_tensors="pt")
            logits = _rerank_model(**enc).logits
            scores.extend(torch.sigmoid(logits).view(-1).tolist())
    return scores


# ---------- schemas ----------
class EmbedReq(BaseModel):
    texts: list[str]
    is_query: bool = False


class Item(BaseModel):
    text: str
    meta: dict[str, Any] = Field(default_factory=dict)


class AddReq(BaseModel):
    items: list[Item]


class SearchReq(BaseModel):
    query: str
    top_k: int = FINAL_TOPK
    rerank: bool = True
    category: str | None = None


class RerankReq(BaseModel):
    query: str
    documents: list[str]


@app.post("/rerank")
def rerank_api(req: RerankReq):
    """裸相关性打分：query 与每个 document 拼对过 cross-encoder，返回 sigmoid 分数（越大越相关）。
    供热点判定的第二阶段独立精排使用（逐条打分，无整批上下文锚定）；模型已在内存中复用。
    """
    if not req.query.strip() or not req.documents:
        return {"scores": []}
    docs = [str(d)[:2000] for d in req.documents]
    scores = _rerank(req.query[:2000], docs)
    return {"scores": [float(s) for s in scores]}


@app.on_event("startup")
def _startup():
    _load_store()
    # 后台预热 embedding 模型，避免首个检索请求同时付两个模型的加载开销
    threading.Thread(target=_ensure_embed, daemon=True).start()


@app.get("/health")
def health():
    return {"ok": True, "vectors": _index.ntotal if _index else 0,
            "embed_loaded": _embed_model is not None,
            "rerank_loaded": _rerank_model is not None}


@app.post("/embed")
def embed(req: EmbedReq):
    vecs = _embed_texts(req.texts, req.is_query)
    return {"vectors": vecs.tolist(), "dim": _dim}


@app.post("/add")
def add(req: AddReq):
    """增量写入（历史热点自动沉淀用）。低频操作，全量读改写，加锁。"""
    if not req.items:
        return {"added": 0}
    with _lock:
        vecs = _embed_texts([i.text for i in req.items], is_query=False)
        _load_store()
        _index.add(vecs.astype("float32"))
        with open(META_PATH, "a", encoding="utf-8") as f:
            for i in req.items:
                rec = {"text": i.text, **i.meta}
                _meta.append(rec)
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        faiss.write_index(_index, INDEX_PATH)
    return {"added": len(req.items), "total": _index.ntotal}


@app.post("/search")
def search(req: SearchReq):
    _ensure_embed()
    _load_store()
    if _index is None or _index.ntotal == 0:
        return {"results": []}
    qv = _embed_texts([req.query], is_query=True).astype("float32")
    with _lock:
        scores, idxs = _index.search(qv, min(RETRIEVE_TOPN, _index.ntotal))
    cands = []
    for rank, (sc, ix) in enumerate(zip(scores[0], idxs[0])):
        if ix < 0:
            continue
        m = _meta[ix]
        if req.category and m.get("category") not in (None, req.category):
            continue
        cands.append({"index": int(ix), "dense_score": float(sc),
                      "text": m["text"], "meta": {k: v for k, v in m.items() if k != "text"}})
    if not cands:
        return {"results": []}
    if req.rerank and len(cands) > 1:
        rr = _rerank(req.query, [c["text"] for c in cands])
        for c, s in zip(cands, rr):
            c["score"] = s
        cands.sort(key=lambda c: c["score"], reverse=True)
    else:
        for c in cands:
            c["score"] = c["dense_score"]
    return {"results": cands[: req.top_k]}
