using MEditService.Commands.Edits;
using MEditService.LoadOrder;

namespace MEditService.Commands.Tests.TestSupport;

/// <summary>Delete and Copy answer as tasks that complete before they return, so a test reads the
/// answer where it stands.</summary>
internal static class SyncHandlers
{
    internal static SelectionResult<RecordAt, RecordEditRefusal, string?> DeleteRecordsSync(
        this DeleteRecordHandler handler, IReadOnlyList<RecordAt> records) =>
        handler.DeleteRecords(records).GetAwaiter().GetResult();

    internal static SelectionResult<CopyItem, RecordEditRefusal, string?> CopySync(
        this CopyRecordHandler handler, IReadOnlyList<RecordAt> records, CopyMode mode,
        IReadOnlyList<PluginAddress> destinations, bool replace) =>
        handler.Copy(records, mode, destinations, replace).GetAwaiter().GetResult();
}
