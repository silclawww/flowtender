interface QueryError {
  code?: string;
  message?: string;
}

interface QueryResult<T> {
  data: T | null;
  error: QueryError | null;
}

type SingleQueryClassification<T> =
  | { kind: 'found'; data: T }
  | { kind: 'not_found' }
  | { kind: 'operational_error' };

type ListQueryClassification<T> =
  | { kind: 'found'; data: T[] }
  | { kind: 'operational_error' };

/** PGRST116 is PostgREST's zero-row result for a `.single()` query. */
export function classifySingleQuery<T>(
  result: QueryResult<T>,
): SingleQueryClassification<T> {
  if (result.error?.code === 'PGRST116') return { kind: 'not_found' };
  if (result.error || result.data == null) return { kind: 'operational_error' };
  return { kind: 'found', data: result.data };
}

export function classifyListQuery<T>(
  result: QueryResult<T[]>,
): ListQueryClassification<T> {
  if (result.error || !Array.isArray(result.data)) return { kind: 'operational_error' };
  return { kind: 'found', data: result.data };
}
