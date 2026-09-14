FROM python:3.11-slim

ENV PIP_INDEX_URL=https://mirrors.tencentyun.com/pypi/simple \
    PIP_TRUSTED_HOST=mirrors.tencentyun.com \
    PYTHONUNBUFFERED=1 \
    MODELS_DIR=/models \
    RAG_DATA=/data \
    TORCH_THREADS=3

RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# torch 单独走官方 CPU 源（PyPI 默认 wheel 带 CUDA，体积大且无 GPU 无用）
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY app.py build_index.py start.sh ./
RUN chmod +x start.sh && mkdir -p /data /models

EXPOSE 8091
HEALTHCHECK --interval=30s --timeout=10s --start-period=300s --retries=3 \
    CMD curl -fs http://127.0.0.1:8091/health || exit 1

CMD ["./start.sh"]
