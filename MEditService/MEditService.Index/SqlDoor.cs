using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.Index;

/// <summary>A filter or a read is one SELECT over the views of one schema: <c>main</c>, which sees the
/// active plugins (ADR-0012), or <c>indexed</c>, which sees every registered plugin.</summary>
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
        return new Reading(schema, views).RefusalIn(root);
    }

    private sealed class Reading(string schema, IEnumerable<string> views)
    {
        // A WITH names a relation of its own, which the parse serializes as a table reference like any other.
        private readonly HashSet<string> _viewsAndCommonTableExpressions = new(views, StringComparer.OrdinalIgnoreCase);

        internal string? RefusalIn(JsonElement root)
        {
            NameCommonTableExpressions(root);
            return RefusalInNode(root);
        }

        private void NameCommonTableExpressions(JsonElement node)
        {
            switch (node.ValueKind)
            {
                case JsonValueKind.Object:
                    foreach (var property in node.EnumerateObject())
                    {
                        if (property.Name == "cte_map")
                        {
                            foreach (var entry in property.Value.GetProperty("map").EnumerateArray())
                                _viewsAndCommonTableExpressions.Add(entry.GetProperty("key").GetString() ?? "");
                        }
                        NameCommonTableExpressions(property.Value);
                    }
                    break;
                case JsonValueKind.Array:
                    foreach (var item in node.EnumerateArray()) NameCommonTableExpressions(item);
                    break;
            }
        }

        private string? RefusalInNode(JsonElement node) => node.ValueKind switch
        {
            JsonValueKind.Object => RefusalOfRef(node) ?? FirstRefusal(node.EnumerateObject().Select(p => p.Value)),
            JsonValueKind.Array => FirstRefusal(node.EnumerateArray()),
            _ => null,
        };

        private string? FirstRefusal(IEnumerable<JsonElement> nodes) =>
            nodes.Select(RefusalInNode).FirstOrDefault(refusal => refusal is not null);

        private string? RefusalOfRef(JsonElement node)
        {
            if (!node.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) return null;
            switch (type.GetString())
            {
                case "BASE_TABLE":
                    var catalog = node.GetProperty("catalog_name").GetString();
                    var table = node.GetProperty("table_name").GetString();
                    var unqualified = string.IsNullOrEmpty(catalog) && string.IsNullOrEmpty(node.GetProperty("schema_name").GetString());
                    if (table is not null && table.IndexOfAny(FileNameCharacters) >= 0)
                        return $"Only the views are read, and {table} is a file.";
                    if (unqualified && table is not null && _viewsAndCommonTableExpressions.Contains(table)) return null;
                    var name = string.Join('.', new[] { catalog, node.GetProperty("schema_name").GetString(), table }.Where(part => !string.IsNullOrEmpty(part)));
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
            var named = TableDdlBuilder.ReadableViews.Concat(schema == TableDdlBuilder.IndexedSchema ? [TableDdlBuilder.ViewColumnsView] : []);
            var columns = schema == TableDdlBuilder.IndexedSchema ? $" {TableDdlBuilder.ViewColumnsView} lists the columns of each." : "";
            return $"Only the views are read: {string.Join(", ", named)}, and one view per record type. {reason}.{columns}";
        }
    }
}
