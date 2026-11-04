using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.RecordIndex.Tests.TestSupport.Announcements;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class EveryCheckValidatesTests : IDisposable
{

    private const string NonCompiledPlugin = "NonCompiledPlugin.esp";
    private const string CompiledPlugin = "CompiledPlugin.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _nonCompiledPlugin;
    private readonly LoadOrderEntry _compiledPlugin;
    private readonly string _compiledPluginNpc;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly DiskSaysAdapter _disk;
    private readonly OpenedIndex _index;

    public EveryCheckValidatesTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("every-check-validates")
            .WithPlugin(NonCompiledPlugin, mod => mod.Npcs.AddNew("NonCompiledPluginNpc"), origin: "NonSourceMod")
            .WithPlugin(CompiledPlugin, mod => npc = mod.Npcs.AddNew("CompiledPluginNpc").FormKey, origin: "SourceMod")
            .BuildScattered();
        _nonCompiledPlugin = _fixture.Plugins.Single(p => p.Name == NonCompiledPlugin);
        _compiledPlugin = _fixture.Plugins.Single(p => p.Name == CompiledPlugin);
        _compiledPluginNpc = npc.ToString();
        SourceMods.Init(_compiledPlugin);
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        _disk = new DiskSaysAdapter(clock);
        _index = Indexes.Open(_holder, _disk, notifications: _notifications, timeProvider: clock);
        Reconcile();
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Reconcile() =>
        _index.Reconcile(_holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private void CheckAnnouncing(Predicate<INotification> announced)
    {
        var before = _notifications.Notifications.Count;
        _index.NextCheckUntil(() => _notifications.Since(before).Any(n => announced(n)), "the check's announcement");
    }

    private void HandEditCompiledPlugin(string editorId = "EditedByHand")
    {
        var document = _index.DocumentOf(_compiledPluginNpc, _compiledPlugin.Key);
        _compiledPlugin.HandEdit(document, document.EditorId ?? "", editorId);
    }

    private void RewriteNonCompiledPlugin(string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(NonCompiledPlugin), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(_nonCompiledPlugin.Path);
    }

    [Fact]
    public void ACheck_ReindexesANonCompiledPluginBinaryRewrittenOutsideModbench_AndNamesThePlugin()
    {
        RewriteNonCompiledPlugin("WrittenByAnotherTool");

        CheckAnnouncing(PluginChanged(_nonCompiledPlugin));

        Assert.Contains(_index.ListedIn(_nonCompiledPlugin.Key), row => row.EditorId == "WrittenByAnotherTool");
    }

    [Fact]
    public void ACheck_RefreshesACompiledPluginDocumentEditedOutsideModbench_AndNamesTheRecord()
    {
        HandEditCompiledPlugin();

        CheckAnnouncing(RowsChanged(_compiledPluginNpc));

        Assert.Equal("EditedByHand", _index.DocumentOf(_compiledPluginNpc, _compiledPlugin.Key).EditorId);
    }

    [Fact]
    public void AReconcile_KeepsNoHashOfAFileTheLoadOrderNoLongerNames()
    {
        using (new FileStream(_nonCompiledPlugin.Path, FileMode.Open, FileAccess.Read, FileShare.None))
            Assert.NotNull(_disk.HashOf(_nonCompiledPlugin.Path));

        _index.Reconcile(_holder, _fixture.DataFolder, [_compiledPlugin], GameRelease.Fallout4, _fixture.InstanceRoot);

        using var held = new FileStream(_nonCompiledPlugin.Path, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.Null(_disk.HashOf(_nonCompiledPlugin.Path));
    }

    [Fact]
    public void ALoadOrderThatArrives_LeavesAPluginItKeepsAsLastRead_UntilACheck()
    {
        RewriteNonCompiledPlugin("WrittenByAnotherTool");

        _index.Reconcile(_holder, _fixture.DataFolder, [_nonCompiledPlugin], GameRelease.Fallout4, _fixture.InstanceRoot);
        Assert.Contains(_index.ListedIn(_nonCompiledPlugin.Key), row => row.EditorId == "NonCompiledPluginNpc");

        CheckAnnouncing(PluginChanged(_nonCompiledPlugin));
        Assert.Contains(_index.ListedIn(_nonCompiledPlugin.Key), row => row.EditorId == "WrittenByAnotherTool");
    }

    [Fact]
    public void ATreeEditedWhileMEditWasClosed_IsReadByTheFirstLoadOrder()
    {
        HandEditCompiledPlugin();
        _index.Dispose();

        var holder = new LoadOrderHolder();
        using var reopened = Indexes.Open(holder);
        reopened.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal("EditedByHand", reopened.DocumentOf(_compiledPluginNpc, _compiledPlugin.Key).EditorId);
    }

    [Fact]
    public void ACheck_TakesTheRowsOfANonCompiledPluginBinaryTheAdapterSaysIsGone()
    {
        _disk.Gone(_nonCompiledPlugin.Path);

        CheckAnnouncing(PluginChanged(_nonCompiledPlugin));

        Assert.Empty(_index.ListedIn(_nonCompiledPlugin.Key));
    }

    [Fact]
    public void ACheck_ReindexesANonCompiledPluginBinaryTheAdapterSaysChanged()
    {
        _disk.Changed(_nonCompiledPlugin.Path);

        CheckAnnouncing(PluginChanged(_nonCompiledPlugin));

        Assert.Contains(_index.ListedIn(_nonCompiledPlugin.Key), row => row.EditorId == "NonCompiledPluginNpc");
    }

    [Fact]
    public void ACheck_TakesEveryRowOfAPluginWhoseRepositoryAndBinaryWent()
    {
        HandEditCompiledPlugin();
        CheckAnnouncing(RowsChanged(_compiledPluginNpc));

        AnotherTool.Delete(Path.Combine(_compiledPlugin.ModFolderOf(), ".git"));
        File.Delete(_compiledPlugin.Path);
        CheckAnnouncing(PluginChanged(_compiledPlugin));

        Assert.Empty(_index.ListedIn(_compiledPlugin.Key));
    }

    [Fact]
    public void ACheck_ReindexesANonCompiledPluginBinaryThatCameBack()
    {
        var bytes = File.ReadAllBytes(_nonCompiledPlugin.Path);
        File.Delete(_nonCompiledPlugin.Path);
        CheckAnnouncing(PluginChanged(_nonCompiledPlugin));
        Assert.Empty(_index.ListedIn(_nonCompiledPlugin.Key));

        File.WriteAllBytes(_nonCompiledPlugin.Path, bytes);
        CheckAnnouncing(PluginChanged(_nonCompiledPlugin));

        Assert.Contains(_index.ListedIn(_nonCompiledPlugin.Key), row => row.EditorId == "NonCompiledPluginNpc");
    }

    [Fact]
    public void ACheck_OfABinaryWhoseStampHolds_ReadsNothing()
    {
        using var held = new FileStream(_nonCompiledPlugin.Path, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.IsType<PluginFailure.Inaccessible>(_disk.ClaimOf(_nonCompiledPlugin.Path, GameRelease.Fallout4).Failure());

        var announced = _index.AnnouncedByChecks(_notifications, () => _compiledPlugin.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
        Assert.Empty(_index.Status.Failures);
    }

    [Fact]
    public void ACheck_OfAPluginHeldWithAFailure_PublishesNothingWhileItsBytesStayTheSame()
    {
        File.WriteAllText(_nonCompiledPlugin.Path, "not a plugin");
        CheckAnnouncing(FailureNamed(NonCompiledPlugin));

        var announced = _index.AnnouncedByChecks(_notifications, () => _compiledPlugin.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
    }

    [Fact]
    public void ACheck_OfAPluginWithNoTreeInASourceMod_PublishesNothing()
    {
        var loosePath = Path.Combine(_compiledPlugin.ModFolderOf(), "Loose.esp");
        var loose = new Fallout4Mod(ModKey.FromFileName("Loose.esp"), Fallout4Release.Fallout4);
        loose.Npcs.AddNew("LooseNpc");
        loose.WriteToBinary(loosePath);
        LoadOrderEntry[] plugins = [.. _fixture.Plugins, new("Loose.esp", loosePath, _compiledPlugin.Origin, 2, Enabled: true, Winning: true)];
        _index.Reconcile(_holder, _fixture.DataFolder, plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        Assert.Contains(
            _index.ListedIn(new PluginAddress("Loose.esp", _compiledPlugin.Origin)), row => row.EditorId == "LooseNpc");

        var announced = _index.AnnouncedByChecks(_notifications, () => _compiledPlugin.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
    }

    [Fact]
    public void ACheck_OfATreeThatFailedToRead_AndStandsUnchanged_ReadsNothingOfIt()
    {
        var document = _compiledPlugin.SourceFileOf(_index.DocumentOf(_compiledPluginNpc, _compiledPlugin.Key));
        File.Copy(document, Path.Combine(Path.GetDirectoryName(document).Require(), "Backup.json"));
        CheckAnnouncing(PluginChanged(_compiledPlugin));
        Assert.True(_index.ReadFromItsPluginFileForItsUnreadableSource(_compiledPlugin.Key));

        var announced = _index.AnnouncedByChecks(_notifications, () => Touched(_nonCompiledPlugin));

        Assert.All(announced, n => Assert.IsType<PluginChangedNotification>(n));
        Assert.DoesNotContain(announced, PluginChanged(_compiledPlugin));
        Assert.True(_index.ReadFromItsPluginFileForItsUnreadableSource(_compiledPlugin.Key));
    }

    [Fact]
    public void ACheck_ReadsABinaryThatFailedAgain_OnceItsBytesChange()
    {
        File.WriteAllText(_nonCompiledPlugin.Path, "not a plugin");
        CheckAnnouncing(FailureNamed(NonCompiledPlugin));

        RewriteNonCompiledPlugin("FixedByAnotherTool");
        CheckAnnouncing(PluginChanged(_nonCompiledPlugin));

        Assert.Contains(_index.ListedIn(_nonCompiledPlugin.Key), row => row.EditorId == "FixedByAnotherTool");
        Assert.DoesNotContain(_index.Status.Failures, f => f.Name == NonCompiledPlugin);
    }

    [Fact]
    public void ACheck_ReadsAPluginWhoseModGainedARepository_FromItsTree()
    {
        SourceMods.Init(_nonCompiledPlugin);

        _index.NextCheckUntil(
            () => _index.ReadFromItsPluginSource(_nonCompiledPlugin.Key), "the check's re-derivation of the plugin from its tree");
    }

    [Fact]
    public void ASnapshotThatFirstNamesAPluginsSourceFolder_ReadsThePluginFromItsTree()
    {
        var folder = _nonCompiledPlugin.ModFolderOf();
        IReadOnlyList<LoadOrderEntry> NamingSourceFolder(string? sourceFolder) =>
        [
            .. _fixture.Plugins.Select(p => p == _nonCompiledPlugin
                ? p with { NamedProvider = new PluginProvider.FromMod(p.Origin, folder, sourceFolder) }
                : p),
        ];
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);
        index.Reconcile(holder, _fixture.DataFolder, NamingSourceFolder(null), GameRelease.Fallout4);
        SourceMods.Init(_nonCompiledPlugin);

        index.Reconcile(holder, _fixture.DataFolder, NamingSourceFolder(folder), GameRelease.Fallout4);

        Assert.True(index.ReadFromItsPluginSource(_nonCompiledPlugin.Key));
    }
}
