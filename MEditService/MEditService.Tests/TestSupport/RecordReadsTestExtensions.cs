using MEditService.Core.Records;

namespace MEditService.Tests;

/// <summary>
/// #421: small compatibility shims so the many existing test call sites built against the deleted
/// <c>IRecordReader</c> shape don't each have to be hand-rewritten around <c>GetRecordTypeCounts</c>
/// — same call syntax, same values, backed by the new seam.
/// </summary>
internal static class RecordReadsTestExtensions
{
    /// <summary>Mirrors the deleted <c>IRecordReader.CountRecordsForPlugin(tableName, plugin,
    /// origin)</c> — a single-type slice of <see cref="IRecordReads.GetRecordTypeCounts"/>.</summary>
    internal static int CountRecordsForPlugin(this IRecordReads repository, string tableName, string plugin, string origin) =>
        repository.GetRecordTypeCounts(new PluginKey(plugin, origin))
            .FirstOrDefault(c => string.Equals(c.Type, tableName, StringComparison.OrdinalIgnoreCase))?.Count ?? 0;
}
