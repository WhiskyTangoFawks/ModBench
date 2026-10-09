using MEditService.Index.Queries;
using MEditService.LoadOrder;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>How a tracked plugin's source was read, as the face states it.</summary>
internal static class PluginSourceReads
{
    internal static bool ReadFromItsPluginSource(this OpenedIndex index, PluginAddress plugin) =>
        index.PluginRowOf(plugin) is { IsTracked: true, PluginSourceUnreadableReason: null };

    internal static bool ReadFromItsPluginFileForItsUnreadableSource(this OpenedIndex index, PluginAddress plugin) =>
        index.PluginRowOf(plugin) is { IsTracked: true, PluginSourceUnreadableReason: not null };

    /// <summary>The problems of the one plugin an index over a single tracked plugin holds.</summary>
    internal static IReadOnlyList<SourceProblem> SourceProblems(this OpenedIndex index) =>
        Assert.Single(index.Problems.GetProblems() ?? throw new InvalidOperationException("Expected a ready index.")).Problems;
}
