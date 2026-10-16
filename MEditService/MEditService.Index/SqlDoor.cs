using System.Collections.Immutable;
using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.Index;

/// <summary>A filter or a read is one SELECT over the views of one schema: <c>main</c>, which sees the
/// active plugins (ADR-0012), or <c>indexed</c>, which sees every plugin the index holds.</summary>
internal static class SqlDoor
{
    private static readonly char[] FileNameCharacters = ['/', '\\', '.', ':'];

    // Table functions that read no relation and run no string.
    private static readonly HashSet<string> RowSources = new(StringComparer.OrdinalIgnoreCase) { "unnest", "range", "generate_series" };

    /// <summary>Why <paramref name="sql"/> may not pass the door, or null when it may.</summary>
    internal static string? RefusalOf(DuckDBConnection connection, string sql, string schema)
    {
        using var parsed = JsonDocument.Parse(
            DuckDbSql.ScalarString(connection, "SELECT json_serialize_sql($1::VARCHAR)", sql) ?? "{}");
        var root = parsed.RootElement;

        if (root.GetProperty("error").GetBoolean())
            return root.GetProperty("error_message").GetString();
        if (root.GetProperty("statements").GetArrayLength() != 1)
            return "Only one SELECT statement is read.";

        var views = DuckDbSql.Rows(
            connection,
            "SELECT table_name FROM information_schema.tables WHERE table_catalog = current_database() AND table_schema = $1 AND table_type = 'VIEW' AND table_name <> $2",
            reader => reader.GetString(0), schema, TableDdlBuilder.PluginRecordsView);
        return new SchemaViews(schema, views).RefusalIn(root, ImmutableHashSet<string>.Empty.WithComparer(StringComparer.OrdinalIgnoreCase));
    }

    private sealed class SchemaViews(string schema, IEnumerable<string> views)
    {
        private readonly HashSet<string> _views = new(views, StringComparer.OrdinalIgnoreCase);

        // The parse serializes a reference to a WITH's relation like any table reference. A WITH covers
        // its own query node and the later entries of its list: outside, the name is the real relation's.
        internal string? RefusalIn(JsonElement node, ImmutableHashSet<string> commonTableExpressions) => node.ValueKind switch
        {
            JsonValueKind.Object => RefusalInObject(node, commonTableExpressions),
            JsonValueKind.Array => FirstRefusal(node.EnumerateArray(), commonTableExpressions),
            _ => null,
        };

        private string? RefusalInObject(JsonElement node, ImmutableHashSet<string> commonTableExpressions)
        {
            if (RefusalOfRef(node, commonTableExpressions) is { } refusal) return refusal;

            var covered = node.TryGetProperty("cte_name", out var recursive) && recursive.GetString() is { } recursiveName
                ? commonTableExpressions.Add(recursiveName)
                : commonTableExpressions;
            if (node.TryGetProperty("cte_map", out var list))
            {
                foreach (var entry in list.GetProperty("map").EnumerateArray())
                {
                    if (RefusalIn(entry.GetProperty("value"), covered) is { } inEntry) return inEntry;
                    covered = covered.Add(entry.GetProperty("key").GetString() ?? "");
                }
            }
            return FirstRefusal(node.EnumerateObject().Where(p => p.Name != "cte_map").Select(p => p.Value), covered);
        }

        private string? FirstRefusal(IEnumerable<JsonElement> nodes, ImmutableHashSet<string> commonTableExpressions) =>
            nodes.Select(node => RefusalIn(node, commonTableExpressions)).FirstOrDefault(refusal => refusal is not null);

        private string? RefusalOfRef(JsonElement node, ImmutableHashSet<string> commonTableExpressions)
        {
            if (!node.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) return null;
            switch (type.GetString())
            {
                case "BASE_TABLE":
                    var catalog = node.GetProperty("catalog_name").GetString();
                    var tableSchema = node.GetProperty("schema_name").GetString();
                    var table = node.GetProperty("table_name").GetString();
                    if (table is not null && table.IndexOfAny(FileNameCharacters) >= 0)
                        return $"Only the views are read, and {table} is a file.";
                    var unqualified = string.IsNullOrEmpty(catalog) && string.IsNullOrEmpty(tableSchema);
                    if (unqualified && table is not null && (_views.Contains(table) || commonTableExpressions.Contains(table))) return null;
                    var name = string.Join('.', new[] { catalog, tableSchema, table }.Where(part => !string.IsNullOrEmpty(part)));
                    return NotAView($"{name} is not one");
                case "TABLE_FUNCTION":
                    var function = node.GetProperty("function").GetProperty("function_name").GetString() ?? "";
                    return RowSources.Contains(function) ? null : NotAView($"the table function {function} is not one");
                default:
                    return null;
            }
        }

        private string NotAView(string reason)
        {
            var named = TableDdlBuilder.FixedViews.Concat(schema == TableDdlBuilder.IndexedSchema ? [TableDdlBuilder.ViewColumnsView] : []);
            var columns = schema == TableDdlBuilder.IndexedSchema ? $" {TableDdlBuilder.ViewColumnsView} lists the columns of each." : "";
            return $"Only the views are read: {string.Join(", ", named)}, and one view per record type. {reason}.{columns}";
        }
    }
}
