import { createServiceClient } from '@/lib/supabase/service';
import type { NodeExecutor, ExecutionItem, ExecutionContext } from '@/types/execution';

// Evaluate {{ expression }} templates against context
function evalTemplate(template: string, input: ExecutionItem[], context: ExecutionContext): unknown {
  if (typeof template !== 'string') return template;
  
  // Check if the entire string is a template expression
  const fullMatch = template.match(/^\{\{\s*([\s\S]+?)\s*\}\}$/);
  if (fullMatch) {
    // Return the evaluated value (preserves type — can return object/array/number)
    return evalExpr(fullMatch[1], input, context);
  }
  
  // Otherwise replace inline templates
  return template.replace(/\{\{\s*([\s\S]+?)\s*\}\}/g, (_m, expr) => {
    const val = evalExpr(expr, input, context);
    return val === null || val === undefined ? '' : String(val);
  });
}

function evalExpr(expr: string, input: ExecutionItem[], context: ExecutionContext): unknown {
  const $input = { first: () => input[0] || { json: {} }, all: () => input };
  const $json = $input.first().json;
  const $ = (nodeId: string) => ({
    first: () => context.get(nodeId)?.[0] || { json: {} },
    all: () => context.get(nodeId) || [],
  });
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('$input', '$json', '$', 'JSON', `return (${expr})`);
    return fn($input, $json, $, JSON);
  } catch {
    return null;
  }
}

type FilterCondition = {
  column: string;
  operator?: string; // eq, neq, gt, lt, gte, lte, like, ilike, in — default: eq
  value: unknown;
};

function applyFilters(
  query: ReturnType<ReturnType<typeof createServiceClient>['from']>['select'],
  filters: FilterCondition[]
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let q: any = query;
  for (const f of filters) {
    const op = f.operator || 'eq';
    switch (op) {
      case 'eq': q = q.eq(f.column, f.value); break;
      case 'neq': q = q.neq(f.column, f.value); break;
      case 'gt': q = q.gt(f.column, f.value); break;
      case 'lt': q = q.lt(f.column, f.value); break;
      case 'gte': q = q.gte(f.column, f.value); break;
      case 'lte': q = q.lte(f.column, f.value); break;
      default: q = q.eq(f.column, f.value);
    }
  }
  return q;
}

// supabase.query — SELECT rows with optional filters
// Config: { table: string, filters?: FilterCondition[], select?: string, single?: boolean }
export const supabaseQueryExecutor: NodeExecutor = {
  async execute(config, input, context) {
    const supabase = createServiceClient();
    const table = evalTemplate(config.table as string, input, context) as string;
    const selectCols = (config.select as string) || '*';
    const filters = ((config.filters as FilterCondition[]) || []).map(f => ({
      ...f,
      value: evalTemplate(String(f.value), input, context),
    }));
    const single = config.single === true;
    
    let query = supabase.from(table).select(selectCols);
    query = applyFilters(query, filters);
    
    if (single) {
      const { data, error } = await query.single();
      if (error) throw new Error(`supabase.query error: ${error.message}`);
      return [[{ json: data as Record<string, unknown> }]];
    } else {
      const { data, error } = await query;
      if (error) throw new Error(`supabase.query error: ${error.message}`);
      return [((data || []) as Record<string, unknown>[]).map(row => ({ json: row }))];
    }
  }
};

// supabase.upsert — INSERT or UPDATE (upsert by primary key)
// Config: { table: string, data: 'auto_map' | Record<string,unknown>, on_conflict?: string }
export const supabaseUpsertExecutor: NodeExecutor = {
  async execute(config, input, context) {
    const supabase = createServiceClient();
    const table = evalTemplate(config.table as string, input, context) as string;
    
    let data: Record<string, unknown>;
    if (config.data === 'auto_map' || !config.data) {
      // Use the full $json as the row data
      data = input[0]?.json || {};
    } else if (typeof config.data === 'object') {
      // Evaluate each field value
      data = {};
      for (const [k, v] of Object.entries(config.data as Record<string, unknown>)) {
        data[k] = evalTemplate(String(v), input, context);
      }
    } else {
      data = input[0]?.json || {};
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: result, error } = await (supabase
      .from(table) as any)
      .upsert(data, { onConflict: (config.on_conflict as string) || 'id' })
      .select()
      .single();
    
    if (error) throw new Error(`supabase.upsert error: ${error.message}`);
    return [[{ json: (result || data) as Record<string, unknown> }]];
  }
};

// supabase.update — UPDATE rows matching filters
// Config: { table: string, filters: FilterCondition[], data: 'auto_map' | Record<string,unknown> }
export const supabaseUpdateExecutor: NodeExecutor = {
  async execute(config, input, context) {
    const supabase = createServiceClient();
    const table = evalTemplate(config.table as string, input, context) as string;
    const filters = ((config.filters as FilterCondition[]) || []).map(f => ({
      ...f,
      value: evalTemplate(String(f.value), input, context),
    }));
    
    let data: Record<string, unknown>;
    if (config.data === 'auto_map' || !config.data) {
      data = input[0]?.json || {};
    } else if (typeof config.data === 'object') {
      data = {};
      for (const [k, v] of Object.entries(config.data as Record<string, unknown>)) {
        data[k] = typeof v === 'string' ? evalTemplate(v, input, context) : v;
      }
    } else {
      data = input[0]?.json || {};
    }
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (supabase.from(table) as any).update(data).select();
    query = applyFilters(query, filters);
    
    const { data: result, error } = await query;
    if (error) throw new Error(`supabase.update error: ${error.message}`);
    const rows = (result || []) as Record<string, unknown>[];
    return [rows.length > 0 ? rows.map(r => ({ json: r })) : [{ json: data }]];
  }
};

export const supabaseExecutors: Record<string, NodeExecutor> = {
  'supabase.query': supabaseQueryExecutor,
  'supabase.upsert': supabaseUpsertExecutor,
  'supabase.update': supabaseUpdateExecutor,
};
