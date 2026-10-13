using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class WrittenByCompileTests : IDisposable
{
    private const string PluginName = "Doors.esp";

    private static readonly string[] ModFiles =
    [
        "Doors.esp", "Strings/Doors_English.STRINGS", "Strings/Doors_English.DLSTRINGS", "Strings/Doors_French.ILSTRINGS",
        "Strings/Other_English.STRINGS", "Strings/Doors_English.txt", "Strings/Nested/Doors_English.STRINGS", "textures/door.dds",
    ];

    private readonly ScratchDirectory _modFolder = new("medit-written-by-compile-");

    public void Dispose() => _modFolder.Dispose();

    private RegisteredPlugin Plugin => new(
        PluginName, "Doors", Path.Combine(_modFolder, PluginName), new PluginProvider.FromMod("Doors", _modFolder, _modFolder), Line: null, PluginStrings.None);

    [Fact]
    public void OfALocalizedPlugin_AreThePluginAndItsStringsInEveryLanguage_AndNoOtherPluginsStrings()
    {
        LocalizedDoorPlugin.Write(Plugin.Path, "The Door");

        Assert.Equal(
            ["Doors.esp", "Strings/Doors_English.STRINGS", "Strings/Doors_English.DLSTRINGS", "Strings/Doors_French.ILSTRINGS"],
            TestAdapters.Mutagen().WrittenByCompile(Plugin, ModFiles, GameRelease.SkyrimSE));
    }

    [Fact]
    public void OfAPluginThatIsNotLocalized_IsThePluginAlone_ThoughStringsNamedForItSitBesideIt()
    {
        LocalizedDoorPlugin.WriteNameInPlugin(Plugin.Path, "The Door");

        Assert.Equal(["Doors.esp"], TestAdapters.Mutagen().WrittenByCompile(Plugin, ModFiles, GameRelease.SkyrimSE));
    }
}
