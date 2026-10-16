using MEditService.Index.Queries;
using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>How a source plugin's source was read, as the face states it.</summary>
internal static class PluginSourceReads
{
    internal static bool ReadFromItsPluginSource(this OpenedIndex index, PluginAddress plugin) =>
        index.PluginRowOf(plugin) is { IsSourcePlugin: true, PluginSourceUnreadable: null };

    internal static bool ReadFromItsPluginFileForItsUnreadableSource(this OpenedIndex index, PluginAddress plugin) =>
        index.PluginRowOf(plugin) is { IsSourcePlugin: true, PluginSourceUnreadable: not null };

    /// <summary>The problems of the one plugin an index over a single source plugin holds.</summary>
    internal static IReadOnlyList<SourceProblem> SourceProblems(this OpenedIndex index) =>
        Assert.Single(index.Queries.GetProblems().Value() ?? throw new InvalidOperationException("Expected a ready index.")).Problems;
}
