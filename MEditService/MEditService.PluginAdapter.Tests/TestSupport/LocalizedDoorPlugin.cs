using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.TestSupport;

/// <summary>A plugin whose one door carries a name. Localized, it is written with its strings beside it.</summary>
public static class LocalizedDoorPlugin
{
    public static void Write(string pluginPath, string doorName, Language language = Language.English) =>
        WriteSkyrim(pluginPath, doorName, language, localized: true);

    /// <summary>A plugin without the localized flag, whose name sits in the plugin itself.</summary>
    public static void WriteNameInPlugin(string pluginPath, string doorName) =>
        WriteSkyrim(pluginPath, doorName, Language.English, localized: false);

    public static void WriteFallout4(string pluginPath, string doorName)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Path.GetFileName(pluginPath)), Fallout4Release.Fallout4) { UsingLocalization = true };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, doorName);
        ((IModGetter)mod).WriteToBinary(pluginPath);
    }

    private static void WriteSkyrim(string pluginPath, string doorName, Language language, bool localized)
    {
        var mod = new SkyrimMod(ModKey.FromFileName(Path.GetFileName(pluginPath)), SkyrimRelease.SkyrimSE) { UsingLocalization = localized };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(language, doorName);
        ((IModGetter)mod).WriteToBinary(pluginPath);
    }

    /// <summary>Moves the strings written beside <paramref name="pluginPath"/> into one archive, a BA2 or a
    /// BSA by its extension, leaving none loose.</summary>
    public static void PackStrings(string pluginPath, string archivePath)
    {
        var looseStrings = LooseStrings(pluginPath);
        var files = Directory.EnumerateFiles(looseStrings);
        if (Path.GetExtension(archivePath).Equals(".ba2", StringComparison.OrdinalIgnoreCase)) StringsBa2.Pack(files, archivePath);
        else StringsArchive.Pack(files, archivePath);
        Directory.Delete(looseStrings, recursive: true);
    }

    public static string LooseStrings(string pluginPath) =>
        Path.Combine(Path.GetDirectoryName(pluginPath) ?? throw new ArgumentException("No folder.", nameof(pluginPath)), "Strings");
}
