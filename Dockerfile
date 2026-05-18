FROM node:20-alpine AS runtime
WORKDIR /app

# Install the skill + the n-payment SDK (peerDep) globally so the bin
# is on PATH and lazy imports resolve at runtime.
ARG N_PAYMENT_SKILL_VERSION=latest
ARG N_PAYMENT_VERSION=latest
RUN npm install -g \
      n-payment-skill@${N_PAYMENT_SKILL_VERSION} \
      n-payment@${N_PAYMENT_VERSION}

# Wallet + config volume (mount this in production for persistence).
VOLUME /root/.n-payment

ENV PORT=8081
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://localhost:${PORT}/health" >/dev/null || exit 1

# Default to MCP HTTP transport — perfect for Cursor / Windsurf / hosted MCP.
CMD ["sh", "-c", "n-payment-skill mcp --http --port ${PORT}"]
