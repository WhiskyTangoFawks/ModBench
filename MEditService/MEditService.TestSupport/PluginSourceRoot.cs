using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.TestSupport;

/// <summary>Where a plugin's source tree sits in a mod folder, as the tests that act as another tool
/// or arrange a tree by hand name it.</summary>
public static class PluginSourceRoot
{
    public static string For(string pluginFileName) => Path.Combine("plugin-source", pluginFileName);

    public static string HeaderDocument(string pluginFileName) => Path.Combine(For(pluginFileName), $"000000_{pluginFileName}.json");

    public static string ContainerDocument(string containerDirectory) =>
        Path.Combine(containerDirectory, Path.GetFileName(containerDirectory) + ".json");

    public static string In(string modFolder, string pluginFileName) => Path.Combine(modFolder, For(pluginFileName));

    /// <summary>The name a record's file or directory carries in the tree.</summary>
    public static string Leaf(IMajorRecordGetter record) =>
        $"{record.EditorID} - {record.FormKey.ID:X6}_{record.FormKey.ModKey.FileName}";
}
