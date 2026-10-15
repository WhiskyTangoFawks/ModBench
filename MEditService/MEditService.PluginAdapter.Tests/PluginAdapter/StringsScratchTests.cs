using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.PluginAdapter.Tests.PluginAdapter;

[Collection(ProcessEnvironmentCollection.Name)]
public sealed class StringsScratchTests : IDisposable
{
    private const string PluginName = "Update.esm";
    private const string ModName = "Cleaned Masters";
    private static readonly string[] TempVariables = ["TMPDIR", "TMP", "TEMP"];
    private static readonly IPluginAdapter Adapter = TestAdapters.Mutagen();

    private readonly ScratchDirectory _root = new("medit-strings-scratch-");
    private readonly Dictionary<string, string?> _restored = TempVariables.ToDictionary(name => name, Environment.GetEnvironmentVariable);
    private readonly string _temp;
    private readonly string _modFolder;
    private readonly string _pluginPath;
    private readonly RegisteredPlugin _plugin;
    private readonly LoadOrderSnapshot _loadOrder;

    public StringsScratchTests()
    {
        _temp = Directory.CreateDirectory(Path.Combine(_root, "temp")).FullName;
        foreach (var name in TempVariables) Environment.SetEnvironmentVariable(name, _temp);

        _modFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", ModName)).FullName;
        var dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Game", "Data")).FullName;
        _pluginPath = Path.Combine(_modFolder, PluginName);
        LocalizedDoorPlugin.Write(_pluginPath, "The Big Door");
        LocalizedDoorPlugin.PackStrings(_pluginPath, Path.Combine(dataFolder, "Skyrim - Interface.bsa"));
        _plugin = new RegisteredPlugin(
            PluginName, ModName, _pluginPath, new PluginProvider.FromMod(ModName, _modFolder, _modFolder), new PluginLine(0, NamesIt: true),
            HandedStrings.Of(_pluginPath));
        _loadOrder = new LoadOrderSnapshot(dataFolder, null, GameRelease.SkyrimSE, [_plugin], [_plugin.Key], [], [HandedStrings.Stamped(Path.Combine(dataFolder, "Skyrim - Interface.bsa"))], [], []);
    }

    public void Dispose()
    {
        if (!OperatingSystem.IsWindows()) FileModes.Set(_temp, "700");
        foreach (var (name, value) in _restored) Environment.SetEnvironmentVariable(name, value);
        _root.Dispose();
    }

    private IPluginDocuments OpenDocuments() =>
        Adapter.OpenDocuments(new ModPath(ModKey.FromFileName(PluginName), _pluginPath), _loadOrder,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE), _plugin.Strings).Answered();

    [Fact]
    public async Task ReadsOfStringsCopiedFromAnArchiveTheGameLoads_LeaveNothingInTemp()
    {
        OpenDocuments().Dispose();
        (await Adapter.ReadSourceOfAsync(_plugin, _loadOrder)).Answered();

        Assert.Empty(Directory.EnumerateFileSystemEntries(_temp));
    }

    [PosixFact]
    public void DisposingAReadWhoseStringsScratchWillNotDelete_LeavesItInTempWithoutThrowing()
    {
        var documents = OpenDocuments();
        FileModes.Set(_temp, "500");

        documents.Dispose();

        Assert.Single(Directory.EnumerateFileSystemEntries(_temp));
    }
}
