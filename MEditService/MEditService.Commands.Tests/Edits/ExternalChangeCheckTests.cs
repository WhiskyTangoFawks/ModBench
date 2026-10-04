using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class ExternalChangeCheckTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string Origin = "TestMod";

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ScratchDirectory _instanceRoot = new("medit-external-change-");

    private readonly Lazy<PutLoadOrderHandler> _handler;

    public ExternalChangeCheckTests() =>
        _handler = new(() => TestEditService.PutLoadOrderHandler(new LoadOrderHolder(), notifications: _notifications));

    private void Put(LoadOrderSnapshot snapshot) =>
        Assert.True(_handler.Value.Put(snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.GameRelease,
            snapshot.Plugins, [.. snapshot.Active.Select(p => p.Key)], [.. snapshot.LoadedWithNoLine.Select(p => p.Key)]).Applied);

    private string ModFolder => Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;

    public void Dispose() => _instanceRoot.Dispose();

    private LoadOrderSnapshot WithPlugins(params (string Name, byte[] Bytes)[] plugins)
    {
        foreach (var (name, bytes) in plugins) File.WriteAllBytes(Path.Combine(ModFolder, name), bytes);
        return SnapshotPlugins.Snapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [.. plugins.Select((plugin, slot) => new LoadOrderEntry(
                plugin.Name, Path.Combine(ModFolder, plugin.Name), Origin, slot, Enabled: true, Winning: true))]);
    }

    private static string Sha256(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static string TrailerHash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    private void Track(params (string Plugin, byte[] Bytes)[] plugins) =>
        SourceRepository.Track(ModFolder, SourcePreset.Edits, [.. plugins.Select(p => (
            (IReadOnlyList<TreeFile>)[new TreeFile(SourceRepository.HeaderDocumentFor(p.Plugin), "{}"u8.ToArray())],
            new BaselineTrailers(p.Plugin, null, TrailerHash(p.Bytes))))]);

    private ExternalChangeNotification TheExternalChange() =>
        Assert.Single(_notifications.Notifications.OfType<ExternalChangeNotification>());

    [Fact]
    public void ASnapshot_NamesATrackedPlugin_WithTheStateOfItsBytes_WhenTheyDifferFromWhatModbenchLastWrote()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var changed = "changed-by-xedit"u8.ToArray();
        WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        var loadOrder = WithPlugins((PluginName, changed));

        Put(loadOrder);

        var notice = TheExternalChange();
        Assert.Equal(Origin, notice.Origin);
        Assert.Equal([new ChangedPlugin(PluginName, Sha256(changed))], notice.Plugins);
    }

    [Fact]
    public async Task ASnapshot_NamesNoPlugin_ForTheBinaryARealCompileJustWrote()
    {
        using var mod = SourceEditFixture.Tracked();
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        var result = await CompileServices.Over(mod.LoadOrder).CompileAsync(mod.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);

        Put(mod.LoadOrder);

        var notice = Assert.IsType<ExternalChangeNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal(SourceEditFixture.ModFolderOrigin, notice.Origin);
        Assert.Empty(notice.Plugins);
    }

    [Fact]
    public void ASnapshot_NamesATrackedPluginThatCannotBeRead_WithNoState()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        File.Delete(Path.Combine(ModFolder, PluginName));

        Put(loadOrder);

        Assert.Equal([new ChangedPlugin(PluginName, null)], TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesATrackedPlugin_WhoseLastWriteIsGone()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        GitProbe.Run(Path.Combine(ModFolder, ".git"), ModFolder, "update-ref", "-d", SourceRepository.LastCompileRef(PluginName));

        Put(loadOrder);

        Assert.Equal([new ChangedPlugin(PluginName, Sha256(tracked))], TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesTheModsUntrackedPlugins_ApartFromItsChangedOnes()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked), ("Untracked.esp", "never tracked"u8.ToArray()));
        Track((PluginName, tracked));

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
        var untracked = Assert.Single(_notifications.Notifications.OfType<UntrackedPluginsNotification>());
        Assert.Equal(Origin, untracked.Origin);
        Assert.Equal(["Untracked.esp"], untracked.Plugins);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_ForAChangedTrackedFileOrMetaIni()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=1.0.0\n");
        File.WriteAllText(Path.Combine(ModFolder, ".gitignore"), "*.esp\n");
        Track((PluginName, tracked));
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=2.0.0\n");
        File.WriteAllText(Path.Combine(ModFolder, ".gitignore"), "*.esp\n*.esm\n");

        Put(loadOrder);

        Assert.Equal([], TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_TellsNothing_OfAnUntrackedMod()
    {
        var loadOrder = WithPlugins((PluginName, "anything"u8.ToArray()));

        Put(loadOrder);

        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_OfAModWhoseRepositoryWent()
    {
        var tracked = "the tracked binary"u8.ToArray();
        WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        Put(loadOrder);
        Assert.Single(TheExternalChange().Plugins);

        Directory.Delete(Path.Combine(ModFolder, ".git"), recursive: true);
        Put(loadOrder);

        var notices = _notifications.Notifications.OfType<ExternalChangeNotification>().ToList();
        Assert.Equal(2, notices.Count);
        Assert.Equal(Origin, notices[1].Origin);
        Assert.Empty(notices[1].Plugins);
    }

    [Fact]
    public void ASnapshot_TellsNothingMore_OfAModWhoseRepositoryWentBeforeTheLastSnapshot()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        Put(loadOrder);
        Directory.Delete(Path.Combine(ModFolder, ".git"), recursive: true);
        Put(loadOrder);
        var told = _notifications.Notifications.Count;

        Put(loadOrder);

        Assert.Equal(told, _notifications.Notifications.Count);
    }

    [Fact]
    public void ASnapshot_NamesAPlugin_OfAnUntrackedModThatGainedARepository()
    {
        var tracked = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, tracked));
        Put(loadOrder);
        Track((PluginName, tracked));
        File.WriteAllBytes(Path.Combine(ModFolder, PluginName), "changed-by-xedit"u8.ToArray());

        Put(loadOrder);

        var notice = TheExternalChange();
        Assert.Equal(Origin, notice.Origin);
        Assert.Equal([PluginName], notice.Plugins.Select(p => p.Name));
    }

    [Fact]
    public void ASnapshot_TellsNothing_OfARepositoryInTheDataFolder()
    {
        var bytes = "a plugin in the game's Data folder"u8.ToArray();
        File.WriteAllBytes(Path.Combine(_instanceRoot, PluginName), bytes);
        GitProbe.Run(Path.Combine(_instanceRoot, ".git"), _instanceRoot, "init", "-q", "-b", "main");
        GitProbe.Run(Path.Combine(_instanceRoot, ".git"), _instanceRoot, "commit", "-q", "--allow-empty", "-m", "a repository");

        Put(SnapshotPlugins.Snapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, Path.Combine(_instanceRoot, PluginName), PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true)]));

        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void ASnapshot_WritesNothing_IntoTheMod()
    {
        var tracked = "the tracked binary"u8.ToArray();
        WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        var before = FilesUnder(ModFolder);

        Put(loadOrder);

        Assert.Single(TheExternalChange().Plugins);
        Assert.Equal(before, FilesUnder(ModFolder));
    }

    [Fact]
    public void ASecondSnapshot_OverTheSameBytes_TellsTheSame()
    {
        var tracked = "the tracked binary"u8.ToArray();
        WithPlugins((PluginName, tracked));
        Track((PluginName, tracked));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));

        Put(loadOrder);
        Put(loadOrder);

        var notices = _notifications.Notifications.OfType<ExternalChangeNotification>().ToList();
        Assert.Equal(2, notices.Count);
        Assert.Equal(notices[0].Origin, notices[1].Origin);
        Assert.Equal(notices[0].Plugins, notices[1].Plugins);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_WhenAnInterruptedCompileLeftTheOldBinary()
    {
        var old = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Track((PluginName, old));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash("the compiled binary"u8.ToArray()));

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_WhenTwoInterruptedCompilesInARowLeftTheOldBinary()
    {
        var old = "the tracked binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Track((PluginName, old));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash("the first compile"u8.ToArray()));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash("the second compile"u8.ToArray()));

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_WhenAnInterruptedCompileLeftTheNewBinary()
    {
        var old = "the tracked binary"u8.ToArray();
        var compiled = "the compiled binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Track((PluginName, old));
        SourceRepository.ParkCompileSnapshot(ModFolder, PluginName, TrailerHash(compiled));
        File.WriteAllBytes(Path.Combine(ModFolder, PluginName), compiled);

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public async Task ASnapshot_NamesAPlugin_WhoseBinaryWasPutBackToTheOneBeforeALandedCompile()
    {
        using var mod = SourceEditFixture.Tracked();
        var pluginPath = mod.LoadOrder.Plugin(mod.Plugin)?.Path ?? throw new InvalidOperationException("Expected the fixture's plugin in its load order.");
        var before = File.ReadAllBytes(pluginPath);
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        var result = await CompileServices.Over(mod.LoadOrder).CompileAsync(mod.Plugin);
        Assert.True(result.Succeeded, result.RefusalReason);
        File.WriteAllBytes(pluginPath, before);

        Put(mod.LoadOrder);

        var notice = Assert.IsType<ExternalChangeNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal([new ChangedPlugin(mod.Plugin.Name, Sha256(before))], notice.Plugins);
    }

    private static Dictionary<string, string> FilesUnder(string folder) =>
        Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
            .ToDictionary(path => Path.GetRelativePath(folder, path), path => Sha256(File.ReadAllBytes(path)));
}
