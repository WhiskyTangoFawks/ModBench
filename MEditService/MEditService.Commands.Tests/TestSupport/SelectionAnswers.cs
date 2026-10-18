using MEditService.Commands.Edits;
using MEditService.RepositoriesLib;

namespace MEditService.Commands.Tests.TestSupport;

internal static class SelectionAnswers
{
    /// <summary>What a gesture over a selection answered; a refusal of the whole selection here is a broken fixture.</summary>
    internal static T Value<T, TRefusal>(this Answer<T, SelectionRefusal<TRefusal>> answer) =>
        answer.Holds(out var value, out var whole)
            ? value
            : throw new InvalidOperationException($"Expected the gesture to answer here: {whole.Refusal}: {whole.Message}");

    /// <summary>The refusal of the whole selection, which the test asked for.</summary>
    internal static SelectionRefusal<TRefusal> WholeSelectionRefusal<T, TRefusal>(this Answer<T, SelectionRefusal<TRefusal>> answer) =>
        answer.Holds(out _, out var whole)
            ? throw new InvalidOperationException("Expected the gesture to refuse the whole selection here.")
            : whole;
}
