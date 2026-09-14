# DataDeck Agent — AgentCore Runtime image (must be linux/arm64)
FROM --platform=linux/arm64 node:22-bookworm-slim

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package.json package-lock.json ./
RUN npm ci

# App source + the demo file (so the agent can clean a bundled sample).
COPY tsconfig.json ./
COPY src ./src
COPY examples ./examples

ENV DATADECK_PROVIDER=google
ENV DATADECK_MODEL_ID=gemini-2.5-flash
ENV PORT=8080
EXPOSE 8080

# AgentCore Runtime contract: HTTP server on :8080 with /ping + /invocations
CMD ["npx", "tsx", "src/agentcore/server.ts"]
