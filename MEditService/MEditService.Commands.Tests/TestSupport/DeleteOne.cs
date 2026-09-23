using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>A selection of one: the tests that pin what a single delete does read its one item's
/// outcome back as the applied-or-refusal every other gesture answers with.</summary>
public static class DeleteOne
{
    public static RecordEditResult DeleteRecord(this DeleteRecordHandler handler, PluginCopyKey plugin, string formKey)
    {
        var result = handler.DeleteRecords([new RecordAt(plugin, formKey)]);
        return result.Refused is [var refused]
            ? RecordEditResult.Refused(refused.Refusal, refused.Message)
            : RecordEditResult.Success();
    }
}
