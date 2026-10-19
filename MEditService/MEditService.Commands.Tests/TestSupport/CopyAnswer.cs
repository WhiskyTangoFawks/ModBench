namespace MEditService.Commands.Tests.TestSupport;

internal static class CopyAnswer
{
    /// <summary>The FormKey the one landed copy drew: null for an override.</summary>
    internal static string? OnlyLanded(this CopyRecordResult answer)
    {
        var refusal = answer.Refused is [var first, ..] ? first.Message : null;
        Assert.True(refusal is null && answer.Applied.Count == 1, refusal);
        return answer.Applied[0].NewFormKey;
    }

    internal static CopyRecordRefused OnlyRefused(this CopyRecordResult answer)
    {
        Assert.Empty(answer.Applied);
        return Assert.Single(answer.Refused);
    }
}
