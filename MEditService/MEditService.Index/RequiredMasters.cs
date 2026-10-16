using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>The masters a plugin's content requires (ADR-0008): those of every record it holds. No document
/// holds them, so a header's masters field is answered from here.</summary>
internal static class RequiredMasters
{
    // Each record's masters are the codec's answer, stored at ingest. A master no active plugin answers
    // sorts after every one that does.
    private const string InLoadOrder = $"""
        WITH required AS (
            SELECT lower(master) AS name, min(master) AS master
            FROM (SELECT unnest(masters) AS master
                  FROM {TableDdlBuilder.MirrorSchema}.records WHERE plugin = $1 AND origin = $2)
            GROUP BY name),
        loaded AS (
            SELECT lower(plugin) AS name, min(load_order_idx) AS load_order_idx
            FROM {TableDdlBuilder.RegistrationsRelation} GROUP BY name)
        SELECT required.master FROM required LEFT JOIN loaded USING (name)
        ORDER BY loaded.load_order_idx NULLS LAST, name
        """;

    /// <summary><paramref name="fields"/> with the header's masters field answered for
    /// <paramref name="plugin"/>.</summary>
    internal static List<FieldValue> InHeader(
        List<FieldValue> fields, DuckDBConnection connection, PluginAddress plugin)
    {
        var at = fields.FindIndex(f => f.Metadata.Name == PluginHeader.MastersFieldName);
        if (at < 0) return fields;
        var masters = Of(connection, plugin).Select(master => new { Master = master });
        fields[at] = fields[at] with { Value = JsonSerializer.SerializeToElement(masters) };
        return fields;
    }

    private static List<string> Of(DuckDBConnection connection, PluginAddress plugin) =>
        DuckDbSql.Rows(connection, InLoadOrder, reader => reader.GetString(0), plugin.Name, plugin.Origin);
}
