using MEditService.LoadOrder;

namespace MEditService.RecordIndex;

/// <summary>The words a read of compiled plugins' records uses for what it could not read.</summary>
internal static class ReadFailures
{
    public static string Copy(string formKey, PluginAddress plugin) => $"{formKey} in {plugin.Name} ({plugin.Origin})";

    public static string NoModFolder(string pluginName) => $"{pluginName} is a compiled plugin but no mod folder provides it.";

    public static string LaterRead(IEnumerable<SourceFileFailure> files) => string.Join(" ", files.Select(file => file.Message));
}
