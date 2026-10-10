using MEditService.Index.Queries;
using MEditService.RepositoriesLib;

namespace MEditService.Index.Tests;

internal static class IndexAnswers
{
    /// <summary>The value the Index answered; its refusal here is a broken fixture.</summary>
    internal static T Value<T>(this Answer<T, IndexRefused> answer) =>
        answer.Holds(out var value, out var refused)
            ? value
            : throw new InvalidOperationException($"Expected the Index to answer here: {refused.Refusal}: {refused.Message}");

    /// <summary>The refusal the Index answered, which the test asked for.</summary>
    internal static IndexRefused Refused<T>(this Answer<T, IndexRefused> answer) =>
        answer.Holds(out _, out var refused)
            ? throw new InvalidOperationException("Expected the Index to refuse here.")
            : refused;

    /// <summary>The copies the Index found no plugin holding, which the test asked for.</summary>
    internal static CopiesMissing Missing<T>(this Answer<T, IndexRefused> answer) =>
        answer.Refused() as CopiesMissing ?? throw new InvalidOperationException("Expected the Index to refuse for missing copies here.");

    /// <summary>A filter the Index took; its refusal here is a broken fixture.</summary>
    internal static void Accepted(this IndexRefused? refused)
    {
        if (refused is not null) throw new InvalidOperationException($"Expected the Index to take the filter: {refused.Refusal}: {refused.Message}");
    }
}
