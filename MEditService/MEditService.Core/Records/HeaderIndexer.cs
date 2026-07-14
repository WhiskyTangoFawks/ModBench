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
    public static string FormKeyFor(ModKey plugin) => FormKey.Factory($"000000:{plugin}").ToString();

    public static void Index(
        IModGetter pluginMod, string plugin, int loadOrderIndex,
        RecordTableSchema headerSchema, DuckDBAppender appender)
    {
        var extracts = headerSchema.HeaderColumnExtract;
        if (extracts == null) return;

        var row = appender.CreateRow();
        row.AppendValue(FormKeyFor(pluginMod.ModKey));
        row.AppendValue(plugin);
        row.AppendValue(loadOrderIndex);
        row.AppendValue(false);   // is_winner: corrected by UpdateWinners(), same as every other table
        row.AppendNullValue();    // editor_id: headers have no EditorID concept

        for (int i = 0; i < headerSchema.RecordColumns.Count; i++)
        {
            var value = i < extracts.Count ? extracts[i](pluginMod) : null;
            DuckDbRecordRepository.AppendTyped(row, value, headerSchema.RecordColumns[i].DuckDbType);
        }

        row.EndRow();
    }
}
