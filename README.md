# civilclaw

AI agent for Architecture, Engineering & Construction (AEC) with 34+ specialized tools for structural analysis, BIM/IFC, CAD/DXF, MEP, compliance, energy modeling, and more.

## Prerequisites

- [Docker Desktop](https://docs.docker.com/get-docker/) installed and running
- An API key for your LLM provider (OpenAI, Anthropic, etc.)

## Quick Start

```bash
# 1. Clone the repo
git clone <repo-url>
cd civilclaw

# 2. Create your .env file
cp .env.example .env
# Edit .env and add your API keys

# 3. Build and run
docker compose up -d

# 4. Open the chat UI
open http://localhost:3001
```

That's it. The Docker image includes Node.js 22, Python 3.11, and all AEC packages (ifcopenshell, ezdxf, trimesh, open3d, laspy).

## Environment Variables

Create a `.env` file in the project root:

```env
# Required: LLM provider and API key
CIVILCLAW_PROVIDER=openai          # or: anthropic, google, groq, mistral
CIVILCLAW_MODEL=gpt-4o             # model ID for your provider
OPENAI_API_KEY=sk-...             # API key for your chosen provider

# Optional
PERPLEXITY_API_KEY=pplx-...       # enables web search tool
PORT=3001                         # server port (default: 3001)
```

## Development (without Docker)

If you want to run without Docker for development:

```bash
# Prerequisites: Node.js >= 22.12.0, Python 3.11+, pnpm 10.x

# 1. Install dependencies
pnpm install
cd web && pnpm install && cd ..

# 2. Install Python packages (needed for BIM/CAD tools)
pip install -r requirements.txt

# 3. Start the API server (with hot reload)
pnpm dev:server

# 4. Start the React dev server (separate terminal)
pnpm dev:web

# 5. Open http://localhost:5173 (Vite proxies /api to :3001)
```

## Project Structure

```
civilclaw/
├── src/
│   ├── entry.ts          CLI entry point
│   ├── server.ts         HTTP + SSE server (serves API + web UI)
│   ├── shared.ts         Shared utilities
│   ├── system-prompt.ts  Dynamic system prompt builder
│   └── tools/            34 tool definitions
│       ├── ifc/          IFC/BIM tools (parse, generate, modify, query, validate)
│       ├── dxf/          DXF/CAD tools (parse, generate, to-svg)
│       ├── conversion/   Format convert, point cloud, model section
│       ├── structural/   Beam, column, slab, foundation analysis
│       ├── mep/          HVAC, electrical, plumbing
│       ├── cost/         Cost estimation, quantity takeoff
│       ├── compliance/   Building code, ADA, sustainability, zoning
│       ├── energy/       Energy model, daylight analysis
│       ├── floorplan/    Floorplan generation & analysis
│       └── docs/         Spec writer, schedule, submittal log
├── scripts/              Python scripts for BIM/CAD operations
├── data/                 Reference data (climate, cost, IBC tables, CSI templates)
├── web/                  React + Vite + Tailwind chat UI
├── Dockerfile            Multi-stage build (Python + Node.js)
├── docker-compose.yml    One-command local run
├── requirements.txt      Python dependencies
└── deploy/               AWS ECS deployment files
```

## Docker Commands

```bash
# Build the image
docker compose build

# Start in background
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down

# Rebuild after code changes
docker compose up -d --build
```

## Deploying to AWS

See [deploy/](deploy/) for ECS task definition and [.github/workflows/deploy.yml](.github/workflows/deploy.yml) for the CI/CD pipeline.

Quick summary:
1. Create an ECR repository and ECS cluster on AWS
2. Update `ACCOUNT_ID` in `deploy/ecs-task-definition.json`
3. Add `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to GitHub Secrets
4. Push to `main` — GitHub Actions builds, pushes to ECR, and deploys to ECS
