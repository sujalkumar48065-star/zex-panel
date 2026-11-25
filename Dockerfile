FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN python3 -m pip install --no-cache-dir --break-system-packages --upgrade pip && \
    python3 -m pip install --no-cache-dir --break-system-packages six requests tqdm python-slugify certifi urllib3 python-dateutil packaging psutil requests-toolbelt bleach protobuf kagglesdk kaggle && \
    python3 -c "import kaggle, six; print('kaggle-ok')"
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["node", "zex-control/server.js"]
