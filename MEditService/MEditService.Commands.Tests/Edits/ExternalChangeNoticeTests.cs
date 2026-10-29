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

public sealed class ExternalChangeNoticeTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string Origin = "TestMod";

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ScratchDirectory _instanceRoot = new("medit-external-change-");

    private readonly Lazy<PutLoadOrderHandler> _handler;

    public ExternalChangeNoticeTests() =>
        _handler = new(() => TestEditService.PutLoadOrderHandler(new LoadOrderHolder(), notifications: _notifications));

    private void Put(LoadOrderSnapshot snapshot, PutLoadOrderHandler? handler = null) =>
        Assert.True((handler ?? _handler.Value).Put(snapshot.DataFolderPath, snapshot.InstanceRoot, snapshot.GameRelease,
            snapshot.Plugins, [.. snapshot.Active.Select(p => p.Key)], [.. snapshot.LoadedWithNoLine.Select(p => p.Key)], snapshot.Archives, snapshot.StringsFiles,
            snapshot.Places, snapshot.StringsLanguage).Holds(out _, out _));

    private string ModFolder => Directory.CreateDirectory(Path.Combine(_instanceRoot, "mods", Origin)).FullName;

    public void Dispose() => _instanceRoot.Dispose();

    private LoadOrderSnapshot WithPlugins(params (string Name, byte[] Bytes)[] plugins)
    {
        foreach (var (name, bytes) in plugins) File.WriteAllBytes(Path.Combine(ModFolder, name), bytes);
        return SnapshotPlugins.Snapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [.. plugins.Select((plugin, line) => new LoadOrderEntry(
                plugin.Name, Path.Combine(ModFolder, plugin.Name), Origin, line, Enabled: true, Winning: true))]);
    }

    private static string Sha256(byte[] bytes) => Convert.ToHexStringLower(SHA256.HashData(bytes));

    private static string TrailerHash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes));

    private void Init(params (string Plugin, byte[] Bytes)[] plugins) =>
        TestAdapters.Source().Init(ModFolder, [.. plugins.Select(p => (
            (IReadOnlyList<TreeFile>)[new TreeFile(TreeTampering.HeaderDocumentOf(p.Plugin), "{}"u8.ToArray())],
            new DecompiledPlugin(new PluginAddress(p.Plugin, Origin), TrailerHash(p.Bytes))))]);

    private ExternalChangeNotification TheExternalChange() =>
        Assert.Single(_notifications.Notifications.OfType<ExternalChangeNotification>());

    [Fact]
    public async Task ASnapshot_NamesNoPlugin_ForTheBinaryARealCompileJustWrote()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        await mod.CompileHandler.CompileLandedAsync(mod.Plugin);

        Put(mod.LoadOrder);

        var notice = Assert.IsType<ExternalChangeNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal(SourceEditFixture.ModFolderOrigin, notice.Origin);
        Assert.Empty(notice.Plugins);
    }

    [Fact]
    public void ASnapshot_NamesACompiledPlugin_WithTheStateOfItsBytes_WhenTheyDifferFromWhatModbenchLastWrote()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));

        Put(loadOrder, TestEditService.PutLoadOrderHandler(new LoadOrderHolder(), _notifications, new HashingAs("changed")));

        var notice = TheExternalChange();
        Assert.Equal(Origin, notice.Origin);
        Assert.Equal([new ChangedPlugin(PluginName, "changed")], notice.Plugins);
    }

    private sealed class HashingAs(string hash) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override string? HashOf(string pluginPath) => hash;
    }

    [Fact]
    public void ASnapshot_NamesACompiledPluginThatCannotBeRead_WithNoState()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        File.Delete(Path.Combine(ModFolder, PluginName));

        Put(loadOrder);

        Assert.Equal([new ChangedPlugin(PluginName, null)], TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesACompiledPlugin_WhoseLastWriteIsGone()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        LastWriteRecord.Delete(ModFolder);

        Put(loadOrder);

        Assert.Equal([new ChangedPlugin(PluginName, Sha256(compiledPlugin))], TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesThePluginsWhoseSourceIsUnreadable_ApartFromItsChangedOnes()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin), ("SourceUnreadable.esp", "never compiled"u8.ToArray()));
        Init((PluginName, compiledPlugin));

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
        var unreadable = Assert.Single(_notifications.Notifications.OfType<PluginSourceUnreadableNotification>());
        Assert.Equal(Origin, unreadable.Origin);
        var plugin = Assert.Single(unreadable.Plugins);
        Assert.Equal("SourceUnreadable.esp", plugin.Name);
        Assert.Contains("SourceUnreadable.esp", plugin.Source.Reason, StringComparison.Ordinal);
        Assert.True(plugin.Source.DecompileRepairs);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_ForAChangedCompiledPluginFileOrMetaIni()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=1.0.0\n");
        File.WriteAllText(Path.Combine(ModFolder, ".gitignore"), "*.esp\n");
        Init((PluginName, compiledPlugin));
        File.WriteAllText(Path.Combine(ModFolder, "meta.ini"), "version=2.0.0\n");
        File.WriteAllText(Path.Combine(ModFolder, ".gitignore"), "*.esp\n*.esm\n");

        Put(loadOrder);

        Assert.Equal([], TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_TellsNothing_OfAnNonSourceMod()
    {
        var loadOrder = WithPlugins((PluginName, "anything"u8.ToArray()));

        Put(loadOrder);

        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_OfAModWhoseRepositoryWent()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        Put(loadOrder);
        Assert.Single(TheExternalChange().Plugins);

        AnotherTool.Delete(Path.Combine(ModFolder, ".git"));
        Put(loadOrder);

        var notices = _notifications.Notifications.OfType<ExternalChangeNotification>().ToList();
        Assert.Equal(2, notices.Count);
        Assert.Equal(Origin, notices[1].Origin);
        Assert.Empty(notices[1].Plugins);
    }

    [Fact]
    public void ASnapshot_TellsNothingMore_OfAModWhoseRepositoryWentBeforeTheLastSnapshot()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        Put(loadOrder);
        AnotherTool.Delete(Path.Combine(ModFolder, ".git"));
        Put(loadOrder);
        var told = _notifications.Notifications.Count;

        Put(loadOrder);

        Assert.Equal(told, _notifications.Notifications.Count);
    }

    [Fact]
    public void ASnapshot_NamesAPlugin_OfAnNonSourceModThatGainedARepository()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Put(loadOrder);
        Init((PluginName, compiledPlugin));
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
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        var before = FilesUnder(ModFolder);

        Put(loadOrder);

        Assert.Single(TheExternalChange().Plugins);
        Assert.Equal(before, FilesUnder(ModFolder));
    }

    [Fact]
    public void ASecondSnapshot_OverTheSameBytes_TellsTheSame()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
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
        var old = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Init((PluginName, old));
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the compiled binary"u8.ToArray()), () => { });

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_WhenTwoInterruptedCompilesInARowLeftTheOldBinary()
    {
        var old = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Init((PluginName, old));
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the first compile"u8.ToArray()), () => { });
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the second compile"u8.ToArray()), () => { });

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public void ASnapshot_NamesNoPlugin_WhenAnInterruptedCompileLeftTheNewBinary()
    {
        var old = "the compiled plugin binary"u8.ToArray();
        var compiled = "the compiled binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Init((PluginName, old));
        LastWriteRecord.Interrupt(
            ModFolder, PluginName, TrailerHash(compiled), () => File.WriteAllBytes(Path.Combine(ModFolder, PluginName), compiled));

        Put(loadOrder);

        Assert.Empty(TheExternalChange().Plugins);
    }

    [Fact]
    public async Task ASnapshot_NamesAPlugin_WhoseBinaryWasPutBackToTheOneBeforeALandedCompile()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        var pluginPath = mod.LoadOrder.Plugin(mod.Plugin)?.Path ?? throw new InvalidOperationException("Expected the fixture's plugin in its load order.");
        var before = File.ReadAllBytes(pluginPath);
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        await mod.CompileHandler.CompileLandedAsync(mod.Plugin);
        File.WriteAllBytes(pluginPath, before);

        Put(mod.LoadOrder);

        var notice = Assert.IsType<ExternalChangeNotification>(Assert.Single(_notifications.Notifications));
        Assert.Equal([new ChangedPlugin(mod.Plugin.Name, Sha256(before))], notice.Plugins);
    }

    private static Dictionary<string, string> FilesUnder(string folder) =>
        Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
            .ToDictionary(path => Path.GetRelativePath(folder, path), path => Sha256(File.ReadAllBytes(path)));
}
