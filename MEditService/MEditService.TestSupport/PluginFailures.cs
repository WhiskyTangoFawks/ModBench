using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Strings;

namespace MEditService.TestSupport;

/// <summary>Failures the real adapter answers, for a double to answer in its place.</summary>
public static class PluginFailures
{
    /// <summary>What a read of bytes Mutagen cannot parse answers.</summary>
    public static PluginFailure Unparsed()
    {
        using var folder = new ScratchDirectory("medit-unparsed-");
        var path = Path.Combine(folder.Path, "Unparsed.esp");
        File.WriteAllText(path, "not a plugin");
        return ReadOf(path);
    }

    /// <summary>What a read of a file that is not there answers.</summary>
    public static PluginFailure Inaccessible()
    {
        using var folder = new ScratchDirectory("medit-inaccessible-");
        return ReadOf(Path.Combine(folder.Path, "Absent.esp"));
    }

    /// <summary>What a decompile of a localized plugin whose strings files are nowhere answers.</summary>
    public static async Task<PluginFailure> MissingStringsAsync()
    {
        using var folder = new ScratchDirectory("medit-missing-strings-");
        var path = Path.Combine(folder.Path, "Localized.esp");
        var mod = new Fallout4Mod(ModKey.FromFileName("Localized.esp"), Fallout4Release.Fallout4) { UsingLocalization = true };
        mod.Doors.AddNew("MainDoor").Name = new TranslatedString(Language.English, "The Big Door");
        ((IModGetter)mod).WriteToBinary(path);
        Directory.Delete(Path.Combine(folder.Path, "Strings"), recursive: true);
        var plugin = SnapshotPlugins.Of([new LoadOrderEntry("Localized.esp", path, PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true)]).Single();
        return (await TestAdapters.Mutagen().ReadSourceOfAsync(plugin, EmptyLoadOrder.Of(GameRelease.Fallout4))).Failure();
    }

    private static PluginFailure ReadOf(string path) =>
        TestAdapters.Mutagen().ReadContent(new ModPath(ModKey.FromFileName(Path.GetFileName(path)), path), EmptyLoadOrder.Of(GameRelease.Fallout4), PluginStrings.None).Failure();
}
