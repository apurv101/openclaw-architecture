# ── Stage 1: Python dependencies ──────────────────────────────────────────────
FROM python:3.11-slim AS python-deps

RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0t64 \
    libsm6 \
    libxext6 \
    libxrender1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ── Stage 2: Build Node.js backend + React frontend ─────────────────────────
FROM node:22-slim AS builder

RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /app

# Install root dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Install web dependencies
COPY web/package.json web/pnpm-lock.yaml ./web/
RUN cd web && pnpm install --frozen-lockfile

# Copy source and build backend
COPY src/ ./src/
COPY tsconfig.json ./
RUN pnpm build

# Copy web source and build frontend
COPY web/ ./web/
RUN cd web && pnpm build

# ── Stage 3: Runtime ─────────────────────────────────────────────────────────
FROM python:3.11-slim AS runtime

# Install the same system libs Python packages need at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0t64 \
    libgomp1 \
    libsm6 \
    libxext6 \
    libxrender1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from stage 1
COPY --from=python-deps /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages

# Install Node.js 22
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Enable pnpm
RUN corepack enable && corepack prepare pnpm@10.23.0 --activate

WORKDIR /app

# Install production dependencies only
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy built artifacts
COPY --from=builder /app/dist/ ./dist/
COPY --from=builder /app/web/dist/ ./web/dist/

# Copy scripts and data
COPY scripts/ ./scripts/
COPY data/ ./data/

# Create workspace directory for user files
RUN mkdir -p /workspace

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "dist/server.mjs"]
