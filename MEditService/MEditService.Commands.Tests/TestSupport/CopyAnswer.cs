using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.TestSupport;

internal static class CopyAnswer
{
    internal static void OnlyLanded(this CopyRecordResult answer)
    {
        var refusal = answer.Refused is [var first, ..] ? first.Message : null;
        Assert.True(refusal is null && answer.Applied.Count == 1, refusal);
    }

    internal static CopyRefused OnlyRefused(this CopyRecordResult answer)
    {
        Assert.Empty(answer.Applied);
        return Assert.Single(answer.Refused);
    }

    /// <summary>The FormKey a copy as new drew, which the changes it answers do not name: the script's copy writes
    /// the same changes and answers it.</summary>
    internal static string CopyAsNew(this CopyRecordHandler handler, RecordAt record, PluginAddress destination)
    {
        var written = handler.Copy(record, CopyMode.New, destination, replace: false).GetAwaiter().GetResult().AsResult();
        Assert.True(written.Applied, written.Message);
        return written.NewFormKey.Require();
    }
}
