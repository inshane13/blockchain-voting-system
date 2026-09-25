# Blockchain Voting System — automation entry point.
# Every target is idempotent where possible. Secrets are NEVER echoed:
# all deploy/register steps read from the gitignored .env via hardhat.
#
#   make install      install all workspaces (root, frontend, backend)
#   make compile      compile contracts
#   make test         29+ Hardhat tests
#   make test-backend backend API suite (node:test, zero extra deps)
#   make lint         solhint + frontend eslint
#   make build        frontend production build
#   make smoke        backend live health smoke test
#   make e2e-local    full commit->reveal->winner cycle on ephemeral Hardhat net
#   make deploy-localhost | make deploy-sepolia | make register | make verify
#   make audit        npm audit (informational; see docs/SECURITY.md)
#   make ci           the full gate (what CI runs)
#   make clean        remove build artifacts (never secrets)

NPM := npm ci --legacy-peer-deps
NETWORK ?= localhost
PORT ?= 5000

.PHONY: help install install-root install-frontend install-backend \
	compile test test-backend lint lint-sol lint-frontend build smoke \
	e2e-local deploy-localhost deploy-sepolia register verify audit ci clean

help:
	@echo "Targets: install compile test test-backend lint build smoke e2e-local"
	@echo "         deploy-localhost deploy-sepolia register verify audit ci clean"
	@echo "Vars: NETWORK=localhost PORT=5000 (e.g. make smoke PORT=5059)"

# --- install ---------------------------------------------------------------
install: install-root install-frontend install-backend

install-root:
	npm ci --legacy-peer-deps

install-frontend:
	cd frontend && $(NPM)

install-backend:
	cd backend && $(NPM)

# --- contracts -------------------------------------------------------------
compile:
	npx hardhat compile

test:
	npx hardhat test

test-backend:
	cd backend && node --test test/*.test.js

lint: lint-sol lint-frontend

lint-sol:
	npx solhint 'contracts/**/*.sol'

lint-frontend:
	cd frontend && npm run lint

# --- apps ------------------------------------------------------------------
build:
	cd frontend && npm run build

# Live backend smoke test. Uses a free port if 5000 is taken (macOS AirPlay).
# Kills the server even when a check fails (guarded kill).
smoke:
	cd backend && ( \
	  PORT=$(PORT) node server.js & SERVER_PID=$$!; \
	  for i in $$(seq 1 20); do \
	    if curl -sf http://localhost:$(PORT)/health >/dev/null 2>&1; then break; fi; \
	    sleep 0.5; \
	  done; \
	  curl -sf http://localhost:$(PORT)/health && \
	  curl -sf http://localhost:$(PORT)/api/voters; \
	  STATUS=$$?; kill $$SERVER_PID 2>/dev/null || true; exit $$STATUS \
	)

# --- end-to-end (local, ephemeral Hardhat network, no secrets) -------------
e2e-local:
	npx hardhat run scripts/e2e-local.js

# --- deploy ----------------------------------------------------------------
deploy-localhost:
	npx hardhat run scripts/deploy.js --network localhost

deploy-sepolia:
	npx hardhat run scripts/deploy.js --network sepolia

# Register a voter on the registry in deployments.json.
# Usage: make register [VOTER=0x...]  (defaults to deployer)
register:
	VOTER_ADDR="$(VOTER)" npx hardhat run scripts/registerVoter.js --network $(NETWORK)

verify:
	npx hardhat run scripts/verifyContracts.js --network $(NETWORK) 2>/dev/null || \
	  echo "verify: scripts/verifyContracts.js not present — verify on Etherscan manually"

# --- supply chain ----------------------------------------------------------
audit:
	npm audit --audit-level=high || true
	cd backend && npm audit --audit-level=high || true
	cd frontend && npm audit --audit-level=high || true

# --- full gate (mirrors CI) -------------------------------------------------
ci: compile test test-backend lint build smoke e2e-local
	@echo "GATE GREEN: compile + tests + backend + lint + build + smoke + e2e"

# --- clean (artifacts only; .env, deployments.json, DBs untouched) ---------
clean:
	rm -rf artifacts cache typechain-types
	rm -rf frontend/.next frontend/out
	find . -name "*.abi" -maxdepth 1 -delete
	find . -name "*.bin" -maxdepth 1 -delete
	@echo "cleaned (secrets, deployments.json and databases preserved)"
