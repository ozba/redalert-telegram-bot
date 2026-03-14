FROM node:22-slim AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Pre-install MCP server so first spawn is fast
RUN npx -y redalert-mcp-server --help || true

ENV NODE_ENV=production
USER node
CMD ["node", "dist/index.js"]
