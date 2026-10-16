using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>How a compiled plugin's source was read, as the face states it.</summary>
internal static class PluginSourceReads
{
    internal static bool ReadFromItsPluginSource(this OpenedIndex index, PluginAddress plugin) =>
        index.PluginRowOf(plugin) is { IsCompiledPlugin: true, PluginSourceUnreadable: null };

    internal static bool ReadFromItsPluginFileForItsUnreadableSource(this OpenedIndex index, PluginAddress plugin) =>
        index.PluginRowOf(plugin) is { IsCompiledPlugin: true, PluginSourceUnreadable: not null };

    /// <summary>The problems of the one plugin an index over a single compiled plugin holds.</summary>
    internal static IReadOnlyList<SourceProblem> SourceProblems(this OpenedIndex index) =>
        Assert.Single(index.Queries.GetProblems().Value() ?? throw new InvalidOperationException("Expected a ready index.")).Problems;
}
