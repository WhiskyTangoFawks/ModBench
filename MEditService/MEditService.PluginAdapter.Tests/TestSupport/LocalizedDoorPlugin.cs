using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.TestSupport;

/// <summary>A localized plugin whose one door carries a name, written with its strings beside it.</summary>
public static class LocalizedDoorPlugin
{
    public static void Write(string pluginPath, string doorName, bool localized = true)
    {
        var mod = new SkyrimMod(ModKey.FromFileName(Path.GetFileName(pluginPath)), SkyrimRelease.SkyrimSE) { UsingLocalization = localized };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, doorName);
        ((IModGetter)mod).WriteToBinary(pluginPath);
    }

    public static void WriteFallout4(string pluginPath, string doorName)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Path.GetFileName(pluginPath)), Fallout4Release.Fallout4) { UsingLocalization = true };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, doorName);
        ((IModGetter)mod).WriteToBinary(pluginPath);
    }

    /// <summary>Moves the strings written beside <paramref name="pluginPath"/> into one archive, leaving none loose.</summary>
    public static void PackStrings(string pluginPath, string archivePath)
    {
        var looseStrings = LooseStrings(pluginPath);
        StringsArchive.Pack(Directory.EnumerateFiles(looseStrings), archivePath);
        Directory.Delete(looseStrings, recursive: true);
    }

    /// <summary><see cref="PackStrings"/> into a Fallout 4 archive.</summary>
    public static void PackStringsBa2(string pluginPath, string archivePath)
    {
        var looseStrings = LooseStrings(pluginPath);
        StringsBa2.Pack(Directory.EnumerateFiles(looseStrings), archivePath);
        Directory.Delete(looseStrings, recursive: true);
    }

    public static string LooseStrings(string pluginPath) =>
        Path.Combine(Path.GetDirectoryName(pluginPath) ?? throw new ArgumentException("No folder.", nameof(pluginPath)), "Strings");
}
