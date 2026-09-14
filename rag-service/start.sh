#!/bin/sh
set -e

# 模型权重存挂载卷，镜像重建不重下；snapshot_download 第二次命中缓存秒回
# 粗召回：bge-base-zh-v1.5（fp32 约 0.4GB，768 维）——3.6G 小内存机器跑 0.6B 嵌入会 swap 抖动，用轻量 bge
export EMBED_MODEL=$(python -c "from modelscope import snapshot_download; print(snapshot_download('BAAI/bge-base-zh-v1.5', cache_dir='$MODELS_DIR'))")
echo "[start] embed model at $EMBED_MODEL"
# bge 用 CLS 池化 + 中文查询指令前缀（Qwen3-Embedding 才用末位池化 + Instruct 前缀）
export EMBED_POOL=cls
export EMBED_QUERY_PREFIX='为这个句子生成表示以用于检索相关文章：'
# 精排：bge-reranker-base（int8 量化除分类头约 0.4GB）——CPU 重排 1-3s，比 0.6B 快 5 倍
export RERANK_MODEL=$(python -c "from modelscope import snapshot_download; print(snapshot_download('BAAI/bge-reranker-base', cache_dir='$MODELS_DIR'))")
echo "[start] reranker model at $RERANK_MODEL"

exec uvicorn app:app --host 0.0.0.0 --port 8091
