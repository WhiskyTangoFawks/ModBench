using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;

namespace MEditService.Index;

/// <summary>The masters a plugin's content requires (ADR-0008): the plugin every record it holds or
/// links to belongs to, other than itself. No document holds them, so a header's masters field is
/// answered from here.</summary>
internal static class RequiredMasters
{
    // A FormKey is "<id>:<plugin filename>", and no filename holds a colon. A master no active plugin
    // answers sorts after every one that does.
    private const string InLoadOrder = $"""
        WITH linked AS (
            SELECT split_part(form_key, ':', 2) AS master
            FROM {TableDdlBuilder.MirrorSchema}.form_lookup WHERE plugin = $1 AND origin = $2
            UNION ALL
            SELECT split_part(target_form_key, ':', 2)
            FROM {TableDdlBuilder.MirrorSchema}.form_references WHERE source_plugin = $1 AND source_origin = $2),
        required AS (
            SELECT lower(master) AS name, min(master) AS master FROM linked
            WHERE lower(master) <> lower($1)
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

    private static List<string> Of(DuckDBConnection connection, PluginAddress plugin)
    {
        using var cmd = connection.CreateCommand();
        cmd.CommandText = InLoadOrder;
        DuckDbSql.AddParams(cmd, [plugin.Name, plugin.Origin]);
        using var reader = cmd.ExecuteReader();
        var masters = new List<string>();
        while (reader.Read()) masters.Add(reader.GetString(0));
        return masters;
    }
}
