using MEditService.RecordIndex.Queries;
using MEditService.RepositoriesLib;

namespace MEditService.RecordIndex.Tests;

/// <summary>The face's reads as a test asks them, with what a test leaves out.</summary>
internal static class QueryShortcuts
{
    internal static Answer<CompareResult?, IndexRefused> GetCompare(this IQueries queries, string formKey) => queries.GetCompare(formKey, null);

    internal static Answer<IReadOnlyList<PluginProblems>, IndexRefused> GetProblems(this IQueries queries) => queries.GetProblems(null);

    /// <summary>The winning copy, as the comparison of the active plugins answers it; null when no active plugin holds it.</summary>
    internal static Answer<RecordDetail?, IndexRefused> GetWinner(this IQueries queries, string formKey) =>
        queries.GetCompare(formKey, null).Then<RecordDetail?>(compared => compared?.Overrides.SingleOrDefault(copy => copy.IsWinner));
}
