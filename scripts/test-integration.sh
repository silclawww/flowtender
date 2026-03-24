#!/bin/bash
# Integration test for flowtender
# Usage: ./scripts/test-integration.sh [host:port]
# Default: localhost:3845

BASE="${1:-http://localhost:3845}"
PASS=0
FAIL=0

check() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if echo "$actual" | grep -q "$expected"; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (expected '$expected', got: ${actual:0:100})"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== flowtender integration tests ==="
echo "Target: $BASE"
echo ""

echo "1. Health check"
resp=$(curl -s "$BASE/api/flow/webhook/tender-metadata")
check "GET /api/flow/webhook/* returns ok" '"ok"' "$resp"

echo ""
echo "2. Executions list"
resp=$(curl -s "$BASE/api/flow/executions")
check "GET /api/flow/executions returns array" '\[' "$resp"

echo ""
echo "3. Workflow list check (verify JSON files exist)"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKFLOWS_DIR="$(dirname "$SCRIPT_DIR")/workflows"
for wf in tender-stage1-gaeb tender-stage1-pdf tender-stage2-requirements tender-stage3-evaluation; do
  if [ -f "$WORKFLOWS_DIR/$wf.json" ]; then
    echo "  ✓ workflows/$wf.json exists"
    PASS=$((PASS + 1))
  else
    echo "  ✗ workflows/$wf.json MISSING"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "4. Stage 1 webhook (GAEB with minimal payload)"
TENDER_ID=$(python3 -c "import uuid; print(uuid.uuid4())" 2>/dev/null || cat /proc/sys/kernel/random/uuid)
resp=$(curl -s -X POST "$BASE/api/flow/webhook/tender-metadata" \
  -H "Content-Type: application/json" \
  -d "{\"tender_id\":\"$TENDER_ID\",\"file_type\":\"archive\",\"org_id\":\"4013e1c5-8f38-4c66-8085-58b09e1c9b33\",\"user_id\":\"b2f40a4d-1b9b-432d-9b4a-8dc30353e849\",\"gaeb_files\":[],\"documents\":[],\"has_plans\":false,\"archive_summary\":{},\"source_filename\":\"test.avasign\"}" \
  --max-time 30)
check "Stage 1 GAEB returns processing_status" 'metadata_ready\|execution_id' "$resp"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
if [ $FAIL -eq 0 ]; then
  echo "ALL TESTS PASSED"
  exit 0
else
  echo "SOME TESTS FAILED"
  exit 1
fi
