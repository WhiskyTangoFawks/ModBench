using DuckDB.NET.Data;
using MEditService.Core.Schema;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Core.Records;

/// <summary>
/// Indexes a plugin's ModHeader as a single row in the "header" table, at the synthetic
/// FormKey <c>000000:&lt;plugin&gt;</c>. A mod header is never an <see cref="IMajorRecordGetter"/>,
/// so it bypasses the major-record indexing loop entirely — mirroring the VmadIndexer/
/// PlacementWalker precedent for structurally-foreign data pulled out of that loop.
/// </summary>
internal static class HeaderIndexer
{
    /// <summary>The synthetic DuckDB table / record type the plugin header is indexed under.</summary>
    internal const string TableName = "header";

    /// <summary>
    /// The header's masters column name — single source of truth shared by
    /// <c>SchemaReflector</c> (column definition) and the write path (validation-time
    /// rejection guard, ADR-0038). Not read by <c>PluginWriter</c>: masters are
    /// wholly content-derived at write time, unconditionally, so there is nothing to key
    /// a write-time override off of.
    /// </summary>
    internal const string MastersFieldName = "masters";

    public static string FormKeyFor(ModKey plugin) => FormKey.Factory($"000000:{plugin}").ToString();

    public static void Index(
        IModGetter pluginMod, string plugin, string origin,
        RecordTableSchema headerSchema, DuckDBAppender appender)
    {
        var extracts = headerSchema.HeaderColumnExtract;
        if (extracts == null) return;

        var row = appender.CreateRow();
        row.AppendValue(FormKeyFor(pluginMod.ModKey));
        row.AppendValue(plugin);
        row.AppendValue(origin);
        row.AppendNullValue();    // editor_id: headers have no EditorID concept

        // RecordColumns and HeaderColumnExtract are always built in lockstep, one extractor per
        // column, by SchemaReflector.BuildHeaderSchema — no bounds check needed here.
        for (int i = 0; i < headerSchema.RecordColumns.Count; i++)
            DuckDbRecordIndex.AppendTyped(row, extracts[i](pluginMod), headerSchema.RecordColumns[i].DuckDbType);

        row.EndRow();
    }
}
