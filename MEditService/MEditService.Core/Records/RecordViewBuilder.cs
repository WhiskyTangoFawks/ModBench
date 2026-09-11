using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

/// <summary>One <c>json_extract</c> view per record type over <c>records</c>, for the SQL door only
/// (ADR-0007). Scalar leaves only, decided by <see cref="ColumnSpec.IsViewable"/>: no column over
/// one with broken semantics.</summary>
internal static class RecordViewBuilder
{
    internal static void CreateViews(DuckDBConnection connection, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        // The header's columns sit a level deeper in the document ($.ModHeader.Author); that nesting
        // is in the column's own PropertyName, so Projection needs nothing special.
        foreach (var (tableName, schema) in schemas)
        {
            using var cmd = connection.CreateCommand();
            cmd.CommandText = BuildViewSql(tableName, schema);
            cmd.ExecuteNonQuery();
        }
    }

    internal static string BuildViewSql(string tableName, RecordTableSchema schema)
    {
        var sb = new StringBuilder();
        sb.Append(CultureInfo.InvariantCulture, $"CREATE OR REPLACE VIEW \"{tableName}\" AS SELECT ");
        sb.Append("form_key, plugin, origin, load_order_idx, is_winner, editor_id");

        foreach (var col in schema.RecordColumns.Where(c => c.IsViewable))
            sb.Append(CultureInfo.InvariantCulture, $", {Projection(col)} AS \"{col.Name}\"");

        sb.Append(CultureInfo.InvariantCulture, $" FROM records WHERE record_type = '{tableName}'");
        return sb.ToString();
    }

    private static string Projection(ColumnSpec col)
    {
        var path = $"'$.{col.PropertyName}'";
        string raw;
        if (col.ApiType == "flags")
        {
            // A [Flags] enum is written as an array of member names. Joining them keeps the column
            // text and keeps `LIKE '%SomeFlag%'` working, which is how record flags are actually
            // filtered on.
            raw = $"array_to_string(CAST(json_extract(body, {path}) AS VARCHAR[]), ', ')";
        }
        else if (col.DuckDbType == "VARCHAR")
        {
            // One projection covers plain strings, enums, FormLinks and translated strings: a
            // translated string is an object ({TargetLanguage, Value}), so probe .Value first; the
            // probe returns NULL for a bare scalar and COALESCE moves on.
            raw = $"COALESCE(json_extract_string(body, '$.{col.PropertyName}.Value'), json_extract_string(body, {path}))";
        }
        else
        {
            raw = $"CAST(json_extract(body, {path}) AS {col.DuckDbType})";
        }

        // Mutagen omits any field equal to its default, so an absent path means "the default", not
        // "unknown" — for a non-nullable field. A nullable one has no default to restore and keeps
        // NULL (ViewDefaultLiteral is null for those).
        return col.ViewDefaultLiteral is { } fallback ? $"COALESCE({raw}, {fallback})" : raw;
    }
}
