#!/usr/bin/env bash
# Runs every test suite for the AI Sales module and the existing-website regression checks.
#   ai-sales/run-tests.sh            regression + unit + database (+ browser if VENDOR_DIR is set)
# Browser tests need Playwright and local copies of the CDN libraries:
#   VENDOR_DIR=/path/with/supabase-supabase-js-2.49.4/... ai-sales/run-tests.sh
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
echo "== 1/4 Existing website regression (protected files + edge function)"; node --test "ai-sales/tests/regression/*.test.mjs" || fail=1
echo "== 2/4 Unit tests (scoring, phone, CSV, chunking, server functions)"; node --test "ai-sales/tests/unit/*.test.mjs" || fail=1
echo "== 3/4 Database migration tests (throwaway local Postgres)"; ai-sales/tests/db/run-db-tests.sh || fail=1
echo "== 4/4 Browser tests (phone / iPad / desktop)"; node --test --test-timeout=180000 ai-sales/tests/e2e/browser.test.mjs || fail=1
[ $fail = 0 ] && echo "ALL SUITES PASSED" || { echo "SOME SUITES FAILED"; exit 1; }
