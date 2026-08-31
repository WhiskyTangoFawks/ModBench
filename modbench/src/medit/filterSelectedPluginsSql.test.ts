import { describe, it, expect } from 'vitest';
import { buildSelectedPluginsFilterSql } from './filterSelectedPluginsSql';

// The ordinary record filter, pre-restricted to the plugin(s) the tree selection names —
// `records` is the base documents table (form_key, plugin, ... — TableDdlBuilder.cs), so one
// query against it covers every record type a selected plugin owns, with no need for the
// per-type UNION ALL ADR-0018 explicitly deferred for cross-type queries.
describe('buildSelectedPluginsFilterSql', () => {
  it('builds a form_key filter scoped to a single plugin', () => {
    expect(buildSelectedPluginsFilterSql(['TestMod.esp']))
      .toBe("SELECT form_key FROM records WHERE plugin IN ('TestMod.esp')");
  });

  it('builds an IN-list for multiple plugins', () => {
    expect(buildSelectedPluginsFilterSql(['A.esp', 'B.esp']))
      .toBe("SELECT form_key FROM records WHERE plugin IN ('A.esp', 'B.esp')");
  });

  // AC: "Plugin names are escaped safely in the generated SQL; a name containing a quote is
  // covered by a test." A mod filename can contain an apostrophe (e.g. a translator's "Bob's
  // Armory.esp") — standard SQL escaping doubles the embedded quote so it terminates neither the
  // literal early nor breaks out of the IN-list.
  it('escapes an embedded single quote by doubling it', () => {
    expect(buildSelectedPluginsFilterSql(["Bob's Armory.esp"]))
      .toBe("SELECT form_key FROM records WHERE plugin IN ('Bob''s Armory.esp')");
  });

  it('escapes multiple embedded quotes in one name', () => {
    expect(buildSelectedPluginsFilterSql(["'quoted'.esp"]))
      .toBe("SELECT form_key FROM records WHERE plugin IN ('''quoted''.esp')");
  });

  // Contract (approved): the command handler is the caller-side guard — never invoke this with
  // an empty selection. The throw documents the invariant here rather than silently emitting
  // invalid SQL (`... IN ()`) if that guard is ever missed.
  it('throws on an empty plugin list rather than emit invalid SQL', () => {
    expect(() => buildSelectedPluginsFilterSql([])).toThrow(/empty/i);
  });
});
