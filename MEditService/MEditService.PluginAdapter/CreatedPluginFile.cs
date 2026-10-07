using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter;

/// <summary>Where <see cref="IPluginAdapter.CreateAndWriteAsync"/> puts a plugin, and the take-back of
/// a file it wrote.</summary>
public static class CreatedPluginFile
{
    public static string PathIn(ModKey modKey, string folder) => Path.Combine(folder, modKey.FileName.String);

    public static void TakeBack(string path) => File.Delete(path);
}
