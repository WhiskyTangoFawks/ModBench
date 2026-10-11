using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.TestSupport;

/// <summary>A Skyrim SE localized plugin whose one door carries a name, written with its strings beside it.</summary>
public static class LocalizedDoorPlugin
{
    public static void Write(string pluginPath, string doorName)
    {
        var mod = new SkyrimMod(ModKey.FromFileName(Path.GetFileName(pluginPath)), SkyrimRelease.SkyrimSE) { UsingLocalization = true };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, doorName);
        ((IModGetter)mod).WriteToBinary(pluginPath);
    }

    /// <summary>Moves the strings written beside <paramref name="pluginPath"/> into one archive, leaving none loose.</summary>
    public static void PackStrings(string pluginPath, string archivePath)
    {
        var looseStrings = Path.Combine(Path.GetDirectoryName(pluginPath) ?? throw new ArgumentException("No folder.", nameof(pluginPath)), "Strings");
        StringsArchive.Pack(Directory.EnumerateFiles(looseStrings), archivePath);
        Directory.Delete(looseStrings, recursive: true);
    }
}
