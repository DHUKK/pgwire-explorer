# Shortcuts for the two halves of this repo: the Go decoder and proxy, and the
# site that renders what they record.
#
# Every target here is a thin wrapper over a command that works on its own. The
# real commands are in the README, so nothing is only runnable through make.

.DEFAULT_GOAL := help
SHELL := /bin/bash

.PHONY: help test test-go test-site check vet fmt typecheck build dev capture scenarios golden fuzz clean

help: ## List the targets
	@grep -hE '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sort | awk -F':.*## ' '{printf "  \033[1m%-12s\033[0m %s\n", $$1, $$2}'

# --- tests ------------------------------------------------------------------

test: test-go test-site ## Run every test, Go and site

test-go: ## Go tests: protocol decoding, byte-range invariants, golden replay, shipped captures
	go test ./...

test-site: site/node_modules ## Site tests: capture parser, state engine, scenario manifest
	cd site && npm test

check: vet test-go typecheck test-site ## Everything CI runs
	@echo "all checks passed"

vet: ## go vet and a gofmt check, which is what CI fails on
	go vet ./...
	@unformatted=$$(gofmt -l .); \
	if [ -n "$$unformatted" ]; then echo "gofmt needed:"; echo "$$unformatted"; exit 1; fi

typecheck: site/node_modules ## TypeScript, no emit
	cd site && npm run typecheck

# --- the site ---------------------------------------------------------------

dev: site/node_modules ## Serve the site at http://localhost:5173
	cd site && npm run dev

build: site/node_modules ## Production build into site/dist
	cd site && npm run build

# npm install is slow enough to be worth skipping when it has already run, so it
# hangs off the directory it creates rather than being its own phony target.
site/node_modules: site/package-lock.json
	cd site && npm install
	@touch site/node_modules

# --- recording --------------------------------------------------------------

capture: ## Record your own session. Listens on 5433, forwards to 5432, writes cap.json
	go run ./cmd/pgwire-capture --out cap.json

scenarios: ## Re-record every shipped example. Needs Docker running and psql on PATH
	scripts/generate-scenarios.sh
	go test ./internal/capture -run TestScenarios

golden: ## Accept new annotations for testdata/session.json after changing annotate.go
	go test ./internal/capture -update

# Not part of check or CI. Fuzzing is a search rather than a test, and a timed run
# fails with "context deadline exceeded" when the machine is too busy for its
# workers to report back. Two workers keeps that quiet on a loaded machine.
fuzz: ## Hunt for inputs that make Decode panic or annotate out of bounds
	go test ./internal/pgproto -run '^$$' -fuzz FuzzDecode -fuzztime=60s -parallel=2

clean: ## Remove build output and the site's dependencies
	rm -rf site/dist site/node_modules site/tsconfig.tsbuildinfo
