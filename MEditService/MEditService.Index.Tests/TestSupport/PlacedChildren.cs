using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

internal static class PlacedChildren
{
    internal static string? PlacementGroupIn(this OpenedIndex index, PluginAddress plugin, string cellFormKey, string formKey)
    {
        var children = index.Queries.GetCellChildRecords(plugin, cellFormKey).Value();
        if (children.Persistent.Any(c => c.FormKey == formKey)) return "persistent";
        return children.Temporary.Any(c => c.FormKey == formKey) ? "temporary" : null;
    }
}
