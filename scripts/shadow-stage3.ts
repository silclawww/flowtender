#!/usr/bin/env npx ts-node

import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { loadWorkflow } from '../lib/runner/loader.ts';
import { runStage3ShadowEvaluation } from '../lib/shadow/stage3.ts';
import { createServiceClient } from '../lib/supabase/service.ts';

const args = process.argv.slice(2);
type ReadResult = { data: Record<string, unknown> | null; error: unknown };

function option(name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
}

function assertEnvironment(): void {
  for (const name of [
    'NEXT_PUBLIC_SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'GEMINI_API_KEY',
  ]) {
    if (!process.env[name]) throw new Error(`Missing ${name}`);
  }
}

function privateOutputDirectory(value: string): string {
  if (!path.isAbsolute(value)) throw new Error('Output directory must be absolute');
  const outputDirectory = path.resolve(value);
  const repository = path.resolve(process.cwd());
  if (outputDirectory === repository || outputDirectory.startsWith(`${repository}${path.sep}`)) {
    throw new Error('Shadow artifacts must be stored outside the repository');
  }
  return outputDirectory;
}

async function ensurePrivateOutputDirectory(outputDirectory: string): Promise<void> {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const [directoryInfo, realOutputDirectory, realRepository] = await Promise.all([
    lstat(outputDirectory),
    realpath(outputDirectory),
    realpath(process.cwd()),
  ]);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error('Shadow output path must be a private directory, not a link');
  }
  if (realOutputDirectory === realRepository
    || realOutputDirectory.startsWith(`${realRepository}${path.sep}`)) {
    throw new Error('Shadow artifacts must be stored outside the repository');
  }
  if ((directoryInfo.mode & 0o077) !== 0) {
    throw new Error('Shadow output directory must not grant group or public access');
  }
}

async function main(): Promise<void> {
  if (args.includes('--help')) {
    console.log('Usage: shadow-stage3 --tender UUID --source-org UUID --profile-org UUID --profile-label LABEL --output-dir /absolute/private/path');
    return;
  }

  assertEnvironment();
  const tenderId = option('--tender');
  const sourceOrgId = option('--source-org');
  const profileOrgId = option('--profile-org');
  const profileLabel = option('--profile-label');
  const outputDirectory = privateOutputDirectory(option('--output-dir'));
  await ensurePrivateOutputDirectory(outputDirectory);
  const supabase = createServiceClient();

  const tenderResult = await supabase
    .from('tenders')
    .select('id,org_id,requirements,requirements_coverage,region,value_breakdown,item_count')
    .eq('id', tenderId)
    .eq('org_id', sourceOrgId)
    .single() as unknown as ReadResult;
  if (tenderResult.error || !tenderResult.data) throw new Error('Shadow tender not found');

  const profileResult = await supabase
    .from('company_profiles')
    .select('*')
    .eq('org_id', profileOrgId)
    .single() as unknown as ReadResult;
  if (profileResult.error || !profileResult.data) throw new Error('Shadow profile not found');

  const tender = {
    id: tenderResult.data.id,
    requirements: tenderResult.data.requirements,
    requirements_coverage: tenderResult.data.requirements_coverage,
    region: tenderResult.data.region,
    value_breakdown: tenderResult.data.value_breakdown,
    item_count: tenderResult.data.item_count,
  };
  const artifact = await runStage3ShadowEvaluation({
    workflow: loadWorkflow('tender-stage3-evaluation'),
    tender,
    profile: profileResult.data,
    sourceOrgId,
    profileOrgId,
    profileLabel,
  });

  const timestamp = artifact.run.generated_at.replace(/[:.]/g, '-');
  const filename = `${timestamp}-${tenderId}-${profileLabel}-${artifact.run.id}.json`;
  const outputPath = path.join(outputDirectory, filename);
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });

  console.log(JSON.stringify({
    artifact: outputPath,
    tender_id: tenderId,
    profile: profileLabel,
    score: artifact.output.strategic_fit_score,
    recommendation: artifact.output.bid_recommendation,
    model_calls: artifact.execution.model_calls,
    customer_visible_mutations: artifact.customer_visible_mutations,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Shadow evaluation failed');
  process.exitCode = 1;
});
