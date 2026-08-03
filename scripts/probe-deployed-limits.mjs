#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
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
export const SUPABASE_PROJECT_REF = 'eltpxayfieksnnsglvuj';
export const VERCEL_ORG_ID = 'team_HVy4se0N5dTsQ3k7iALoGJh9';
const TARGETS = {
  tenderly: {
    canonicalHost: 'tenderly-agent.vercel.app',
    previewHost: /^tenderly-agent-[a-z0-9-]+-silclaws-projects\.vercel\.app$/,
    projectId: 'prj_HoCaPX8fU6XDTXGNnXq1ELq2P5UT',
  },
  flowtender: {
    canonicalHost: 'flowtender.vercel.app',
    previewHost: /^flowtender-[a-z0-9-]+-silclaws-projects\.vercel\.app$/,
    projectId: 'prj_mZPi4oO3m5AfGwDQpGzmm7z6Wxem',
  },
};

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

export function validateDeployedOrigin(target, value) {
  const binding = TARGETS[target];
  requireCondition(binding, 'INVALID_DEPLOYED_TARGET');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeFailure(`INVALID_${target.toUpperCase()}_ORIGIN`);
  }
  const error = `INVALID_${target.toUpperCase()}_ORIGIN`;
  requireCondition(url.protocol === 'https:' && !url.port, error);
  requireCondition(!url.username && !url.password, error);
  requireCondition(url.pathname === '/' && !url.search && !url.hash, error);
  requireCondition(
    url.hostname === binding.canonicalHost || binding.previewHost.test(url.hostname),
    error,
  );
  return url.origin;
}

export function validateSupabaseOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeFailure('INVALID_P04_PROBE_SUPABASE_URL');
  }
  requireCondition(
    url.href === `https://${SUPABASE_PROJECT_REF}.supabase.co/`,
    'INVALID_P04_PROBE_SUPABASE_URL',
  );
  return url.origin;
}

export function validateDatabaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new ProbeFailure('INVALID_P04_PROBE_DATABASE_URL');
  }
  const error = 'INVALID_P04_PROBE_DATABASE_URL';
  const protocolOk = url.protocol === 'postgres:' || url.protocol === 'postgresql:';
  const username = decodeURIComponent(url.username);
  const direct = url.hostname === `db.${SUPABASE_PROJECT_REF}.supabase.co`
    && (username === 'postgres' || username === 'cli_login_postgres')
    && (!url.port || url.port === '5432');
  const pooler = /^(?:aws-\d+-)?[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)
    && username === `postgres.${SUPABASE_PROJECT_REF}`
    && (!url.port || url.port === '5432' || url.port === '6543');
  requireCondition(protocolOk && (direct || pooler), error);
  requireCondition(Boolean(url.password) && url.pathname === '/postgres' && !url.hash, error);
  const sslModes = url.searchParams.getAll('sslmode');
  requireCondition(
    [...url.searchParams].length === 1
      && sslModes.length === 1
      && (sslModes[0] === 'require' || sslModes[0] === 'verify-full'),
    error,
  );
  return value;
}

export function buildDatabasePgOptions(value, { readOnly = false } = {}) {
  const url = new URL(validateDatabaseUrl(value));
  const settings = [];
  if (
    url.hostname === `db.${SUPABASE_PROJECT_REF}.supabase.co`
      && decodeURIComponent(url.username) === 'cli_login_postgres'
  ) {
    settings.push('role=postgres');
  }
  if (readOnly) settings.push('default_transaction_read_only=on');
  return settings.length > 0 ? settings.map((setting) => `-c ${setting}`).join(' ') : null;
}

export function buildDatabaseProcessEnvironment(
  value,
  { readOnly = false, ambient = process.env } = {},
) {
  const url = new URL(validateDatabaseUrl(value));
  const environment = { ...ambient };
  for (const name of [
    'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE', 'PGOPTIONS',
  ]) {
    delete environment[name];
  }
  const pgOptions = buildDatabasePgOptions(value, { readOnly });
  return {
    ...environment,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: 'postgres',
    PGSSLMODE: url.searchParams.get('sslmode'),
    PGCONNECT_TIMEOUT: '15',
    ...(pgOptions ? { PGOPTIONS: pgOptions } : {}),
  };
}

export async function validateVercelCwd(target, value) {
  if (!value) return null;
  const binding = TARGETS[target];
  requireCondition(binding, 'INVALID_DEPLOYED_TARGET');
  const absolute = resolve(value);
  const details = await stat(absolute).catch(() => null);
  const error = `INVALID_${target.toUpperCase()}_VERCEL_CWD`;
  requireCondition(details?.isDirectory(), error);
  let project;
  try {
    project = JSON.parse(await readFile(join(absolute, '.vercel', 'project.json'), 'utf8'));
  } catch {
    throw new ProbeFailure(error);
  }
  requireCondition(
    project?.orgId === VERCEL_ORG_ID && project?.projectId === binding.projectId,
    error,
  );
  return absolute;
}

async function configuration() {
  requireCondition(requiredEnv('P04_PROBE_CONFIRM') === CONFIRMATION, 'CONFIRMATION_REQUIRED');
  const databaseUrl = validateDatabaseUrl(requiredEnv('P04_PROBE_DATABASE_URL'));
  return {
    tenderlyOrigin: validateDeployedOrigin('tenderly', requiredEnv('P04_PROBE_TENDERLY_ORIGIN')),
    flowtenderOrigin: validateDeployedOrigin('flowtender', requiredEnv('P04_PROBE_FLOWTENDER_ORIGIN')),
    supabaseOrigin: validateSupabaseOrigin(requiredEnv('P04_PROBE_SUPABASE_URL')),
    supabaseAnonKey: requiredEnv('P04_PROBE_SUPABASE_ANON_KEY'),
    supabaseServiceKey: requiredEnv('P04_PROBE_SUPABASE_SERVICE_ROLE_KEY'),
    flowtenderApiKey: requiredEnv('P04_PROBE_FLOWTENDER_API_KEY'),
    databaseUrl,
    tenderlyVercelCwd: await validateVercelCwd(
      'tenderly',
      process.env.P04_PROBE_TENDERLY_VERCEL_CWD,
    ),
    flowtenderVercelCwd: await validateVercelCwd(
      'flowtender',
      process.env.P04_PROBE_FLOWTENDER_VERCEL_CWD,
    ),
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

export function buildVercelCurlPlan(origin, path, options, timeoutMs, cwd, files) {
  const { bodyPath, configPath, responsePath } = files;
  return {
    args: ['curl', path, '--deployment', origin, '--', '--config', configPath],
    cwd,
    curlConfig: [
      'silent',
      'show-error',
      'http1.1',
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
    ].join('\n'),
  };
}

let requestSequence = 0;
async function vercelRequest(origin, path, options, timeoutMs, failureCode, cwd, tempDirectory) {
  requestSequence += 1;
  const stem = `request-${requestSequence}`;
  const bodyPath = join(tempDirectory, `${stem}.body`);
  const responsePath = join(tempDirectory, `${stem}.response`);
  const configPath = join(tempDirectory, `${stem}.curlrc`);
  if (options.body) await writeFile(bodyPath, options.body, { flag: 'wx', mode: 0o600 });

  const plan = buildVercelCurlPlan(origin, path, options, timeoutMs, cwd, {
    bodyPath, configPath, responsePath,
  });
  await writeFile(configPath, plan.curlConfig, { flag: 'wx', mode: 0o600 });

  const result = spawnSync('vercel', plan.args, {
    cwd: plan.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI: '1',
      NO_COLOR: '1',
      VERCEL_TELEMETRY_DISABLED: '1',
    },
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

async function createDisposableUser(config, state) {
  const password = `P04-${randomBytes(24).toString('base64url')}`;
  state.userCreateAttempted = true;
  const user = await supabaseJson(config, '/auth/v1/admin/users', {
    method: 'POST',
    headers: serviceHeaders(config),
    body: JSON.stringify({
      email: state.email,
      password,
      email_confirm: true,
      user_metadata: {
        company_name: state.orgName,
        full_name: 'P04 disposable probe',
        role: 'probe',
      },
      app_metadata: { p04_probe_token: state.runToken },
    }),
    expectedStatuses: [200, 201],
  }, 'DISPOSABLE_USER_CREATE_FAILED');
  requireCondition(UUID.test(user?.id), 'DISPOSABLE_USER_CREATE_FAILED');
  return { email: state.email, password, userId: user.id.toLowerCase() };
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

async function ensureDisposableOrg(config, auth) {
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
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function runSql(config, sql, failureCode, { readOnly = false } = {}) {
  const result = spawnSync('psql', [
    '--no-psqlrc',
    '--set', 'ON_ERROR_STOP=1',
    '--quiet',
    '--tuples-only',
    '--no-align',
  ], {
    input: sql,
    encoding: 'utf8',
    env: buildDatabaseProcessEnvironment(config.databaseUrl, { readOnly }),
    timeout: 30_000,
    maxBuffer: RESPONSE_MAX_BYTES,
  });
  requireCondition(result.status === 0 && !result.error, failureCode);
  return result.stdout.trim();
}

function verifyDatabaseParity(config) {
  const sentinel = runSql(config, `
BEGIN READ ONLY;
SELECT CASE WHEN current_database() = 'postgres'
  AND to_regclass('public.profiles') IS NOT NULL
  AND to_regclass('public.organisations') IS NOT NULL
  AND to_regclass('public.org_members') IS NOT NULL
  AND to_regclass('public.tenders') IS NOT NULL
  AND to_regclass('public.flow_executions') IS NOT NULL
  AND to_regclass('public.flow_node_runs') IS NOT NULL
  AND to_regclass('public.pipeline_admissions') IS NOT NULL
  AND to_regclass('public.company_profiles') IS NOT NULL
  AND to_regclass('public.org_invites') IS NOT NULL
  AND to_regclass('public.org_requirement_completions') IS NOT NULL
  AND to_regprocedure('public.ensure_user_org()') IS NOT NULL
  AND to_regprocedure('public.handle_new_user()') IS NOT NULL
  AND to_regprocedure('public.acquire_pipeline_admission(uuid,uuid,text,uuid)') IS NOT NULL
  AND to_regprocedure('public.claim_pipeline_admission(uuid,uuid,uuid,text,uuid)') IS NOT NULL
  AND to_regprocedure('public.release_pipeline_admission(uuid)') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.flow_executions'::regclass
      AND attname = 'correlation_id' AND NOT attisdropped
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.flow_executions'::regclass
      AND attname = 'trigger_payload' AND NOT attisdropped
  )
  AND EXISTS (
    SELECT 1
    FROM pg_trigger AS trigger
    WHERE trigger.tgrelid = 'auth.users'::regclass
      AND trigger.tgname = 'on_auth_user_created'
      AND trigger.tgenabled <> 'D'
      AND trigger.tgfoid = 'public.handle_new_user()'::regprocedure
  )
THEN 'flowtender-p04-schema-v1' ELSE 'mismatch' END;
ROLLBACK;
`, 'DATABASE_PARITY_FAILED', { readOnly: true });
  requireCondition(
    sentinel.split('\n').filter(Boolean).includes('flowtender-p04-schema-v1'),
    'DATABASE_PARITY_FAILED',
  );
}

function discoverScope(config, state, failureCode = 'DATABASE_SNAPSHOT_FAILED') {
  requireCondition(OPAQUE_ID.test(state.runToken), failureCode);
  requireCondition(state.correlations.every((value) => OPAQUE_ID.test(value)), failureCode);
  const correlations = state.correlations.map(sqlLiteral).join(', ');
  const output = runSql(config, `
BEGIN READ ONLY;
WITH run_user AS (
  SELECT id FROM auth.users
  WHERE lower(email) = lower(${sqlLiteral(state.email)})
    AND raw_app_meta_data->>'p04_probe_token' = ${sqlLiteral(state.runToken)}
    AND raw_user_meta_data->>'company_name' = ${sqlLiteral(state.orgName)}
), run_membership AS (
  SELECT member.id, member.org_id, member.user_id
  FROM public.org_members AS member
  JOIN run_user AS probe_user ON probe_user.id = member.user_id
  JOIN public.organisations AS organisation ON organisation.id = member.org_id
  WHERE member.role = 'owner'
    AND organisation.name = ${sqlLiteral(state.orgName)}
    AND organisation.type = 'personal'
    AND NOT EXISTS (
      SELECT 1 FROM public.org_members AS other
      WHERE other.org_id = member.org_id AND other.id <> member.id
    )
), run_org AS (
  SELECT organisation.id
  FROM public.organisations AS organisation
  JOIN run_membership AS member ON member.org_id = organisation.id
), run_tenders AS (
  SELECT tender.id
  FROM public.tenders AS tender
  WHERE tender.org_id IN (SELECT id FROM run_org)
    AND tender.source_filename = ${sqlLiteral(state.fileName)}
    AND tender.created_at >= ${sqlLiteral(state.startedAt)}::timestamptz
    AND (tender.user_id IS NULL OR tender.user_id IN (SELECT id FROM run_user))
), run_admissions AS (
  SELECT admission.id, admission.root_execution_id, admission.claimed_at, admission.released_at
  FROM public.pipeline_admissions AS admission
  WHERE admission.actor_user_id IN (SELECT id FROM run_user)
    AND admission.org_id IN (SELECT id FROM run_org)
    AND admission.operation = 'upload'
    AND admission.admitted_at >= ${sqlLiteral(state.startedAt)}::timestamptz
), run_executions AS (
  SELECT execution.* FROM public.flow_executions AS execution
  WHERE execution.tender_id IN (SELECT id FROM run_tenders)
     OR execution.id IN (
       SELECT root_execution_id FROM run_admissions WHERE root_execution_id IS NOT NULL
     )
     OR execution.correlation_id IN (${correlations})
), run_nodes AS (
  SELECT node.* FROM public.flow_node_runs AS node
  WHERE node.execution_id IN (SELECT id FROM run_executions)
)
SELECT json_build_object(
  'user_ids', COALESCE((SELECT json_agg(id ORDER BY id) FROM run_user), '[]'::json),
  'org_ids', COALESCE((SELECT json_agg(id ORDER BY id) FROM run_org), '[]'::json),
  'membership_ids', COALESCE((SELECT json_agg(id ORDER BY id) FROM run_membership), '[]'::json),
  'profile_count', (SELECT count(*) FROM public.profiles WHERE id IN (SELECT id FROM run_user) AND lower(email) = lower(${sqlLiteral(state.email)})),
  'named_org_count', (SELECT count(*) FROM public.organisations WHERE name = ${sqlLiteral(state.orgName)}),
  'user_membership_count', (SELECT count(*) FROM public.org_members WHERE user_id IN (SELECT id FROM run_user)),
  'tender_ids', COALESCE((SELECT json_agg(id ORDER BY id) FROM run_tenders), '[]'::json),
  'admissions', COALESCE((SELECT json_agg(json_build_object(
    'id', id, 'root_execution_id', root_execution_id,
    'claimed', claimed_at IS NOT NULL, 'released', released_at IS NOT NULL
  ) ORDER BY id) FROM run_admissions), '[]'::json),
  'executions', COALESCE((SELECT json_agg(json_build_object(
    'id', id, 'tender_id', tender_id, 'workflow_id', workflow_id,
    'status', status, 'correlation_id', correlation_id
  ) ORDER BY id) FROM run_executions), '[]'::json),
  'nodes', COALESCE((SELECT json_agg(json_build_object(
    'execution_id', execution_id, 'stage', stage, 'status', status
  ) ORDER BY execution_id, stage) FROM run_nodes), '[]'::json),
  'unexpected_tenders', (SELECT count(*) FROM public.tenders
    WHERE (org_id IN (SELECT id FROM run_org) OR user_id IN (SELECT id FROM run_user))
      AND id NOT IN (SELECT id FROM run_tenders)),
  'unexpected_admissions', (SELECT count(*) FROM public.pipeline_admissions
    WHERE (actor_user_id IN (SELECT id FROM run_user) OR org_id IN (SELECT id FROM run_org))
      AND id NOT IN (SELECT id FROM run_admissions)),
  'unexpected_executions', (SELECT count(*) FROM run_executions
    WHERE (tender_id IS NULL OR tender_id NOT IN (SELECT id FROM run_tenders))
      AND id NOT IN (SELECT root_execution_id FROM run_admissions WHERE root_execution_id IS NOT NULL)),
  'company_profiles', (SELECT count(*) FROM public.company_profiles WHERE org_id IN (SELECT id FROM run_org)),
  'org_invites', (SELECT count(*) FROM public.org_invites WHERE org_id IN (SELECT id FROM run_org)),
  'requirement_completions', (SELECT count(*) FROM public.org_requirement_completions WHERE org_id IN (SELECT id FROM run_org))
)::text;
ROLLBACK;
`, failureCode, { readOnly: true });
  try {
    return JSON.parse(output.split('\n').map((line) => line.trim()).find((line) => line.startsWith('{')));
  } catch {
    throw new ProbeFailure(failureCode);
  }
}

function assertOwnedScope(scope, state, { allowMissing = false } = {}) {
  const missing = scope.user_ids.length === 0;
  if (missing) {
    requireCondition(
      allowMissing
        && scope.org_ids.length === 0
        && scope.membership_ids.length === 0
        && scope.profile_count === 0
        && scope.named_org_count === 0
        && scope.user_membership_count === 0
        && scope.tender_ids.length === 0
        && scope.admissions.length === 0
        && scope.executions.length === 0
        && scope.nodes.length === 0
        && scope.unexpected_tenders === 0
        && scope.unexpected_admissions === 0
        && scope.unexpected_executions === 0
        && scope.company_profiles === 0
        && scope.org_invites === 0
        && scope.requirement_completions === 0,
      'DISPOSABLE_SCOPE_INVALID',
    );
    return false;
  }
  requireCondition(scope.user_ids.length === 1 && scope.org_ids.length === 1, 'DISPOSABLE_SCOPE_INVALID');
  requireCondition(scope.membership_ids.length === 1 && scope.profile_count === 1, 'DISPOSABLE_SCOPE_INVALID');
  requireCondition(scope.named_org_count === 1 && scope.user_membership_count === 1, 'DISPOSABLE_SCOPE_INVALID');
  requireCondition(
    scope.unexpected_tenders === 0
      && scope.unexpected_admissions === 0
      && scope.unexpected_executions === 0,
    'DISPOSABLE_SCOPE_INVALID',
  );
  requireCondition(
    scope.company_profiles === 0 && scope.org_invites === 0 && scope.requirement_completions === 0,
    'DISPOSABLE_SCOPE_INVALID',
  );
  if (state.userId) requireCondition(scope.user_ids[0] === state.userId, 'DISPOSABLE_SCOPE_INVALID');
  if (state.orgId) requireCondition(scope.org_ids[0] === state.orgId, 'DISPOSABLE_SCOPE_INVALID');
  state.userId = scope.user_ids[0];
  state.orgId = scope.org_ids[0];
  state.membershipId = scope.membership_ids[0];
  return true;
}

function assertFreshScope(scope, state) {
  assertOwnedScope(scope, state);
  requireCondition(
    scope.tender_ids.length === 0
      && scope.admissions.length === 0
      && scope.executions.length === 0
      && scope.nodes.length === 0,
    'DISPOSABLE_SCOPE_NOT_EMPTY',
  );
}

function assertStageOneSuccess(scope, state, tenderId) {
  assertOwnedScope(scope, state);
  const expectedStages = [
    'extract-metadata-llm', 'extract-text', 'parse-metadata', 'respond', 'save', 'trigger',
  ];
  requireCondition(scope.tender_ids.length === 1 && scope.tender_ids[0] === tenderId, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(scope.admissions.length === 1, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(scope.admissions[0].claimed && scope.admissions[0].released, 'STAGE1_DATABASE_PROOF_FAILED');
  requireCondition(scope.executions.length === 1, 'STAGE1_DATABASE_PROOF_FAILED');
  const execution = scope.executions[0];
  requireCondition(
    execution.id === scope.admissions[0].root_execution_id
      && execution.tender_id === tenderId
      && execution.workflow_id === 'tender-stage1-pdf'
      && execution.status === 'done',
    'STAGE1_DATABASE_PROOF_FAILED',
  );
  requireCondition(
    JSON.stringify(scope.nodes.map((node) => node.stage)) === JSON.stringify(expectedStages)
      && scope.nodes.every((node) => node.execution_id === execution.id && node.status === 'done'),
    'STAGE1_DATABASE_PROOF_FAILED',
  );
  state.capturedScope = scope;
}

function unchanged(before, after, failureCode) {
  requireCondition(JSON.stringify(before) === JSON.stringify(after), failureCode);
}

function exactPredicate(column, values, pattern = UUID) {
  requireCondition(values.every((value) => pattern.test(value)), 'DATABASE_CLEANUP_FAILED');
  requireCondition(new Set(values).size === values.length, 'DATABASE_CLEANUP_FAILED');
  return values.length > 0
    ? `${column} IN (${values.map(sqlLiteral).join(', ')})`
    : 'FALSE';
}

function exactDelete(table, predicate, expected) {
  return `
DO $delete$ DECLARE affected bigint; BEGIN
  DELETE FROM public.${table} WHERE ${predicate};
  GET DIAGNOSTICS affected = ROW_COUNT;
  IF affected <> ${expected} THEN RAISE EXCEPTION 'P04 exact cleanup count mismatch'; END IF;
END $delete$;`;
}

export function buildExactCleanupSql(scope, state) {
  const userId = scope.user_ids[0];
  const orgId = scope.org_ids[0];
  const membershipId = scope.membership_ids[0];
  requireCondition(UUID.test(userId) && UUID.test(orgId) && UUID.test(membershipId), 'DATABASE_CLEANUP_FAILED');
  const executionIds = scope.executions.map((row) => row.id);
  const admissionIds = scope.admissions.map((row) => row.id);
  const nodePairs = scope.nodes.map((row) => {
    requireCondition(UUID.test(row.execution_id) && /^[A-Za-z0-9_-]{1,128}$/.test(row.stage), 'DATABASE_CLEANUP_FAILED');
    return `(${sqlLiteral(row.execution_id)}::uuid, ${sqlLiteral(row.stage)})`;
  });
  const nodes = nodePairs.length > 0
    ? `(execution_id, stage) IN (${nodePairs.join(', ')})`
    : 'FALSE';
  const executions = exactPredicate('id', executionIds);
  const admissions = exactPredicate('id', admissionIds);
  const tenders = exactPredicate('id', scope.tender_ids);
  const correlations = state.correlations.map(sqlLiteral).join(', ');
  return `
BEGIN ISOLATION LEVEL SERIALIZABLE;
DO $verify$ BEGIN
  IF (SELECT count(*) FROM public.flow_node_runs WHERE ${exactPredicate('execution_id', executionIds)}) <> ${scope.nodes.length}
    OR (SELECT count(*) FROM public.flow_executions WHERE ${executions}) <> ${executionIds.length}
    OR (SELECT count(*) FROM public.pipeline_admissions WHERE ${admissions}) <> ${admissionIds.length}
    OR (SELECT count(*) FROM public.tenders WHERE ${tenders}) <> ${scope.tender_ids.length}
    OR (SELECT count(*) FROM public.org_members WHERE id = ${sqlLiteral(membershipId)}::uuid AND org_id = ${sqlLiteral(orgId)}::uuid AND user_id = ${sqlLiteral(userId)}::uuid) <> 1
    OR (SELECT count(*) FROM public.organisations WHERE id = ${sqlLiteral(orgId)}::uuid AND name = ${sqlLiteral(state.orgName)} AND type = 'personal') <> 1
    OR (SELECT count(*) FROM public.profiles WHERE id = ${sqlLiteral(userId)}::uuid AND lower(email) = lower(${sqlLiteral(state.email)})) <> 1
    OR EXISTS (SELECT 1 FROM public.flow_node_runs WHERE ${exactPredicate('execution_id', executionIds)} AND NOT (${nodes}))
    OR EXISTS (SELECT 1 FROM public.tenders WHERE (org_id = ${sqlLiteral(orgId)}::uuid OR user_id = ${sqlLiteral(userId)}::uuid) AND NOT (${tenders}))
    OR EXISTS (SELECT 1 FROM public.pipeline_admissions WHERE (actor_user_id = ${sqlLiteral(userId)}::uuid OR org_id = ${sqlLiteral(orgId)}::uuid) AND NOT (${admissions}))
    OR EXISTS (SELECT 1 FROM public.flow_executions WHERE correlation_id IN (${correlations}) AND NOT (${executions}))
    OR EXISTS (SELECT 1 FROM public.org_members WHERE (org_id = ${sqlLiteral(orgId)}::uuid OR user_id = ${sqlLiteral(userId)}::uuid) AND id <> ${sqlLiteral(membershipId)}::uuid)
    OR EXISTS (SELECT 1 FROM public.company_profiles WHERE org_id = ${sqlLiteral(orgId)}::uuid)
    OR EXISTS (SELECT 1 FROM public.org_invites WHERE org_id = ${sqlLiteral(orgId)}::uuid)
    OR EXISTS (SELECT 1 FROM public.org_requirement_completions WHERE org_id = ${sqlLiteral(orgId)}::uuid)
  THEN RAISE EXCEPTION 'P04 exact cleanup ownership mismatch'; END IF;
END $verify$;
${exactDelete('flow_node_runs', nodes, scope.nodes.length)}
${exactDelete('flow_executions', executions, executionIds.length)}
${exactDelete('pipeline_admissions', admissions, admissionIds.length)}
${exactDelete('tenders', tenders, scope.tender_ids.length)}
${exactDelete('org_members', `id = ${sqlLiteral(membershipId)}::uuid AND org_id = ${sqlLiteral(orgId)}::uuid AND user_id = ${sqlLiteral(userId)}::uuid`, 1)}
${exactDelete('organisations', `id = ${sqlLiteral(orgId)}::uuid AND name = ${sqlLiteral(state.orgName)} AND type = 'personal'`, 1)}
${exactDelete('profiles', `id = ${sqlLiteral(userId)}::uuid AND lower(email) = lower(${sqlLiteral(state.email)})`, 1)}
DO $zero$ BEGIN
  IF EXISTS (SELECT 1 FROM public.flow_node_runs WHERE ${exactPredicate('execution_id', executionIds)})
    OR EXISTS (SELECT 1 FROM public.flow_executions WHERE ${executions})
    OR EXISTS (SELECT 1 FROM public.pipeline_admissions WHERE ${admissions})
    OR EXISTS (SELECT 1 FROM public.tenders WHERE ${tenders})
    OR EXISTS (SELECT 1 FROM public.org_members WHERE id = ${sqlLiteral(membershipId)}::uuid)
    OR EXISTS (SELECT 1 FROM public.organisations WHERE id = ${sqlLiteral(orgId)}::uuid)
    OR EXISTS (SELECT 1 FROM public.profiles WHERE id = ${sqlLiteral(userId)}::uuid)
  THEN RAISE EXCEPTION 'P04 exact cleanup left rows'; END IF;
END $zero$;
SELECT 'flowtender-p04-clean-v1';
COMMIT;
`;
}

function cleanupDatabase(config, state) {
  const scope = discoverScope(config, state, 'DATABASE_CLEANUP_DISCOVERY_FAILED');
  if (!assertOwnedScope(scope, state, { allowMissing: true })) {
    state.userId = null;
    return 'not_needed';
  }
  if (state.capturedScope) unchanged(state.capturedScope, scope, 'DATABASE_CLEANUP_SCOPE_CHANGED');
  const result = runSql(config, buildExactCleanupSql(scope, state), 'DATABASE_CLEANUP_FAILED');
  requireCondition(result.split('\n').includes('flowtender-p04-clean-v1'), 'DATABASE_CLEANUP_FAILED');
  return 'complete';
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
  const [flowExactCorrelation, flowOverCorrelation] = state.correlations;
  const disposable = await createDisposableUser(config, state);
  state.userId = disposable.userId;
  const auth = await authenticatedCookies(config, disposable);
  await ensureDisposableOrg(config, auth);
  assertFreshScope(discoverScope(config, state), state);

  const tenderly = { origin: config.tenderlyOrigin, vercelCwd: config.tenderlyVercelCwd };
  const flowtender = { origin: config.flowtenderOrigin, vercelCwd: config.flowtenderVercelCwd };
  const uploadHeaders = (length) => ({
    Cookie: auth.cookie,
    'Content-Type': 'application/pdf',
    'Content-Length': String(length),
    'X-File-Name': encodeURIComponent(state.fileName),
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
  const tenderId = typeof tender?.id === 'string' ? tender.id.toLowerCase() : '';
  requireCondition(
    UUID.test(tenderId)
      && typeof tender?.org_id === 'string'
      && tender.org_id.toLowerCase() === state.orgId,
    'EXACT_PDF_RESPONSE_INVALID',
  );
  const successState = discoverScope(config, state);
  assertStageOneSuccess(successState, state, tenderId);
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
  const afterOverUpload = discoverScope(config, state);
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
  const unknownPath = `/api/flow/webhook/p04-limit-${state.runToken}`;
  const exactJson = buildExactJson(FLOW_JSON_MAX_BYTES);
  const exactFlow = await deployedRequest(flowtender, unknownPath, {
    method: 'POST',
    headers: flowHeaders(exactJson.length, flowExactCorrelation),
    body: exactJson,
  }, 60_000, 'EXACT_JSON_REQUEST_FAILED', tempDirectory);
  requireCondition(exactFlow.status === 404, 'EXACT_JSON_DID_NOT_REACH_ROUTING');
  const routingBody = jsonBody(exactFlow, 'EXACT_JSON_ROUTING_RESPONSE_INVALID');
  requireCondition(routingBody?.error === 'Unknown webhook', 'EXACT_JSON_ROUTING_RESPONSE_INVALID');
  const afterExactFlow = discoverScope(config, state);
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
  const afterOverFlow = discoverScope(config, state);
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
  const runToken = randomBytes(10).toString('hex');
  const state = {
    runToken,
    email: `p04-limit-${runToken}@probe.invalid`,
    orgName: `P04 disposable ${runToken}`,
    fileName: `p04-deployed-boundary-${runToken}.pdf`,
    startedAt: new Date().toISOString(),
    correlations: [`p04-limit-exact-${runToken}`, `p04-limit-over-${runToken}`],
    userCreateAttempted: false,
    userId: null,
    orgId: null,
    membershipId: null,
    capturedScope: null,
  };
  let config = null;
  let databaseVerified = false;
  let tempDirectory = null;
  let failure = null;
  let databaseCleanup = 'not_needed';
  let authCleanup = 'not_needed';
  let temporaryCleanup = 'not_needed';

  try {
    config = await configuration();
    verifyDatabaseParity(config);
    databaseVerified = true;
    tempDirectory = await mkdtemp(join(tmpdir(), 'p04-deployed-limits-'));
    await runProbe(config, tempDirectory, evidence, state);
  } catch (error) {
    failure = error instanceof ProbeFailure ? error : new ProbeFailure('UNEXPECTED_PROBE_FAILURE');
  } finally {
    if (config && databaseVerified && state.userCreateAttempted) {
      try {
        databaseCleanup = cleanupDatabase(config, state);
      } catch {
        databaseCleanup = 'failed';
      }
      if (databaseCleanup === 'complete' && state.userId) {
        try {
          await deleteDisposableUser(config, state.userId);
          authCleanup = 'complete';
        } catch {
          authCleanup = 'failed';
        }
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
  const cleanupOk = !state.userCreateAttempted
    || (databaseCleanup === 'not_needed' && !state.userId)
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
