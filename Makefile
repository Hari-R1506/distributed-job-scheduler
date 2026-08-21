.PHONY: help install up down logs ps reset seed load migrate generate studio \
        dev-api dev-worker dev-scheduler dev-web test test-unit test-integration \
        test-race test-race-repeat typecheck kill-worker demo

SHELL := /bin/bash

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-22s\033[0m %s\n", $$1, $$2}'

# ── Setup ────────────────────────────────────────────────────────────────────
install: ## Install dependencies and generate the Prisma client
	npm install
	npm run db:generate

.env: .env.example
	@test -f .env || (cp .env.example .env && echo "Created .env from .env.example")

# ── Running the stack ────────────────────────────────────────────────────────
up: .env ## Start the whole platform (postgres, api, scheduler, 3 workers, web)
	docker compose up -d --build
	@echo ""
	@echo "  Dashboard   http://localhost:5173"
	@echo "  API docs    http://localhost:3000/docs"
	@echo "  Metrics     http://localhost:3000/metrics"
	@echo ""
	@echo "  Next:  make seed"

down: ## Stop everything (keeps the database volume)
	docker compose down

reset: ## Stop everything and DELETE the database volume
	docker compose down -v

logs: ## Tail logs from every service
	docker compose logs -f

ps: ## Show container status
	docker compose ps

# ── Database ─────────────────────────────────────────────────────────────────
migrate: ## Apply pending migrations
	npm run db:migrate

generate: ## Regenerate the Prisma client
	npm run db:generate

studio: ## Open Prisma Studio
	npm run db:studio

db-reset: ## Drop, recreate and re-migrate the database (destructive)
	npm run db:reset

# ── Demo data ────────────────────────────────────────────────────────────────
seed: ## Create the demo org, project, queues and cron schedules
	npm run seed

load: ## Fire 10k jobs at 200/s with a 10% transient failure rate
	npm run load

demo: up seed load ## Full demo: start, seed, then generate load

kill-worker: ## SIGKILL worker-2 to demonstrate crash recovery
	@echo "Killing djs-worker-2 (SIGKILL, not SIGTERM) ..."
	docker kill djs-worker-2
	@echo "Watch the dashboard: DEAD at ~30s, jobs recovered at ~60s."

# ── Local development (outside Docker; needs `docker compose up postgres`) ────
dev-api: ## Run the API with hot reload
	npm run dev:api

dev-worker: ## Run one worker with hot reload
	npm run dev:worker

dev-scheduler: ## Run the scheduler with hot reload
	npm run dev:scheduler

dev-web: ## Run the Vite dev server
	npm run dev:web

# ── Quality ──────────────────────────────────────────────────────────────────
typecheck: ## Type-check every workspace
	npm run typecheck

test: ## Unit + integration tests
	npm test

test-unit: ## Pure domain-logic tests (fast, no database)
	npm run test:unit

test-integration: ## API tests against a real Postgres (Testcontainers)
	npm run test:integration

test-race: ## The concurrency suite: atomic claiming, crash recovery, leader failover
	npm run test:race

test-race-repeat: ## Run the concurrency suite 20x — race conditions are probabilistic
	npm run test:race:repeat
