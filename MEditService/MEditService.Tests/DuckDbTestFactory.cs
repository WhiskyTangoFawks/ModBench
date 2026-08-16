using DuckDB.NET.Data;
using MEditService.Core.Edits;

namespace MEditService.Tests;

internal static class DuckDbTestFactory
{
    internal static DuckDbPendingChangeService MakePendingChangeService() =>
        MakePendingChangeServiceWithConnection().Service;

    // #312: most callers only ever needed the service — DrainForPlugin was the one production
    // member that let tests observe pending_form_references, and it's gone (no production caller,
    // per the ticket's trace). The handful of tests that need to read pending_form_references
    // content now hold the connection themselves and call ReadFormRefs below, instead of the
    // service growing a test-only read method of its own (that would just be the same defect under
    // a new name — see #312 discussion).
    internal static (DuckDbPendingChangeService Service, DuckDBConnection Connection) MakePendingChangeServiceWithConnection()
    {
        var conn = new DuckDBConnection("DataSource=:memory:");
        conn.Open();
        return (new DuckDbPendingChangeService(conn), conn);
    }

    /// <summary>
    /// Test-only, non-destructive read of pending_form_references — the same rows
    /// <c>DrainForPlugin</c> used to return, without deleting them. Mirrors its SELECT exactly.
    /// </summary>
    internal static ILookup<string, PendingFormRef> ReadFormRefs(DuckDBConnection conn, string plugin, string? origin = null)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = """
            SELECT source_form_key, staged_field, field_path, target_form_key
            FROM pending_form_references
            WHERE source_plugin = $1 AND ($2 IS NULL OR source_origin = $2)
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = plugin });
        cmd.Parameters.Add(new DuckDBParameter { Value = (object?)origin });

        var rows = new List<(string SourceFormKey, PendingFormRef Ref)>();
        using var reader = cmd.ExecuteReader();
        while (reader.Read())
        {
            rows.Add((
                reader.GetString(0),
                new PendingFormRef(reader.GetString(1), reader.GetString(2), reader.GetString(3))));
        }
        return rows.ToLookup(x => x.SourceFormKey, x => x.Ref);
    }
}
