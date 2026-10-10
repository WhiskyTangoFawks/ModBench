using System.Text;
using MEditService.Codec.Schema;

namespace MEditService.PluginAdapter;

/// <summary>A record flagged Deleted that holds subrecords in a plugin and none in its rewrite, as Mutagen
/// writes most deleted records. Records pair by FormKey, read through each plugin's own masters, since a
/// rewrite prunes masters.</summary>
internal static class DroppedDeletedFields
{
    private const uint DeletedBit = DeletedFlag.Bit;

    /// <summary>The first such record as its signature and FormKey, or null.</summary>
    internal static string? FirstIn(byte[] original, byte[] rewritten, string pluginName)
    {
        var emptyInRewrite = Records(rewritten, pluginName)
            .Where(record => record.Span.DataLen == 0)
            .Select(record => (record.Span.Type, record.FormKey))
            .ToHashSet();
        return Records(original, pluginName)
            .Where(record => (record.Span.Flags & DeletedBit) != 0 && record.Span.DataLen > 0
                && emptyInRewrite.Contains((record.Span.Type, record.FormKey)))
            .Select(record => $"{record.Span.Type} {record.FormKey}")
            .FirstOrDefault();
    }

    private static IEnumerable<(PluginBinaryWalk.RecordSpan Span, string FormKey)> Records(byte[] plugin, string pluginName)
    {
        var records = PluginBinaryWalk.WalkRecords(plugin).Where(record => !record.IsGrup).ToList();
        if (records is not [{ Type: "TES4" } header, ..]) return [];
        var masters = PluginBinaryWalk.WalkSubrecords(plugin.AsSpan(header.DataStart, header.DataLen).ToArray())
            .Where(subrecord => subrecord.Sig == "MAST")
            .Select(subrecord => Encoding.ASCII.GetString(plugin, header.DataStart + subrecord.Start + 6, subrecord.Len - 7))
            .ToList();
        return records.Skip(1).Select(record =>
            (record, $"{record.FormId & 0xFFFFFF:X6}:{(record.FormId >> 24 < masters.Count ? masters[(int)(record.FormId >> 24)] : pluginName)}"));
    }
}
