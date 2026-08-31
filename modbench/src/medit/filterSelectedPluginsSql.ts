// Filter to Selected Plugins — the ordinary record filter (ADR-0018), pre-restricted to a
// plugin-name set drawn from the Plugins-tree selection (adopted from xEdit's own
// mniNavFilterApplySelected, xeMainForm.pas:13976-14027). `records` is the base documents table
// (form_key, plugin, origin, record_type, ... — MEditService.Core/Records/TableDdlBuilder.cs), so
// one query against it covers every record type a selected plugin owns; ADR-0018's per-type
// UNION ALL macro layer (deferred, "users write UNION ALL manually") is unnecessary here because
// `records` itself, not a per-type view, is the query target.
//
// Pure and DuckDB-only — no vscode import, so it is unit-testable without a VS Code harness.

/** Quote-escapes a single SQL string literal, DuckDB/standard-SQL style: an embedded `'` is
 *  doubled so it neither terminates the literal early nor breaks out of the surrounding
 *  `IN (...)` list. A mod filename can contain an apostrophe (e.g. "Bob's Armory.esp"). */
function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Builds `SELECT form_key FROM records WHERE plugin IN (...)`, scoped to `pluginNames`. The
 *  caller (the `modbench.pluginListTree.filterToSelected` command handler) is the guard against
 *  an empty selection — this throws rather than silently emit `IN ()`, which DuckDB would reject
 *  anyway, so a missed guard fails loudly here instead of surfacing as an opaque backend error. */
export function buildSelectedPluginsFilterSql(pluginNames: string[]): string {
  if (pluginNames.length === 0) {
    throw new Error('buildSelectedPluginsFilterSql: pluginNames must not be empty');
  }
  const list = pluginNames.map(quoteSqlLiteral).join(', ');
  return `SELECT form_key FROM records WHERE plugin IN (${list})`;
}
