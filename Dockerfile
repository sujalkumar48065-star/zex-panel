FROM node:20-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN pip3 install --no-cache-dir --break-system-packages kaggle
WORKDIR /app
COPY . .
ENV NODE_ENV=production
ENV HOST=0.0.0.0
EXPOSE 10000
CMD ["node", "zex-control/server.js"]
