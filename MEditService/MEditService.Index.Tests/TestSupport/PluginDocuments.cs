using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

internal static class PluginDocuments
{
    internal static IReadOnlyList<RecordDocument> DocumentsOf(this IRecordReads reads, PluginAddress plugin) =>
        reads.Search(new RecordQuery(RecordQueryScope.Search, Plugin: plugin.Name, Origin: plugin.Origin, Limit: int.MaxValue))
            .Items
            .Select(row => reads.GetDocument(row.FormKey, plugin) ?? throw new InvalidOperationException($"{row.FormKey} was listed in {plugin} and has no document."))
            .ToList();
}
