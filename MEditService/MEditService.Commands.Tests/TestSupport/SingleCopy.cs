using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Copy over a selection of one record and one destination, answered as that one item.</summary>
internal static class SingleCopy
{
    internal static RecordEditResult CopyAsOverride(
        this CopyRecordHandler handler, PluginAddress source, string formKey, PluginAddress destination,
        bool replace = false) =>
        OnlyItem(handler.Copy([new RecordAt(source, formKey)], CopyMode.Override, [destination], replace));

    internal static RecordEditResult CopyAsNew(
        this CopyRecordHandler handler, PluginAddress source, string formKey, PluginAddress destination) =>
        OnlyItem(handler.Copy([new RecordAt(source, formKey)], CopyMode.New, [destination], replace: false));

    private static RecordEditResult OnlyItem(SelectionResult<CopyItem> result)
    {
        if (result.Landed is [var landed])
            return landed.NewFormKey is { } newFormKey ? RecordEditResult.Success(newFormKey) : RecordEditResult.Success();

        var refused = Assert.Single(result.Refused);
        return RecordEditResult.Refused(refused.Refusal, refused.Message);
    }
}
