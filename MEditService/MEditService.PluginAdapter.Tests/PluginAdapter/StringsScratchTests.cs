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

    private readonly ScratchDirectory _root = new("medit-strings-scratch-");
    private readonly Dictionary<string, string?> _restored = TempVariables.ToDictionary(name => name, Environment.GetEnvironmentVariable);
    private readonly string _temp;

    public StringsScratchTests()
    {
        _temp = Directory.CreateDirectory(Path.Combine(_root, "temp")).FullName;
        foreach (var name in TempVariables) Environment.SetEnvironmentVariable(name, _temp);
    }

    public void Dispose()
    {
        foreach (var (name, value) in _restored) Environment.SetEnvironmentVariable(name, value);
        _root.Dispose();
    }

    [Fact]
    public async Task ReadsOfStringsCopiedFromAnArchiveTheGameLoads_LeaveNothingInTemp()
    {
        var modFolder = Directory.CreateDirectory(Path.Combine(_root, "mods", ModName)).FullName;
        var dataFolder = Directory.CreateDirectory(Path.Combine(_root, "Game", "Data")).FullName;
        var pluginPath = Path.Combine(modFolder, PluginName);
        LocalizedDoorPlugin.Write(pluginPath, "The Big Door");
        LocalizedDoorPlugin.PackStrings(pluginPath, Path.Combine(dataFolder, "Skyrim - Interface.bsa"));
        var loadOrder = new LoadOrderSnapshot(dataFolder, null, GameRelease.SkyrimSE, [], [], [], [Path.Combine(dataFolder, "Skyrim - Interface.bsa")]);
        var strings = new PluginStrings(modFolder, dataFolder);
        var adapter = TestAdapters.Mutagen();

        adapter.OpenDocuments(new ModPath(ModKey.FromFileName(PluginName), pluginPath), loadOrder,
            SharedSchemaReflector.Instance.GetSchemas(GameRelease.SkyrimSE), strings).Answered().Dispose();
        (await adapter.ReadSourceOfAsync(
            new RegisteredPlugin(PluginName, ModName, pluginPath, new PluginProvider.FromMod(ModName, modFolder), Line: null),
            loadOrder, strings)).Answered();

        Assert.Empty(Directory.EnumerateFileSystemEntries(_temp));
    }
}
