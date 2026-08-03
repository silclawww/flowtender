import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PDFParse } from 'pdf-parse';

import { codeExecutor } from '../lib/nodes/code.ts';
import {
  buildExactJson,
  buildExactCleanupSql,
  buildExactPdf,
  buildDatabasePgOptions,
  buildDatabaseProcessEnvironment,
  buildVercelCurlPlan,
  FLOW_JSON_MAX_BYTES,
  RAW_PDF_MAX_BYTES,
  SUPABASE_PROJECT_REF,
  validateDatabaseUrl,
  validateDeployedOrigin,
  validateSupabaseOrigin,
  validateVercelCwd,
  VERCEL_ORG_ID,
} from '../scripts/probe-deployed-limits.mjs';

test('deployed probe bodies have exact byte lengths and valid PDF/JSON semantics', async () => {
  const exactPdf = buildExactPdf(RAW_PDF_MAX_BYTES);
  const oversizedPdf = buildExactPdf(RAW_PDF_MAX_BYTES + 1);
  assert.equal(exactPdf.length, 3_000_000);
  assert.equal(oversizedPdf.length, 3_000_001);
  assert.match(exactPdf.toString('ascii', 0, 16), /^%PDF-1\.4/);
  assert.match(exactPdf.toString('ascii', -64), /%%EOF\n$/);

  const workflow = JSON.parse(readFileSync(
    new URL('../workflows/tender-stage1-pdf.json', import.meta.url),
    'utf8',
  )) as { nodes: Array<{ id: string; config: { code?: string } }> };
  const extractCode = workflow.nodes.find((node) => node.id === 'extract-text')?.config.code;
  assert.ok(extractCode);
  const output = await codeExecutor.execute(
    { code: extractCode },
    [{ json: { file_data: exactPdf.toString('base64') } }],
    new Map(),
  );
  assert.equal(output[0][0].json.page_count, 1);
  assert.match(String(output[0][0].json.pdf_text), /P0\.4 deployed boundary probe/);

  const parser = new PDFParse({ data: oversizedPdf });
  try {
    const parsed = await parser.getText();
    assert.equal(parsed.total, 1);
    assert.match(parsed.text, /P0\.4 deployed boundary probe/);
  } finally {
    await parser.destroy();
  }

  for (const size of [FLOW_JSON_MAX_BYTES, FLOW_JSON_MAX_BYTES + 1]) {
    const body = buildExactJson(size);
    assert.equal(body.length, size);
    const value = JSON.parse(body.toString('utf8')) as { probe?: unknown };
    assert.equal(typeof value.probe, 'string');
    assert.deepEqual(Object.keys(value), ['probe']);
  }
});

test('deployed probe hard-binds every credential-bearing HTTP origin', () => {
  assert.equal(
    validateDeployedOrigin('tenderly', 'https://tenderly-agent.vercel.app'),
    'https://tenderly-agent.vercel.app',
  );
  assert.equal(
    validateDeployedOrigin(
      'flowtender',
      'https://flowtender-git-p04-abc123-silclaws-projects.vercel.app',
    ),
    'https://flowtender-git-p04-abc123-silclaws-projects.vercel.app',
  );
  assert.equal(
    validateSupabaseOrigin(`https://${SUPABASE_PROJECT_REF}.supabase.co`),
    `https://${SUPABASE_PROJECT_REF}.supabase.co`,
  );

  for (const origin of [
    'https://attacker.example',
    'https://tenderly-agent.vercel.app.attacker.example',
    'https://tenderly-agent.vercel.app:444',
    'http://tenderly-agent.vercel.app',
    'https://tenderly-agent.vercel.app/api/upload',
    'https://tenderly-agent-abc-another-team.vercel.app',
  ]) {
    assert.throws(() => validateDeployedOrigin('tenderly', origin));
  }
  assert.throws(() => validateSupabaseOrigin('https://another-project.supabase.co'));
  assert.throws(() => validateSupabaseOrigin(
    `https://${SUPABASE_PROJECT_REF}.supabase.co.attacker.example`,
  ));
});

test('database URLs are bound to the deployed Supabase project', () => {
  const direct = `postgresql://postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const shortLivedDirect = `postgresql://cli_login_postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const pooler = `postgres://postgres.${SUPABASE_PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`;
  assert.equal(validateDatabaseUrl(direct), direct);
  assert.equal(validateDatabaseUrl(shortLivedDirect), shortLivedDirect);
  assert.equal(validateDatabaseUrl(pooler), pooler);

  for (const value of [
    'postgresql://postgres:secret@db.other-project.supabase.co:5432/postgres',
    'postgresql://postgres:secret@attacker.example:5432/postgres',
    'postgresql://postgres.other-project:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres',
    `postgresql://cli_login_postgres:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=require`,
    `postgresql://cli_login_postgres.other:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`,
    `postgresql://cli_login_postgres:secret@db.other-project.supabase.co:5432/postgres?sslmode=require`,
    `postgresql://cli_login_postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`,
    `postgresql://postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres`,
    `postgresql://postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require&sslmode=require`,
    `postgresql://postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?sslmode=disable`,
    `postgresql://postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/other`,
    `postgresql://postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?application_name=probe`,
  ]) {
    assert.throws(() => validateDatabaseUrl(value));
  }
});

test('short-lived CLI database role composes only with its exact direct URL', () => {
  const shortLivedDirect = `postgresql://cli_login_postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const normalDirect = `postgresql://postgres:secret@db.${SUPABASE_PROJECT_REF}.supabase.co:5432/postgres?sslmode=require`;
  const pooler = `postgres://postgres.${SUPABASE_PROJECT_REF}:secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`;

  assert.equal(buildDatabasePgOptions(shortLivedDirect), '-c role=postgres');
  assert.equal(
    buildDatabasePgOptions(shortLivedDirect, { readOnly: true }),
    '-c role=postgres -c default_transaction_read_only=on',
  );
  assert.equal(buildDatabasePgOptions(normalDirect), null);
  assert.equal(buildDatabasePgOptions(pooler), null);
  assert.equal(
    buildDatabasePgOptions(normalDirect, { readOnly: true }),
    '-c default_transaction_read_only=on',
  );
  assert.equal(
    buildDatabasePgOptions(pooler, { readOnly: true }),
    '-c default_transaction_read_only=on',
  );
});

test('database URL becomes a controlled libpq environment with no ambient connection state', () => {
  const ambient: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    PATH: '/safe/bin',
    PGHOST: 'ambient-host',
    PGPORT: '9999',
    PGUSER: 'ambient-user',
    PGPASSWORD: 'ambient-password',
    PGDATABASE: 'ambient-database',
    PGSSLMODE: 'disable',
    PGOPTIONS: '-c role=ambient',
    PGSERVICE: 'ambient-service',
    PGSERVICEFILE: '/ambient/service.conf',
    PGPASSFILE: '/ambient/passfile',
    PGSSLROOTCERT: '/ambient/root.crt',
    PGSSLCERT: '/ambient/client.crt',
    PGSSLKEY: '/ambient/client.key',
    PGCHANNELBINDING: 'disable',
    PGTARGETSESSIONATTRS: 'read-write',
    PGFOO: 'ambient-extension',
  };
  const cliDirect = `postgresql://cli_login_postgres:s%40cr%3Aet@db.${SUPABASE_PROJECT_REF}.supabase.co/postgres?sslmode=require`;
  const directEnvironment = buildDatabaseProcessEnvironment(cliDirect, {
    ambient,
    readOnly: true,
  });

  assert.deepEqual(directEnvironment, {
    NODE_ENV: 'test',
    PATH: '/safe/bin',
    PGHOST: `db.${SUPABASE_PROJECT_REF}.supabase.co`,
    PGPORT: '5432',
    PGUSER: 'cli_login_postgres',
    PGPASSWORD: 's@cr:et',
    PGDATABASE: 'postgres',
    PGSSLMODE: 'require',
    PGCONNECT_TIMEOUT: '15',
    PGOPTIONS: '-c role=postgres -c default_transaction_read_only=on',
  });

  const pooler = `postgres://postgres.${SUPABASE_PROJECT_REF}:pool%20secret@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres?sslmode=verify-full`;
  const poolerEnvironment = buildDatabaseProcessEnvironment(pooler, { ambient });
  assert.equal(poolerEnvironment.PGHOST, 'aws-0-ap-southeast-1.pooler.supabase.com');
  assert.equal(poolerEnvironment.PGPORT, '6543');
  assert.equal(poolerEnvironment.PGUSER, `postgres.${SUPABASE_PROJECT_REF}`);
  assert.equal(poolerEnvironment.PGPASSWORD, 'pool secret');
  assert.equal(poolerEnvironment.PGDATABASE, 'postgres');
  assert.equal(poolerEnvironment.PGSSLMODE, 'verify-full');
  assert.equal(Object.hasOwn(poolerEnvironment, 'PGOPTIONS'), false);
});

test('Vercel CLI directories must be linked to the exact team and project', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'p04-vercel-binding-'));
  try {
    await mkdir(join(directory, '.vercel'));
    await writeFile(join(directory, '.vercel', 'project.json'), JSON.stringify({
      orgId: VERCEL_ORG_ID,
      projectId: 'prj_mZPi4oO3m5AfGwDQpGzmm7z6Wxem',
    }));
    assert.equal(await validateVercelCwd('flowtender', directory), directory);
    await writeFile(join(directory, '.vercel', 'project.json'), JSON.stringify({
      orgId: VERCEL_ORG_ID,
      projectId: 'prj_wrong',
    }));
    await assert.rejects(validateVercelCwd('flowtender', directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Vercel CLI 54 receives curl-first args, a real cwd, and HTTP/1.1 config', () => {
  const plan = buildVercelCurlPlan(
    'https://flowtender.vercel.app',
    '/api/flow/webhook/p04-limit-token',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer test-key' },
      body: Buffer.from('{}'),
    },
    60_000,
    '/linked/flowtender',
    {
      bodyPath: '/tmp/request.body',
      configPath: '/tmp/request.curlrc',
      responsePath: '/tmp/request.response',
    },
  );

  assert.deepEqual(plan.args, [
    'curl',
    '/api/flow/webhook/p04-limit-token',
    '--deployment',
    'https://flowtender.vercel.app',
    '--',
    '--config',
    '/tmp/request.curlrc',
  ]);
  assert.equal(plan.cwd, '/linked/flowtender');
  assert.match(plan.curlConfig, /^http1\.1$/m);
  assert.match(plan.curlConfig, /^data-binary = "@\/tmp\/request\.body"$/m);
  assert.doesNotMatch(plan.args.join(' '), /--cwd|--no-color|--non-interactive/);
});

test('cleanup SQL deletes only captured IDs and the composite node identity', () => {
  const executionId = '66666666-6666-4666-8666-666666666666';
  const sql = buildExactCleanupSql({
    user_ids: ['11111111-1111-4111-8111-111111111111'],
    org_ids: ['22222222-2222-4222-8222-222222222222'],
    membership_ids: ['33333333-3333-4333-8333-333333333333'],
    tender_ids: ['44444444-4444-4444-8444-444444444444'],
    admissions: [{ id: '55555555-5555-4555-8555-555555555555' }],
    executions: [{ id: executionId }],
    nodes: [{ execution_id: executionId, stage: 'trigger' }],
  }, {
    correlations: ['p04-limit-exact-token', 'p04-limit-over-token'],
    email: 'p04-limit-token@probe.invalid',
    orgName: 'P04 disposable token',
  });

  assert.match(sql, /DELETE FROM public\.flow_node_runs WHERE \(execution_id, stage\) IN/);
  assert.match(sql, new RegExp(executionId));
  assert.match(sql, /DELETE FROM public\.org_members WHERE id = '33333333/);
  assert.doesNotMatch(sql, /CREATE TEMP TABLE/);
  assert.doesNotMatch(sql, /SELECT org_id FROM public\.org_members WHERE user_id/);
  assert.doesNotMatch(sql, /DELETE FROM public\.org_members WHERE \(org_id/);
});

test('database parity is verified before mutation and gates cleanup', () => {
  const source = readFileSync(
    new URL('../scripts/probe-deployed-limits.mjs', import.meta.url),
    'utf8',
  );
  assert.ok(source.indexOf('verifyDatabaseParity(config);') < source.indexOf('await runProbe('));
  assert.match(source, /if \(config && databaseVerified && state\.userCreateAttempted\)/);
  assert.match(source, /raw_app_meta_data->>'p04_probe_token'/);
  assert.doesNotMatch(source, /['"]--yes['"]/);
});
