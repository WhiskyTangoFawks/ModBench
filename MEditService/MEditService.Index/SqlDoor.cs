using System.Text.Json;
using DuckDB.NET.Data;

namespace MEditService.Index;

/// <summary>ADR-0009 invariant 1: a filter is one SELECT over the public relations of <c>main</c>.
/// DuckDB's own parse says what else it would read.</summary>
internal static class SqlDoor
{
    // Table functions that read no relation and run no string.
    private static readonly HashSet<string> RowSources = new(StringComparer.OrdinalIgnoreCase) { "unnest", "range", "generate_series" };

    /// <summary>Why <paramref name="sql"/> may not pass the door, or null when it may.</summary>
    internal static string? RefusalOf(DuckDBConnection connection, string sql)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT json_serialize_sql($1::VARCHAR)";
        cmd.Parameters.Add(new DuckDBParameter { Value = sql });
        using var parsed = JsonDocument.Parse((string)(cmd.ExecuteScalar() ?? "{}"));
        var root = parsed.RootElement;

        if (root.GetProperty("error").GetBoolean())
            return root.GetProperty("error_message").GetString();
        if (root.GetProperty("statements").GetArrayLength() != 1)
            return "A filter is one SELECT statement.";
        return RefusalIn(root);
    }

    private static string? RefusalIn(JsonElement node) => node.ValueKind switch
    {
        JsonValueKind.Object => RefusalOfRef(node) ?? FirstRefusal(node.EnumerateObject().Select(p => p.Value)),
        JsonValueKind.Array => FirstRefusal(node.EnumerateArray()),
        _ => null,
    };

    private static string? FirstRefusal(IEnumerable<JsonElement> nodes) =>
        nodes.Select(RefusalIn).FirstOrDefault(refusal => refusal is not null);

    private static string? RefusalOfRef(JsonElement node)
    {
        if (!node.TryGetProperty("type", out var type) || type.ValueKind != JsonValueKind.String) return null;
        switch (type.GetString())
        {
            case "BASE_TABLE":
                var catalog = node.GetProperty("catalog_name").GetString();
                var schema = node.GetProperty("schema_name").GetString();
                var table = node.GetProperty("table_name").GetString();
                if (string.IsNullOrEmpty(catalog) && schema is "" or "main") return null;
                var name = string.Join('.', new[] { catalog, schema, table }.Where(part => !string.IsNullOrEmpty(part)));
                return $"A filter reads the record views, and {name} is not one.";
            case "TABLE_FUNCTION":
                var function = node.GetProperty("function").GetProperty("function_name").GetString() ?? "";
                return RowSources.Contains(function) ? null : $"A filter reads the record views, and the table function {function} is not one.";
            default:
                return null;
        }
    }
}
