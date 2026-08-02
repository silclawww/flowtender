#!/usr/bin/env bash
# Non-destructive security smoke test for a running Flowtender instance.
# Usage: FLOWTENDER_OPERATOR_KEY=... FLOWTENDER_API_KEY=... ./scripts/test-integration.sh [base-url]

set -u

BASE="${1:-http://localhost:3845}"
OPERATOR_KEY="${FLOWTENDER_OPERATOR_KEY:-}"
SERVICE_KEY="${FLOWTENDER_API_KEY:-}"
PASS=0
FAIL=0
RESPONSE_BODY=''
RESPONSE_STATUS=''

if [[ -z "$OPERATOR_KEY" || -z "$SERVICE_KEY" ]]; then
  echo 'FLOWTENDER_OPERATOR_KEY and FLOWTENDER_API_KEY are required.' >&2
  exit 2
fi

if [[ "$OPERATOR_KEY" == "$SERVICE_KEY" ]]; then
  echo 'Operator and service keys must be different.' >&2
  exit 2
fi

request() {
  local method="$1"
  local url="$2"
  shift 2
  local response
  response=$(curl --silent --show-error --request "$method" "$url" "$@" --write-out $'\n%{http_code}')
  RESPONSE_STATUS="${response##*$'\n'}"
  RESPONSE_BODY="${response%$'\n'*}"
}

check_status() {
  local name="$1"
  local expected="$2"
  if [[ "$RESPONSE_STATUS" == "$expected" ]]; then
    echo "  ✓ $name ($RESPONSE_STATUS)"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (expected $expected, got $RESPONSE_STATUS: ${RESPONSE_BODY:0:120})"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local name="$1"
  local expected="$2"
  if [[ "$RESPONSE_BODY" == *"$expected"* ]]; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name (body: ${RESPONSE_BODY:0:120})"
    FAIL=$((FAIL + 1))
  fi
}

check_no_metadata() {
  local name="$1"
  if [[ ! "$RESPONSE_BODY" =~ (execution_id|workflow_id|tender_id|customer|node_runs) ]]; then
    echo "  ✓ $name"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $name leaked metadata: ${RESPONSE_BODY:0:120}"
    FAIL=$((FAIL + 1))
  fi
}

echo '=== Flowtender pilot security smoke ==='
echo "Target: $BASE"

echo '1. Public health only'
request GET "$BASE/api/flow/health"
check_status 'health is public' 200
check_contains 'health reports ok' '"status":"ok"'
check_no_metadata 'health contains no tracking metadata'

request GET "$BASE/api/flow/webhook/tender-metadata"
check_status 'webhook GET is not a public health alias' 405

echo '2. Inspector pages fail closed'
for path in / /workflows /execution/00000000-0000-4000-8000-000000000000; do
  request GET "$BASE$path"
  check_status "unauthenticated $path" 401
  check_no_metadata "unauthenticated $path contains no metadata"
done

echo '3. Inspector APIs fail closed before lookup or retry'
request GET "$BASE/api/flow/executions"
check_status 'unauthenticated execution list' 401
check_no_metadata 'execution list denial contains no metadata'

request GET "$BASE/api/flow/status/00000000-0000-4000-8000-000000000000"
check_status 'unauthenticated guessed execution detail' 401
check_no_metadata 'execution detail denial contains no metadata'

request POST "$BASE/api/flow/retry/00000000-0000-4000-8000-000000000000"
check_status 'unauthenticated guessed retry' 401
check_no_metadata 'retry denial contains no metadata'

request GET "$BASE/api/flow/workflows"
check_status 'unauthenticated workflow list' 401
check_no_metadata 'workflow denial contains no metadata'

request GET "$BASE/api/flow/workflows/tender-stage2-requirements"
check_status 'unauthenticated workflow detail' 401
check_no_metadata 'workflow detail denial contains no metadata'

echo '4. Operator and service credentials stay separated'
request GET "$BASE/api/flow/executions" --header "Authorization: Bearer $SERVICE_KEY"
check_status 'service key cannot inspect executions' 401

request POST "$BASE/api/flow/webhook/tender-details" \
  --header "Authorization: Bearer $OPERATOR_KEY" \
  --header 'Content-Type: application/json' \
  --data '{}'
check_status 'operator key cannot invoke webhook' 401

request GET "$BASE/workflows" --user "operator:$OPERATOR_KEY"
check_status 'operator Basic auth can open inspector page' 200

request GET "$BASE/api/flow/workflows" --user "operator:$OPERATOR_KEY"
check_status 'browser Basic auth carries into inspector API fetches' 200

request GET "$BASE/api/flow/workflows" --header "Authorization: Bearer $OPERATOR_KEY"
check_status 'operator bearer can inspect safe workflow metadata' 200

echo '5. Dedicated webhook auth regression'
request POST "$BASE/api/flow/webhook/tender-details" \
  --header 'Content-Type: application/json' \
  --data '{}'
check_status 'unauthenticated webhook POST' 401

# An authenticated unknown path proves the service credential passed auth and reached
# webhook routing without starting a workflow or mutating production data.
request POST "$BASE/api/flow/webhook/security-smoke-unknown" \
  --header "Authorization: Bearer $SERVICE_KEY" \
  --header 'Content-Type: application/json' \
  --data '{}'
check_status 'service credential reaches webhook routing' 404
check_contains 'authenticated request receives routing result' 'Unknown webhook'

echo "=== Results: $PASS passed, $FAIL failed ==="
if [[ "$FAIL" -eq 0 ]]; then
  echo 'ALL TESTS PASSED'
  exit 0
fi

echo 'SOME TESTS FAILED'
exit 1
