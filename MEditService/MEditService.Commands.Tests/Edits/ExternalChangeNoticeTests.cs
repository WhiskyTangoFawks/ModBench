using System.Security.Cryptography;
using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.RecordIndex.Queries;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.DependencyInjection;
using Mutagen.Bethesda;

namespace MEditService.Commands.Tests.Edits;

public sealed class ExternalChangeNoticeTests : IDisposable
{
    private const string PluginName = "Test.esp";
    private const string Origin = "TestMod";

    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ScratchDirectory _instanceRoot = new("medit-external-change-");

    private readonly Lazy<IServiceProvider> _service;

    public ExternalChangeNoticeTests() =>
        _service = new(() => TestEditService.Over(new LoadOrderHolder(), notifications: _notifications));

    private void Put(LoadOrderSnapshot snapshot, IServiceProvider? service = null) =>
        ExternalChanges.Put(snapshot, (service ?? _service.Value).GetRequiredService<PutLoadOrderHandler>());

    private IServiceProvider? _signalled;

    private void PutThenSignal(LoadOrderSnapshot snapshot, IServiceProvider? service = null)
    {
        Put(snapshot, service);
        _signalled = service ?? _service.Value;
        _signalled.GetRequiredService<SignalChangeHandler>().Signal([]);
    }

    private IReadOnlyList<string> TheChanged(string origin = Origin) =>
        (_signalled ?? _service.Value).GetRequiredService<IQueries>().Handed().ChangedOutside(origin);

    private IEnumerable<string> TheTold() =>
        _notifications.Notifications.OfType<PluginChangedNotification>().Select(told => told.Plugin.Name);

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

    [Fact]
    public async Task AChangeSignal_NamesNoPlugin_ForTheBinaryARealCompileJustWrote()
    {
        using var mod = SourceEditFixture.CompiledPlugin();
        mod.EditHandler.Set(mod.Plugin, mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);
        await mod.CompileHandler.CompileLandedAsync(mod.Plugin);

        PutThenSignal(mod.LoadOrder);

        Assert.Empty(_notifications.Notifications);
        Assert.Empty(TheChanged(SourceEditFixture.ModFolderOrigin));
    }

    [Fact]
    public void AChangeSignal_NamesACompiledPlugin_WhenItsBytesDifferFromWhatModbenchLastWrote()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));

        PutThenSignal(loadOrder, TestEditService.Over(new LoadOrderHolder(), adapter: new HashingAs("changed"), notifications: _notifications));

        Assert.Equal([PluginName], TheChanged());
        Assert.Equal([PluginName], TheTold());
    }

    [Fact]
    public void ALoadOrderPut_TellsNoExternalChange()
    {
        WithPlugins((PluginName, "the compiled plugin binary"u8.ToArray()));
        Init((PluginName, "the compiled plugin binary"u8.ToArray()));

        Put(WithPlugins((PluginName, "changed-by-xedit"u8.ToArray())));

        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void AChangeSignal_BeforeAnyLoadOrder_TellsNothing()
    {
        _service.Value.GetRequiredService<SignalChangeHandler>().Signal([]);

        Assert.Empty(_notifications.Notifications);
    }

    private sealed class HashingAs(string hash) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        public override string? HashOf(string pluginPath) => hash;
    }

    [Fact]
    public void AChangeSignal_NamesACompiledPluginThatCannotBeRead()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        File.Delete(Path.Combine(ModFolder, PluginName));

        PutThenSignal(loadOrder);

        Assert.Equal([PluginName], TheChanged());
    }

    [Fact]
    public void AChangeSignal_NamesACompiledPlugin_WhoseLastWriteIsGone()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        LastWriteRecord.Delete(ModFolder);

        PutThenSignal(loadOrder);

        Assert.Equal([PluginName], TheChanged());
    }

    [Fact]
    public void AChangeSignal_NamesNoChangedPlugin_ForAPluginWhoseSourceIsUnreadable()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin), ("SourceUnreadable.esp", "never compiled"u8.ToArray()));
        Init((PluginName, compiledPlugin));

        PutThenSignal(loadOrder);

        Assert.Empty(TheChanged());
    }

    [Fact]
    public void AChangeSignal_TellsNothing_OfAnNonSourceMod()
    {
        var loadOrder = WithPlugins((PluginName, "anything"u8.ToArray()));

        PutThenSignal(loadOrder);

        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void AChangeSignal_NamesNoPlugin_OfAModWhoseRepositoryWent()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        PutThenSignal(loadOrder);
        Assert.Single(TheChanged());

        AnotherTool.Delete(Path.Combine(ModFolder, ".git"));
        PutThenSignal(loadOrder);

        Assert.Empty(TheChanged());
        Assert.Equal([PluginName, PluginName], TheTold());
    }

    [Fact]
    public void AChangeSignal_NamesAPlugin_OfAnNonSourceModThatGainedARepository()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, compiledPlugin));
        PutThenSignal(loadOrder);
        Init((PluginName, compiledPlugin));
        File.WriteAllBytes(Path.Combine(ModFolder, PluginName), "changed-by-xedit"u8.ToArray());

        PutThenSignal(loadOrder);

        Assert.Equal([PluginName], TheChanged());
    }

    [Fact]
    public void AChangeSignal_TellsNothing_OfARepositoryInTheDataFolder()
    {
        var bytes = "a plugin in the game's Data folder"u8.ToArray();
        File.WriteAllBytes(Path.Combine(_instanceRoot, PluginName), bytes);
        GitProbe.Run(Path.Combine(_instanceRoot, ".git"), _instanceRoot, "init", "-q", "-b", "main");
        GitProbe.Run(Path.Combine(_instanceRoot, ".git"), _instanceRoot, "commit", "-q", "--allow-empty", "-m", "a repository");

        PutThenSignal(SnapshotPlugins.Snapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, Path.Combine(_instanceRoot, PluginName), PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true)]));

        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void AChangeSignal_WritesNothing_IntoTheMod()
    {
        var compiledPlugin = "the compiled plugin binary"u8.ToArray();
        WithPlugins((PluginName, compiledPlugin));
        Init((PluginName, compiledPlugin));
        var loadOrder = WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        var before = FilesUnder(ModFolder);

        PutThenSignal(loadOrder);

        Assert.Single(TheChanged());
        Assert.Equal(before, FilesUnder(ModFolder));
    }

    [Fact]
    public void AChangeSignal_NamesNoPlugin_WhenAnInterruptedCompileLeftTheOldBinary()
    {
        var old = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Init((PluginName, old));
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the compiled binary"u8.ToArray()), () => { });

        PutThenSignal(loadOrder);

        Assert.Empty(TheChanged());
    }

    [Fact]
    public void AChangeSignal_NamesNoPlugin_WhenTwoInterruptedCompilesInARowLeftTheOldBinary()
    {
        var old = "the compiled plugin binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Init((PluginName, old));
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the first compile"u8.ToArray()), () => { });
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the second compile"u8.ToArray()), () => { });

        PutThenSignal(loadOrder);

        Assert.Empty(TheChanged());
    }

    [Fact]
    public void AChangeSignal_NamesNoPlugin_WhenAnInterruptedCompileLeftTheNewBinary()
    {
        var old = "the compiled plugin binary"u8.ToArray();
        var compiled = "the compiled binary"u8.ToArray();
        var loadOrder = WithPlugins((PluginName, old));
        Init((PluginName, old));
        LastWriteRecord.Interrupt(
            ModFolder, PluginName, TrailerHash(compiled), () => File.WriteAllBytes(Path.Combine(ModFolder, PluginName), compiled));

        PutThenSignal(loadOrder);

        Assert.Empty(TheChanged());
    }

    private static Dictionary<string, string> FilesUnder(string folder) =>
        Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
            .ToDictionary(path => Path.GetRelativePath(folder, path), path => Sha256(File.ReadAllBytes(path)));
}
