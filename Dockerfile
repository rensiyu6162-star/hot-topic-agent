# 多阶段构建，产出精简的 Next.js standalone 运行镜像
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# src/server/kv.js 是纯 CommonJS 本地存储实现，不经过 Next.js Webpack 编译，
# 需手动复制进运行时容器（standalone 输出不包含这类非编译文件）
COPY --from=builder /app/src/server ./src/server
EXPOSE 3000
# 容器自检：每 30s 探一次健康接口，连续 3 次失败标记 unhealthy（配合 docker 的自动观测）。
# node:20-alpine 无 curl/wget 保证，直接用 node 自带的全局 fetch。
HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
