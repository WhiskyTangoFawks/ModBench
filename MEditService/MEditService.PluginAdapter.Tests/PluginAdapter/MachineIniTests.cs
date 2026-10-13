using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class MachineIniTests : IDisposable
{
    private const string PluginName = "Update.esm";
    private const string DoorName = "The Big Door";
    private const string Archive = "Skyrim - Interface.bsa";

    private readonly ScratchDirectory _root = new("medit-machine-ini-");
    private readonly string? _home = Environment.GetEnvironmentVariable("HOME");
    private readonly string _modFolder;
    private readonly string _pluginPath;

    public MachineIniTests()
    {
        _modFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", "Cleaned Masters")).FullName;
        _pluginPath = Path.Combine(_modFolder, PluginName);
        LocalizedDoorPlugin.Write(_pluginPath, DoorName);
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(_modFolder, Archive));

        var home = Directory.CreateDirectory(Path.Combine(_root, "home")).FullName;
        var myGames = Directory.CreateDirectory(Path.Combine(home, "Documents", "My Games", "Skyrim Special Edition")).FullName;
        File.WriteAllText(Path.Combine(myGames, "Skyrim.ini"), $"[Archive]\nsResourceArchiveList={Archive}\n");
        Environment.SetEnvironmentVariable("HOME", home);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("HOME", _home);
        _root.Dispose();
    }

    [PosixFact]
    public void OpenDocuments_AnArchiveThisMachinesGameIniListsBesideThePlugin_IsNotReadWhenTheSnapshotListsNone()
    {
        var loadOrder = new LoadOrderSnapshot(_modFolder, null, GameRelease.SkyrimSE, [], [], [], [], []);

        using var documents = TestAdapters.Mutagen().OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), _pluginPath), loadOrder,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE), PluginStrings.None).Answered();

        Assert.DoesNotContain(DoorName, documents.Records.Single().Text, StringComparison.Ordinal);
    }
}
