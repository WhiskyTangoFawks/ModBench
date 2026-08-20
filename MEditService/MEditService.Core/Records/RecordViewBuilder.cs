using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Core.Schema;

namespace MEditService.Core.Records;

/// <summary>
/// Emits one <c>json_extract</c> view per record type over the <c>records</c> documents table —
/// what the reflector's per-type DDL became (ADR-0041 / #413 D2).
///
/// <para>The views exist for <b>the SQL door only</b>: user filter SQL and <c>medit.query</c>
/// scripts (invariant 8). Nothing in C# reads them — typed reads reconstitute from the document and
/// run the same ColumnSpec extractors the wide tables were filled with. That separation is what lets
/// the two shapes differ honestly: the document is Mutagen's serializer shape, and it has no
/// per-column correspondence to the reflected schema at all.</para>
///
/// <para><b>Scalar leaves only, and the rule is mechanical.</b> A view carries primitives, plain
/// enums, flags enums, FormLinks and translated strings; it omits arrays, structs and the #263
/// widened columns. The omissions are not a curated field list — they fall out of
/// <see cref="ColumnSpec.IsViewable"/>, which reads flags the reflector set from the CLR type. The
/// principle is D2's: <i>no column rather than a column with broken semantics</i>. A nested array
/// has no faithful scalar rendering, and a widened column's JSON holds a number for one sibling
/// subclass and a string for another, so a single cast could only be wrong for somebody.</para>
///
/// <para>Consequently a view never carries an always-NULL column. The only fields that would have
/// become one — the GRUP timestamps, which the serializer never emits — left the reflected schema
/// entirely instead (see <c>SchemaReflector.BaseSkip</c>), so the schema does not claim them either.</para>
/// </summary>
internal static class RecordViewBuilder
{
    internal static void CreateViews(DuckDBConnection connection, IReadOnlyDictionary<string, RecordTableSchema> schemas)
    {
        foreach (var (tableName, schema) in schemas)
        {
            // The header has no document — it stays a real extracted index table (D8), so there is
            // nothing to project a view over.
            if (string.Equals(tableName, HeaderIndexer.TableName, StringComparison.OrdinalIgnoreCase)) continue;

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
        if (col.IsFlagsEnum)
        {
            // A [Flags] enum is written as an array of member names. Joining them keeps the column
            // text and keeps `LIKE '%SomeFlag%'` working, which is how record flags are actually
            // filtered on. The old BIGINT bit value is gone by design (D2 as amended).
            raw = $"array_to_string(CAST(json_extract(body, {path}) AS VARCHAR[]), ', ')";
        }
        else if (col.DuckDbType == "VARCHAR")
        {
            // One projection covers plain strings, enums, FormLinks and translated strings. A
            // translated string is an object ({TargetLanguage, Value}), everything else is a bare
            // scalar — so try the .Value path first and fall back to the property itself. That
            // fallback is why translated strings need no marker of their own: the probe returns
            // NULL for a non-object and the COALESCE moves on.
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
