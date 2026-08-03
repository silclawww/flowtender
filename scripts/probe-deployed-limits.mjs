#!/usr/bin/env node

import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { createServerClient } from '@supabase/ssr';

export const RAW_PDF_MAX_BYTES = 3_000_000;
export const FLOW_JSON_MAX_BYTES = 4_250_000;

const CONFIRMATION = 'CREATE_AND_DELETE_DISPOSABLE_P04_ROWS';
const RESPONSE_MAX_BYTES = 1_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'ProbeFailure';
    this.code = code;
  }
}

function requireCondition(condition, code) {
  if (!condition) throw new ProbeFailure(code);
}

function ascii(value) {
  return Buffer.from(value, 'ascii');
}

function renderPdf(paddingLength) {
  const chunks = [];
  const offsets = [];
  let length = 0;
  const append = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : ascii(value);
    chunks.push(chunk);
    length += chunk.length;
  };
  const object = (number, body) => {
    offsets[number] = length;
    append(`${number} 0 obj\n`);
    append(body);
    append('\nendobj\n');
  };

  append('%PDF-1.4\n');
  append(Buffer.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  object(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>');
  const content = 'BT\n/F1 12 Tf\n72 720 Td\n(P0.4 deployed boundary probe construction tender Berlin) Tj\n0 -18 Td\n(Buyer P0.4 Disposable Probe deadline 2099-12-31) Tj\nET\n';
  object(4, `<< /Length ${ascii(content).length} >>\nstream\n${content}endstream`);
  object(5, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  offsets[6] = length;
  append(`6 0 obj\n<< /Length ${paddingLength} >>\nstream\n`);
  append(Buffer.alloc(paddingLength, 0x20));
  append('\nendstream\nendobj\n');

  const xrefOffset = length;
  append('xref\n0 7\n0000000000 65535 f \n');
  for (let number = 1; number <= 6; number += 1) {
    append(`${String(offsets[number]).padStart(10, '0')} 00000 n \n`);
  }
  append(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.concat(chunks, length);
}

export function buildExactPdf(targetBytes) {
  requireCondition(Number.isSafeInteger(targetBytes) && targetBytes > 0, 'INVALID_PDF_TARGET');
  let paddingLength = Math.max(0, targetBytes - renderPdf(0).length);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const pdf = renderPdf(paddingLength);
    const difference = targetBytes - pdf.length;
    if (difference === 0) return pdf;
    paddingLength += difference;
    requireCondition(paddingLength >= 0, 'PDF_TARGET_TOO_SMALL');
  }
  throw new ProbeFailure('PDF_LENGTH_DID_NOT_CONVERGE');
}

export function buildExactJson(targetBytes) {
  requireCondition(Number.isSafeInteger(targetBytes) && targetBytes > 12, 'INVALID_JSON_TARGET');
  const prefix = ascii('{"probe":"');
  const suffix = ascii('"}');
  const payload = Buffer.alloc(targetBytes, 0x61);
  prefix.copy(payload, 0);
  suffix.copy(payload, targetBytes - suffix.length);
  return payload;
}

function requiredEnv(name) {
  const value = process.env[name];
  requireCondition(typeof value === 'string' && value.length > 0, `MISSING_${name}`);
  return value;
}

function deployedOrigin(name) {
  let url;
  try {
    url = new URL(requiredEnv(name));
  } catch {
    throw new ProbeFailure(`INVALID_${name}`);
  }
  requireCondition(url.protocol === 'https:', `INVALID_${name}`);
  requireCondition(!url.username && !url.password, `INVALID_${name}`);
  requireCondition(url.pathname === '/' && !url.search && !url.hash, `INVALID_${name}`);
  return url.origin;
}

async function optionalVercelCwd(name) {
  const value = process.env[name];
  if (!value) return null;
  const absolute = resolve(value);
  const details = await stat(absolute).catch(() => null);
  requireCondition(details?.isDirectory(), `INVALID_${name}`);
  return absolute;
}

async function configuration() {
  requireCondition(requiredEnv('P04_PROBE_CONFIRM') === CONFIRMATION, 'CONFIRMATION_REQUIRED');
  return {
    tenderlyOrigin: deployedOrigin('P04_PROBE_TENDERLY_ORIGIN'),
    flowtenderOrigin: deployedOrigin('P04_PROBE_FLOWTENDER_ORIGIN'),
    supabaseOrigin: deployedOrigin('P04_PROBE_SUPABASE_URL'),
    supabaseAnonKey: requiredEnv('P04_PROBE_SUPABASE_ANON_KEY'),
    supabaseServiceKey: requiredEnv('P04_PROBE_SUPABASE_SERVICE_ROLE_KEY'),
    flowtenderApiKey: requiredEnv('P04_PROBE_FLOWTENDER_API_KEY'),
    databaseUrl: requiredEnv('P04_PROBE_DATABASE_URL'),
    tenderlyVercelCwd: await optionalVercelCwd('P04_PROBE_TENDERLY_VERCEL_CWD'),
    flowtenderVercelCwd: await optionalVercelCwd('P04_PROBE_FLOWTENDER_VERCEL_CWD'),
  };
}

async function boundedResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new ProbeFailure('RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes);
}

async function directRequest(origin, path, options, timeoutMs, failureCode) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, origin), {
      method: options.method,
      headers: options.headers,
      body: options.body,
      redirect: 'manual',
      signal: controller.signal,
    });
    return { status: response.status, body: await boundedResponse(response) };
  } catch (error) {
    if (error instanceof ProbeFailure) throw error;
    throw new ProbeFailure(failureCode);
  } finally {
    clearTimeout(timeout);
  }
}

function curlQuote(value) {
  requireCondition(!/[\r\n]/.test(value), 'INVALID_HTTP_HEADER');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

let requestSequence = 0;
async function vercelRequest(origin, path, options, timeoutMs, failureCode, cwd, tempDirectory) {
  requestSequence += 1;
  const stem = `request-${requestSequence}`;
  const bodyPath = join(tempDirectory, `${stem}.body`);
  const responsePath = join(tempDirectory, `${stem}.response`);
  const configPath = join(tempDirectory, `${stem}.curlrc`);
  if (options.body) await writeFile(bodyPath, options.body, { flag: 'wx', mode: 0o600 });

  const curlConfig = [
    'silent',
    'show-error',
    `request = ${curlQuote(options.method)}`,
    `connect-timeout = ${curlQuote('20')}`,
    `max-time = ${curlQuote(String(Math.ceil(timeoutMs / 1000)))}`,
    `output = ${curlQuote(responsePath)}`,
    `write-out = ${curlQuote('P04_STATUS:%{http_code}')}`,
    ...Object.entries(options.headers).map(([name, value]) => (
      `header = ${curlQuote(`${name}: ${value}`)}`
    )),
    ...(options.body ? [`data-binary = ${curlQuote(`@${bodyPath}`)}`] : []),
    '',
  ].join('\n');
  await writeFile(configPath, curlConfig, { flag: 'wx', mode: 0o600 });

  const result = spawnSync('vercel', [
    '--cwd', cwd,
    '--no-color',
    '--non-interactive',
    'curl', path,
    '--deployment', origin,
    '--yes',
    '--', '--config', configPath,
  ], {
    encoding: 'utf8',
    env: process.env,
    timeout: timeoutMs + 10_000,
    maxBuffer: RESPONSE_MAX_BYTES,
  });
  requireCondition(result.status === 0 && !result.error, failureCode);
  const matches = [...result.stdout.matchAll(/P04_STATUS:(\d{3})/g)];
  requireCondition(matches.length > 0, failureCode);
  const details = await stat(responsePath).catch(() => null);
  requireCondition(details && details.size <= RESPONSE_MAX_BYTES, 'RESPONSE_TOO_LARGE');
  return {
    status: Number(matches.at(-1)[1]),
    body: await readFile(responsePath),
  };
}

async function deployedRequest(target, path, options, timeoutMs, failureCode, tempDirectory) {
  if (target.vercelCwd) {
    return vercelRequest(
      target.origin,
      path,
      options,
      timeoutMs,
      failureCode,
      target.vercelCwd,
      tempDirectory,
    );
  }
  return directRequest(target.origin, path, options, timeoutMs, failureCode);
}

function jsonBody(result, failureCode) {
  try {
    return JSON.parse(result.body.toString('utf8'));
  } catch {
    throw new ProbeFailure(failureCode);
  }
}

async function supabaseJson(config, path, options, failureCode) {
  const response = await directRequest(
    config.supabaseOrigin,
    path,
    options,
    30_000,
    failureCode,
  );
  requireCondition(options.expectedStatuses.includes(response.status), failureCode);
  if (response.body.length === 0) return null;
  return jsonBody(response, failureCode);
}

function serviceHeaders(config) {
  return {
    apikey: config.supabaseServiceKey,
    Authorization: `Bearer ${config.supabaseServiceKey}`,
    'Content-Type': 'application/json',
  };
}

async function createDisposableUser(config, runToken) {
  const password = `P04-${randomBytes(24).toString('base64url')}`;
  const email = `p04-limit-${runToken}@probe.invalid`;
  const user = await supabaseJson(config, '/auth/v1/admin/users', {
    method: 'POST',
    headers: serviceHeaders(config),
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        company_name: `P04 disposable ${runToken}`,
        full_name: 'P04 disposable probe',
        role: 'probe',
      },
    }),
    expectedStatuses: [200, 201],
  }, 'DISPOSABLE_USER_CREATE_FAILED');
  requireCondition(UUID.test(user?.id), 'DISPOSABLE_USER_CREATE_FAILED');
  return { email, password, userId: user.id.toLowerCase() };
}

async function authenticatedCookies(config, disposable) {
  const jar = new Map();
  const client = createServerClient(
    config.supabaseOrigin,
    config.supabaseAnonKey,
    {
      cookies: {
        getAll: () => [...jar].map(([name, value]) => ({ name, value })),
        setAll: (cookies) => {
          for (const cookie of cookies) {
            if (cookie.options?.maxAge === 0) jar.delete(cookie.name);
            else jar.set(cookie.name, cookie.value);
          }
        },
      },
      auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: true },
    },
  );
  const { data, error } = await client.auth.signInWithPassword({
    email: disposable.email,
    password: disposable.password,
  });
  requireCondition(!error && data.user?.id?.toLowerCase() === disposable.userId, 'DISPOSABLE_AUTH_FAILED');
  requireCondition(data.session?.access_token && jar.size > 0, 'DISPOSABLE_AUTH_FAILED');
  for (const [name, value] of jar) {
    requireCondition(!/[;\r\n]/.test(name) && !/[;\r\n]/.test(value), 'DISPOSABLE_AUTH_FAILED');
  }
  return {
    accessToken: data.session.access_token,
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

async function membershipRows(config, userId) {
  const query = new URLSearchParams({
    select: 'org_id',
    user_id: `eq.${userId}`,
    order: 'joined_at.asc',
    limit: '2',
  });
  return supabaseJson(config, `/rest/v1/org_members?${query}`, {
    method: 'GET',
    headers: serviceHeaders(config),
    body: undefined,
    expectedStatuses: [200],
  }, 'DISPOSABLE_ORG_LOOKUP_FAILED');
}

async function disposableOrg(config, disposable, auth) {
  let rows = await membershipRows(config, disposable.userId);
  if (Array.isArray(rows) && rows.length === 0) {
    await supabaseJson(config, '/rest/v1/rpc/ensure_user_org', {
      method: 'POST',
      headers: {
        apikey: config.supabaseAnonKey,
        Authorization: `Bearer ${auth.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
      expectedStatuses: [200],
    }, 'DISPOSABLE_ORG_CREATE_FAILED');
    rows = await membershipRows(config, disposable.userId);
  }
  requireCondition(Array.isArray(rows) && rows.length === 1 && UUID.test(rows[0]?.org_id), 'DISPOSABLE_ORG_LOOKUP_FAILED');
  return rows[0].org_id.toLowerCase();
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runSql(config, sql, failureCode) {
  const result = spawnSync('psql', [
    '--no-psqlrc',
    '--set', 'ON_ERROR_STOP=1',
    '--quiet',
    '--tuples-only',
    '--no-align',
  ], {
    input: sql,
    encoding: 'utf8',
    env: { ...process.env, PGDATABASE: config.databaseUrl, PGCONNECT_TIMEOUT: '15' },
    timeout: 30_000,
    maxBuffer: RESPONSE_MAX_BYTES,
  });
  requireCondition(result.status === 0 && !result.error, failureCode);
  return result.stdout.trim();
}

function snapshot(config, userId, orgId, correlations) {
  requireCondition(UUID.test(userId) && UUID.test(orgId), 'DATABASE_SNAPSHOT_FAILED');
  requireCondition(correlations.every((value) => OPAQUE_ID.test(value)), 'DATABASE_SNAPSHOT_FAILED');
  const correlationList = correlations.map(sqlLiteral).join(', ');
  const output = runSql(config, `
WITH probe_tenders AS (
  SELECT * FROM public.tenders WHERE org_id = ${sqlLiteral(orgId)}::uuid
), probe_admissions AS (
  SELECT * FROM public.pipeline_admissions
  WHERE actor_user_id = ${sqlLiteral(userId)}::uuid
    AND org_id = ${sqlLiteral(orgId)}::uuid
), probe_executions AS (
  SELECT execution.* FROM public.flow_executions AS execution
  WHERE execution.tender_id IN (SELECT id FROM probe_tenders)
     OR execution.id IN (
       SELECT root_execution_id FROM probe_admissions WHERE root_execution_id IS NOT NULL
     )
     OR execution.correlation_id IN (${correlationList})
), probe_nodes AS (
  SELECT node.* FROM public.flow_node_runs AS node
  WHERE node.execution_id IN (SELECT id FROM probe_executions)
)
SELECT json_build_object(
  'tenders', (SELECT count(*) FROM probe_tenders),
  'admissions', (SELECT count(*) FROM probe_admissions),
  'upload_admissions', (SELECT count(*) FROM probe_admissions WHERE operation = 'upload'),
  'claimed_admissions', (SELECT count(*) FROM probe_admissions WHERE claimed_at IS NOT NULL),
  'released_admissions', (SELECT count(*) FROM probe_admissions WHERE released_at IS NOT NULL),
  'executions', (SELECT count(*) FROM probe_executions),
  'stage1_pdf_done', (SELECT count(*) FROM probe_executions WHERE workflow_id = 'tender-stage1-pdf' AND status = 'done'),
  'linked_stage1', (SELECT count(*) FROM probe_executions WHERE workflow_id = 'tender-stage1-pdf' AND tender_id IN (SELECT id FROM probe_tenders)),
  'execution_errors', (SELECT count(*) FROM probe_executions WHERE status <> 'done'),
  'node_runs', (SELECT count(*) FROM probe_nodes),
  'node_errors', (SELECT count(*) FROM probe_nodes WHERE status <> 'done')
)::text;
`, 'DATABASE_SNAPSHOT_FAILED');
  try {
    return JSON.parse(output);
  } catch {
    throw new ProbeFailure('DATABASE_SNAPSHOT_FAILED');
  }
}

function assertStageOneSuccess(value) {
  requireCondition(value.tenders === 1, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(value.admissions === 1 && value.upload_admissions === 1, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(value.claimed_admissions === 1 && value.released_admissions === 1, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(value.executions === 1 && value.stage1_pdf_done === 1, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(value.linked_stage1 === 1 && value.execution_errors === 0, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(value.node_runs > 0 && value.node_errors === 0, 'STAGE1_DATABASE_PROOF_FAILED');
}

function unchanged(before, after, failureCode) {
  requireCondition(JSON.stringify(before) === JSON.stringify(after), failureCode);
}

function cleanupDatabase(config, userId, orgId, correlations) {
  requireCondition(UUID.test(userId), 'DATABASE_CLEANUP_FAILED');
  const orgSource = orgId && UUID.test(orgId)
    ? `SELECT ${sqlLiteral(orgId)}::uuid AS id UNION SELECT org_id FROM public.org_members WHERE user_id = ${sqlLiteral(userId)}::uuid`
    : `SELECT org_id AS id FROM public.org_members WHERE user_id = ${sqlLiteral(userId)}::uuid`;
  const correlationList = correlations.filter((value) => OPAQUE_ID.test(value)).map(sqlLiteral);
  const correlationClause = correlationList.length > 0
    ? `OR correlation_id IN (${correlationList.join(', ')})`
    : '';
  const output = runSql(config, `
BEGIN;
CREATE TEMP TABLE p04_orgs ON COMMIT DROP AS SELECT DISTINCT id FROM (${orgSource}) AS source;
CREATE TEMP TABLE p04_tenders ON COMMIT DROP AS
  SELECT id FROM public.tenders WHERE org_id IN (SELECT id FROM p04_orgs) OR user_id = ${sqlLiteral(userId)}::uuid;
CREATE TEMP TABLE p04_admissions ON COMMIT DROP AS
  SELECT id, root_execution_id FROM public.pipeline_admissions
  WHERE actor_user_id = ${sqlLiteral(userId)}::uuid OR org_id IN (SELECT id FROM p04_orgs);
CREATE TEMP TABLE p04_executions ON COMMIT DROP AS
  SELECT id FROM public.flow_executions
  WHERE tender_id IN (SELECT id FROM p04_tenders)
     OR id IN (SELECT root_execution_id FROM p04_admissions WHERE root_execution_id IS NOT NULL)
     ${correlationClause};
DELETE FROM public.flow_node_runs WHERE execution_id IN (SELECT id FROM p04_executions);
DELETE FROM public.flow_executions WHERE id IN (SELECT id FROM p04_executions);
DELETE FROM public.pipeline_admissions WHERE id IN (SELECT id FROM p04_admissions);
DELETE FROM public.tenders WHERE id IN (SELECT id FROM p04_tenders);
DELETE FROM public.org_requirement_completions WHERE org_id IN (SELECT id FROM p04_orgs);
DELETE FROM public.org_invites WHERE org_id IN (SELECT id FROM p04_orgs);
DELETE FROM public.company_profiles WHERE org_id IN (SELECT id FROM p04_orgs);
DELETE FROM public.org_members WHERE org_id IN (SELECT id FROM p04_orgs) OR user_id = ${sqlLiteral(userId)}::uuid;
DELETE FROM public.organisations WHERE id IN (SELECT id FROM p04_orgs);
DELETE FROM public.profiles WHERE id = ${sqlLiteral(userId)}::uuid;
SELECT json_build_object(
  'node_runs', (SELECT count(*) FROM public.flow_node_runs WHERE execution_id IN (SELECT id FROM p04_executions)),
  'executions', (SELECT count(*) FROM public.flow_executions WHERE id IN (SELECT id FROM p04_executions)),
  'admissions', (SELECT count(*) FROM public.pipeline_admissions WHERE id IN (SELECT id FROM p04_admissions)),
  'tenders', (SELECT count(*) FROM public.tenders WHERE id IN (SELECT id FROM p04_tenders)),
  'memberships', (SELECT count(*) FROM public.org_members WHERE org_id IN (SELECT id FROM p04_orgs) OR user_id = ${sqlLiteral(userId)}::uuid),
  'organisations', (SELECT count(*) FROM public.organisations WHERE id IN (SELECT id FROM p04_orgs)),
  'profiles', (SELECT count(*) FROM public.profiles WHERE id = ${sqlLiteral(userId)}::uuid)
)::text;
COMMIT;
`, 'DATABASE_CLEANUP_FAILED');
  let counts;
  try {
    counts = JSON.parse(output.split('\n').filter(Boolean).at(-1));
  } catch {
    throw new ProbeFailure('DATABASE_CLEANUP_FAILED');
  }
  requireCondition(Object.values(counts).every((value) => value === 0), 'DATABASE_CLEANUP_FAILED');
  return counts;
}

async function deleteDisposableUser(config, userId) {
  const response = await directRequest(config.supabaseOrigin, `/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: serviceHeaders(config),
    body: undefined,
  }, 30_000, 'DISPOSABLE_USER_DELETE_FAILED');
  requireCondition([200, 204].includes(response.status), 'DISPOSABLE_USER_DELETE_FAILED');
}

async function runProbe(config, tempDirectory, evidence, state) {
  const runToken = randomBytes(10).toString('hex');
  const flowExactCorrelation = `p04-limit-exact-${runToken}`;
  const flowOverCorrelation = `p04-limit-over-${runToken}`;
  state.correlations.push(flowExactCorrelation, flowOverCorrelation);

  const disposable = await createDisposableUser(config, runToken);
  state.userId = disposable.userId;
  const auth = await authenticatedCookies(config, disposable);
  state.orgId = await disposableOrg(config, disposable, auth);

  const tenderly = { origin: config.tenderlyOrigin, vercelCwd: config.tenderlyVercelCwd };
  const flowtender = { origin: config.flowtenderOrigin, vercelCwd: config.flowtenderVercelCwd };
  const uploadHeaders = (length) => ({
    Cookie: auth.cookie,
    'Content-Type': 'application/pdf',
    'Content-Length': String(length),
    'X-File-Name': encodeURIComponent('p04-deployed-boundary.pdf'),
    'X-File-Type': 'pdf',
  });

  const exactPdf = buildExactPdf(RAW_PDF_MAX_BYTES);
  const exactUpload = await deployedRequest(tenderly, '/api/upload', {
    method: 'POST',
    headers: uploadHeaders(exactPdf.length),
    body: exactPdf,
  }, 330_000, 'EXACT_PDF_REQUEST_FAILED', tempDirectory);
  requireCondition(exactUpload.status === 200, 'EXACT_PDF_NOT_ACCEPTED');
  const tender = jsonBody(exactUpload, 'EXACT_PDF_RESPONSE_INVALID');
  requireCondition(UUID.test(tender?.id) && tender?.org_id?.toLowerCase() === state.orgId, 'EXACT_PDF_RESPONSE_INVALID');
  const successState = snapshot(config, state.userId, state.orgId, state.correlations);
  assertStageOneSuccess(successState);
  evidence.checks.push({
    check: 'tenderly_exact_pdf_to_flowtender_stage1',
    request_bytes: exactPdf.length,
    response_status: exactUpload.status,
    stage1_status: 'done',
  });

  const oversizedPdf = buildExactPdf(RAW_PDF_MAX_BYTES + 1);
  const overUpload = await deployedRequest(tenderly, '/api/upload', {
    method: 'POST',
    headers: uploadHeaders(oversizedPdf.length),
    body: oversizedPdf,
  }, 60_000, 'OVERSIZED_PDF_REQUEST_FAILED', tempDirectory);
  requireCondition(overUpload.status === 413, 'OVERSIZED_PDF_NOT_REJECTED');
  const afterOverUpload = snapshot(config, state.userId, state.orgId, state.correlations);
  unchanged(successState, afterOverUpload, 'OVERSIZED_PDF_CREATED_ROWS');
  evidence.checks.push({
    check: 'tenderly_pdf_over_limit_prework_rejection',
    request_bytes: oversizedPdf.length,
    response_status: overUpload.status,
    scoped_database_delta: 0,
  });

  const flowHeaders = (length, correlationId) => ({
    Authorization: `Bearer ${config.flowtenderApiKey}`,
    'Content-Type': 'application/json',
    'Content-Length': String(length),
    'X-Correlation-Id': correlationId,
  });
  const unknownPath = `/api/flow/webhook/p04-limit-${runToken}`;
  const exactJson = buildExactJson(FLOW_JSON_MAX_BYTES);
  const exactFlow = await deployedRequest(flowtender, unknownPath, {
    method: 'POST',
    headers: flowHeaders(exactJson.length, flowExactCorrelation),
    body: exactJson,
  }, 60_000, 'EXACT_JSON_REQUEST_FAILED', tempDirectory);
  requireCondition(exactFlow.status === 404, 'EXACT_JSON_DID_NOT_REACH_ROUTING');
  const routingBody = jsonBody(exactFlow, 'EXACT_JSON_ROUTING_RESPONSE_INVALID');
  requireCondition(routingBody?.error === 'Unknown webhook', 'EXACT_JSON_ROUTING_RESPONSE_INVALID');
  const afterExactFlow = snapshot(config, state.userId, state.orgId, state.correlations);
  unchanged(afterOverUpload, afterExactFlow, 'EXACT_JSON_STARTED_WORKFLOW');
  evidence.checks.push({
    check: 'flowtender_exact_json_to_routing',
    request_bytes: exactJson.length,
    response_status: exactFlow.status,
    scoped_database_delta: 0,
  });

  const oversizedJson = buildExactJson(FLOW_JSON_MAX_BYTES + 1);
  const overFlow = await deployedRequest(flowtender, unknownPath, {
    method: 'POST',
    headers: flowHeaders(oversizedJson.length, flowOverCorrelation),
    body: oversizedJson,
  }, 60_000, 'OVERSIZED_JSON_REQUEST_FAILED', tempDirectory);
  requireCondition(overFlow.status === 413, 'OVERSIZED_JSON_NOT_REJECTED');
  const afterOverFlow = snapshot(config, state.userId, state.orgId, state.correlations);
  unchanged(afterExactFlow, afterOverFlow, 'OVERSIZED_JSON_CREATED_ROWS');
  evidence.checks.push({
    check: 'flowtender_json_over_limit_prework_rejection',
    request_bytes: oversizedJson.length,
    response_status: overFlow.status,
    scoped_database_delta: 0,
  });
}

export async function main() {
  const evidence = { probe: 'p04_deployed_limits', version: 1, ok: false, checks: [] };
  const state = { userId: null, orgId: null, correlations: [] };
  let config = null;
  let tempDirectory = null;
  let failure = null;
  let databaseCleanup = 'not_needed';
  let authCleanup = 'not_needed';
  let temporaryCleanup = 'not_needed';

  try {
    config = await configuration();
    tempDirectory = await mkdtemp(join(tmpdir(), 'p04-deployed-limits-'));
    await runProbe(config, tempDirectory, evidence, state);
  } catch (error) {
    failure = error instanceof ProbeFailure ? error : new ProbeFailure('UNEXPECTED_PROBE_FAILURE');
  } finally {
    if (config && state.userId) {
      try {
        cleanupDatabase(config, state.userId, state.orgId, state.correlations);
        databaseCleanup = 'complete';
      } catch {
        databaseCleanup = 'failed';
      }
      try {
        await deleteDisposableUser(config, state.userId);
        authCleanup = 'complete';
      } catch {
        authCleanup = 'failed';
      }
    }
    if (tempDirectory) {
      try {
        await rm(tempDirectory, { recursive: true, force: true });
        temporaryCleanup = 'complete';
      } catch {
        temporaryCleanup = 'failed';
      }
    }
  }

  evidence.cleanup = {
    database: databaseCleanup,
    auth_user: authCleanup,
    temporary_files: temporaryCleanup,
  };
  const cleanupOk = !state.userId
    || (databaseCleanup === 'complete' && authCleanup === 'complete');
  const temporaryOk = !tempDirectory || temporaryCleanup === 'complete';
  evidence.ok = failure === null && cleanupOk && temporaryOk;
  if (failure) evidence.error_code = failure.code;
  if (!cleanupOk || !temporaryOk) evidence.cleanup_error_code = 'CLEANUP_INCOMPLETE';
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  if (!evidence.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
