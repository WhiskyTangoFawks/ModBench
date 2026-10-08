using MEditService.Index.Queries;
using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>A plugin's copy of a record, as the face answers it.</summary>
internal static class Copies
{
    /// <summary>The copy <paramref name="plugin"/> holds, as a comparison of it alone answers it; null
    /// when the plugin holds none.</summary>
    internal static RecordDetail? CopyIn(this OpenedIndex index, string formKey, PluginAddress plugin)
    {
        try
        {
            return index.Records.GetCompareRecords([new RecordCopy(formKey, plugin)]).Overrides.Single();
        }
        catch (RecordCopiesMissingException)
        {
            return null;
        }
    }

    internal static RecordDetail DocumentOf(this OpenedIndex index, string formKey, PluginAddress plugin) =>
        index.CopyIn(formKey, plugin)
            ?? throw new InvalidOperationException($"Expected a document for '{formKey}' in {plugin.Name} ({plugin.Origin}).");

    /// <summary>The document the index holds for the copy, as the editor opens it.</summary>
    internal static string BodyOf(this OpenedIndex index, string formKey, PluginAddress plugin) =>
        index.Records.GetRenderedDocument(plugin, formKey)?.Text
            ?? throw new InvalidOperationException($"Expected a body for '{formKey}' in {plugin.Name} ({plugin.Origin}).");

    /// <summary>The copy's row, as a search by its FormKey lists it: no filter narrows it, and a record
    /// another holds is listed too.</summary>
    internal static RecordSummary? RowOf(this OpenedIndex index, string formKey, PluginAddress plugin) =>
        index.Records.GetRecords(types: null, plugin, search: formKey, limit: int.MaxValue, offset: 0)
            .Items.SingleOrDefault(row => row.FormKey == formKey);

    /// <summary>Every active plugin's copy, in load order; empty when no active plugin holds one.</summary>
    internal static IReadOnlyList<CompareOverride> StackOf(this OpenedIndex index, string formKey) =>
        index.Records.GetCompare(formKey)?.Overrides ?? [];

    /// <summary>The records the navigator lists under <paramref name="plugin"/>, every type at once.</summary>
    internal static IReadOnlyList<RecordSummary> ListedIn(this OpenedIndex index, PluginAddress plugin) =>
        index.Records.GetRecords(types: null, plugin, search: null, limit: int.MaxValue, offset: 0).Items;

    internal static PluginRow? PluginRowOf(this OpenedIndex index, PluginAddress plugin) =>
        index.Records.GetPlugins().SingleOrDefault(row => PluginAddress.Comparer.Equals(row.Plugin.Key, plugin));
}
