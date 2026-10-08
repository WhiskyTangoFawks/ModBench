using System.Globalization;
using System.Text;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;

namespace MEditService.Index;

/// <summary>A view column is a scalar leaf with one SQL type: no column over one with broken semantics.
/// The Store reads the SQL type and default from the wire type.</summary>
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

        foreach (var col in schema.RecordColumns.Where(c => IsViewable(c) && !c.Field.IsEditorId))
            sb.Append(CultureInfo.InvariantCulture, $", {Projection(col)} AS \"{col.Name}\"");

        sb.Append(CultureInfo.InvariantCulture, $" FROM records WHERE record_type = '{tableName}'");
        return sb.ToString();
    }

    /// <summary>Arrays and structs have no scalar rendering, a column varying by record class no single
    /// type, a synthetic member no document node.</summary>
    internal static bool IsViewable(ColumnSpec col) =>
        !col.Field.IsArray && col.Field.Fields == null && col.Synthetic == null
        && (col.Field.Variants == null || col.Field.Variants.Values.Select(v => v.Type).Distinct(StringComparer.Ordinal).Count() == 1);

    internal static string SqlType(ColumnSpec col) => col.ApiType switch
    {
        "bool" => "BOOLEAN",
        "int" => "BIGINT",
        "float" => "FLOAT",
        _ => "VARCHAR",
    };

    // The SQL literal a view COALESCEs to when the serializer omitted a default-valued field, or null
    // when NULL is the honest answer.
    private static string? DefaultLiteral(ColumnSpec col)
    {
        if (col.AbsentIsNull) return null;
        return col.ApiType switch
        {
            "bool" => col.Field.Default is null ? "false" : Invariant(col.Field.Default),
            "int" or "float" => col.Field.Default is null ? "0" : Invariant(col.Field.Default),
            "flags" => "''",
            "enum" or "color" or "hex" or "vector" => col.Field.Default is string text ? $"'{text}'" : null,
            _ => null,
        };
    }

    private static string Invariant(object value) =>
        (Convert.ToString(value, CultureInfo.InvariantCulture)
            ?? throw new InvalidOperationException($"Expected '{value}' to have a string representation."))
                .ToLowerInvariant();

    private static string Projection(ColumnSpec col)
    {
        var path = $"'$.{col.PropertyName}'";
        string raw;
        if (col.ApiType == "flags")
        {
            // A [Flags] enum is written as an array of member names. Joining them keeps the column
            // text and keeps `LIKE '%SomeFlag%'` working. A major record's Record Flags is its raw
            // integer, which an INTEGER column filters by its bits.
            raw = $"array_to_string(CAST(json_extract(body, {path}) AS VARCHAR[]), ', ')";
        }
        else if (SqlType(col) == "VARCHAR")
        {
            // One projection covers plain strings, enums, FormLinks and translated strings: the
            // translated-string read returns NULL for a bare scalar and COALESCE moves on.
            raw = $"COALESCE({TranslatedStringSql.Resolved("body", $"$.{col.PropertyName}")}, json_extract_string(body, {path}))";
        }
        else
        {
            raw = $"CAST(json_extract(body, {path}) AS {SqlType(col)})";
        }

        // Mutagen omits any field equal to its default, so an absent path means "the default", not
        // "unknown" — for a non-nullable field. A nullable one has no default to restore and keeps NULL.
        var projected = DefaultLiteral(col) is { } fallback ? $"COALESCE({raw}, {fallback})" : raw;
        return col.ApiType == "formKey" ? $"({projected}) {TableDdlBuilder.FilenameIdentity}" : projected;
    }
}
