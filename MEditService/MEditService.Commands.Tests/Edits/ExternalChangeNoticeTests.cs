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
    private static readonly byte[] Compiled = "the compiled plugin binary"u8.ToArray();

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

    private LoadOrderSnapshot Installed(params (string Name, byte[] Bytes)[] others)
    {
        var loadOrder = WithPlugins([(PluginName, Compiled), .. others]);
        Init((PluginName, Compiled));
        return loadOrder;
    }

    private LoadOrderSnapshot ChangedByAnotherTool()
    {
        var loadOrder = Installed();
        WithPlugins((PluginName, "changed-by-xedit"u8.ToArray()));
        return loadOrder;
    }

    private LoadOrderSnapshot Unreadable()
    {
        var loadOrder = Installed();
        File.Delete(Path.Combine(ModFolder, PluginName));
        return loadOrder;
    }

    private LoadOrderSnapshot LastWriteGone()
    {
        var loadOrder = Installed();
        LastWriteRecord.Delete(ModFolder);
        return loadOrder;
    }

    public static TheoryData<string, Func<ExternalChangeNoticeTests, LoadOrderSnapshot>> ChangedOutsideModbench => new()
    {
        { "its bytes differ from what Modbench last wrote", test => test.ChangedByAnotherTool() },
        { "it cannot be read", test => test.Unreadable() },
        { "its last write is gone", test => test.LastWriteGone() },
    };

    [Theory]
    [MemberData(nameof(ChangedOutsideModbench))]
    public void AChangeSignal_NamesAndTellsACompiledPlugin_ChangedOutsideModbench(string _, Func<ExternalChangeNoticeTests, LoadOrderSnapshot> arrange)
    {
        PutThenSignal(arrange(this));

        Assert.Equal([PluginName], TheChanged());
        Assert.Equal([PluginName], TheTold());
    }

    private LoadOrderSnapshot WithASourceUnreadable() => Installed(("SourceUnreadable.esp", "never compiled"u8.ToArray()));

    private LoadOrderSnapshot InterruptedLeavingTheOldBinary()
    {
        var loadOrder = Installed();
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the compiled binary"u8.ToArray()), () => { });
        return loadOrder;
    }

    private LoadOrderSnapshot TwiceInterruptedLeavingTheOldBinary()
    {
        var loadOrder = Installed();
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the first compile"u8.ToArray()), () => { });
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash("the second compile"u8.ToArray()), () => { });
        return loadOrder;
    }

    private LoadOrderSnapshot InterruptedLeavingTheNewBinary()
    {
        var loadOrder = Installed();
        var compiled = "the compiled binary"u8.ToArray();
        LastWriteRecord.Interrupt(ModFolder, PluginName, TrailerHash(compiled), () => File.WriteAllBytes(Path.Combine(ModFolder, PluginName), compiled));
        return loadOrder;
    }

    public static TheoryData<string, Func<ExternalChangeNoticeTests, LoadOrderSnapshot>> UnchangedOutsideModbench => new()
    {
        { "a plugin whose source is unreadable", test => test.WithASourceUnreadable() },
        { "an interrupted compile that left the old binary", test => test.InterruptedLeavingTheOldBinary() },
        { "two interrupted compiles in a row that left the old binary", test => test.TwiceInterruptedLeavingTheOldBinary() },
        { "an interrupted compile that left the new binary", test => test.InterruptedLeavingTheNewBinary() },
    };

    [Theory]
    [MemberData(nameof(UnchangedOutsideModbench))]
    public void AChangeSignal_NamesNoPluginAsChangedOutsideModbench(string _, Func<ExternalChangeNoticeTests, LoadOrderSnapshot> arrange)
    {
        PutThenSignal(arrange(this));

        Assert.Empty(TheChanged());
    }

    private void SignalledBeforeAnyLoadOrder() => _service.Value.GetRequiredService<SignalChangeHandler>().Signal([]);

    private void PutChangedByAnotherTool()
    {
        Installed();
        Put(WithPlugins((PluginName, "changed-by-xedit"u8.ToArray())));
    }

    private void SignalledOverANonSourceMod() => PutThenSignal(WithPlugins((PluginName, "anything"u8.ToArray())));

    private void SignalledOverARepositoryInTheDataFolder()
    {
        File.WriteAllBytes(Path.Combine(_instanceRoot, PluginName), "a plugin in the game's Data folder"u8.ToArray());
        GitProbe.Run(Path.Combine(_instanceRoot, ".git"), _instanceRoot, "init", "-q", "-b", "main");
        GitProbe.Run(Path.Combine(_instanceRoot, ".git"), _instanceRoot, "commit", "-q", "--allow-empty", "-m", "a repository");
        PutThenSignal(SnapshotPlugins.Snapshot(_instanceRoot, _instanceRoot, GameRelease.Fallout4,
            [new LoadOrderEntry(PluginName, Path.Combine(_instanceRoot, PluginName), PluginOrigin.DataDirectory, 0, Enabled: true, Winning: true)]));
    }

    public static TheoryData<string, Action<ExternalChangeNoticeTests>> TellingNothing => new()
    {
        { "a change signal before any load order", test => test.SignalledBeforeAnyLoadOrder() },
        { "a load order put over bytes another tool changed", test => test.PutChangedByAnotherTool() },
        { "a change signal over a mod that is not a source mod", test => test.SignalledOverANonSourceMod() },
        { "a change signal over a repository in the Data folder", test => test.SignalledOverARepositoryInTheDataFolder() },
    };

    [Theory]
    [MemberData(nameof(TellingNothing))]
    public void TellsNoExternalChange(string _, Action<ExternalChangeNoticeTests> act)
    {
        act(this);

        Assert.Empty(_notifications.Notifications);
    }

    [Fact]
    public void AChangeSignal_NamesNoPlugin_OfAModWhoseRepositoryWent()
    {
        var loadOrder = ChangedByAnotherTool();
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
        var loadOrder = WithPlugins((PluginName, Compiled));
        PutThenSignal(loadOrder);
        Init((PluginName, Compiled));
        File.WriteAllBytes(Path.Combine(ModFolder, PluginName), "changed-by-xedit"u8.ToArray());

        PutThenSignal(loadOrder);

        Assert.Equal([PluginName], TheChanged());
    }

    [Fact]
    public void AChangeSignal_WritesNothing_IntoTheMod()
    {
        var loadOrder = ChangedByAnotherTool();
        var before = FilesUnder(ModFolder);

        PutThenSignal(loadOrder);

        Assert.Single(TheChanged());
        Assert.Equal(before, FilesUnder(ModFolder));
    }

    private static Dictionary<string, string> FilesUnder(string folder) =>
        Directory.EnumerateFiles(folder, "*", SearchOption.AllDirectories)
            .ToDictionary(path => Path.GetRelativePath(folder, path), path => Sha256(File.ReadAllBytes(path)));
}
