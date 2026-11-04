using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Strings;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

public sealed class ChangedPathTests
{
    private static readonly string ModFolder = Path.GetFullPath(Path.Combine("instance", "mods", "Doors"));
    private static readonly string DataFolder = Path.GetFullPath(Path.Combine("game", "Data"));
    private static readonly string TranslationsArchive = Path.Combine(ModFolder, "Doors - Main.ba2");

    private static LoadOrderEntry PluginNamed(string name, PluginStrings? strings = null) =>
        new(name, Path.Combine(ModFolder, name), "Doors", 0, Enabled: true, Winning: true, NamedStrings: strings ?? PluginStrings.None);

    private static LoadOrderSnapshot LoadOrder
    {
        get
        {
            LoadOrderEntry[] plugins =
            [
                PluginNamed("Doors.esp", new PluginStrings(
                    [new StampedFile(TranslationsArchive, "1")], [new StampedFile(Path.Combine(ModFolder, "Strings", "Doors_English.STRINGS"), "1")])),
                PluginNamed("Windows.esp"),
            ];
            return new LoadOrderSnapshot(
                DataFolder, ModFolder, GameRelease.Fallout4, SnapshotPlugins.Of(plugins), SnapshotPlugins.Active(plugins), [],
                [new StampedFile(Path.Combine(DataFolder, "Fallout4 - Interface.ba2"), "1"), new StampedFile(TranslationsArchive, "1")],
                [new StampedFile(Path.Combine(DataFolder, "Strings", "Fallout4_English.STRINGS"), "1")], [], Language.English);
        }
    }

    [Theory]
    [InlineData("instance/mods/Doors/Doors.esp", "Doors.esp")]
    [InlineData("instance/mods/Doors/Strings/../Doors.esp", "Doors.esp")]
    [InlineData("instance/mods/Doors/Strings/Doors_English.STRINGS", "Doors.esp")]
    [InlineData("game/Data/Fallout4 - Interface.ba2", "unnamed")]
    [InlineData("game/Data/Strings/Fallout4_English.STRINGS", "unnamed")]
    [InlineData("instance/mods/Doors/Doors - Main.ba2", "unnamed")]
    [InlineData("instance/mods/Doors/Doors.esp.tmp", "untouched")]
    [InlineData("instance/mods/Doors/textures/door.dds", "untouched")]
    public void APath_TouchesThePluginsWhoseFileOrStringsItIs_OrPluginsItCannotNameForStringsTheGameLoads(string path, string answer)
    {
        Assert.Equal(answer, PathAnswers.Spelled(TestAdapters.Mutagen().Touching(LoadOrder, Path.GetFullPath(path))));
    }
}
