using MEditService.Commands.Edits;

namespace MEditService.Commands.Tests.TestSupport;

internal static class CopyAnswer
{
    internal static string? OnlyLanded(this SelectionResult<CopyItem, RecordEditRefusal, string?> answer)
    {
        var refusal = answer.SelectionRefusal?.Message ?? (answer.Refused is [var first, ..] ? first.Message : null);
        Assert.True(refusal is null && answer.Landed.Count == 1, refusal);
        return answer.Landed[0].Outcome;
    }

    internal static ItemRefused<CopyItem, RecordEditRefusal> OnlyRefused(
        this SelectionResult<CopyItem, RecordEditRefusal, string?> answer)
    {
        Assert.Empty(answer.Landed);
        return Assert.Single(answer.Refused);
    }
}
