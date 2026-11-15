using MEditService.LoadOrder;

namespace MEditService.RecordIndex;

/// <summary>The words a read of compiled plugins' records uses for what it could not read.</summary>
internal static class ReadFailures
{
    public static string Copy(string formKey, PluginAddress plugin) => $"{formKey} in {plugin.Name} ({plugin.Origin})";

    public static string NoModFolder(string pluginName) => $"{pluginName} is a compiled plugin but no mod folder provides it.";

    /// <summary>Why each plugin held with a failure failed to read, the plugins whose rows are the last good read's.</summary>
    public static IReadOnlyDictionary<PluginAddress, string> HeldReasons(Indexer index) =>
        index.Status.Failures.DistinctBy(failure => new PluginAddress(failure.Name, failure.Origin), PluginAddress.Comparer)
            .ToDictionary(failure => new PluginAddress(failure.Name, failure.Origin), failure => failure.Reason, PluginAddress.Comparer);

    public static string LaterRead(IEnumerable<SourceFileFailure> files) => string.Join(" ", files.Select(file => file.Message));
}
