using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using static MEditService.Index.Tests.TestSupport.Announcements;

namespace MEditService.Index.Tests.Plugins;

public sealed class EveryReconcileValidatesTests : IDisposable
{

    private const string NonSourcePlugin = "NonSourcePlugin.esp";
    private const string SourcePlugin = "SourcePlugin.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _nonSourcePlugin;
    private readonly LoadOrderEntry _sourcePlugin;
    private readonly string _sourcePluginNpc;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly DiskSaysAdapter _disk;
    private readonly OpenedIndex _index;

    public EveryReconcileValidatesTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("every-reconcile-validates")
            .WithPlugin(NonSourcePlugin, mod => mod.Npcs.AddNew("NonSourcePluginNpc"), origin: "NonSourceMod")
            .WithPlugin(SourcePlugin, mod => npc = mod.Npcs.AddNew("SourcePluginNpc").FormKey, origin: "SourceMod")
            .BuildScattered();
        _nonSourcePlugin = _fixture.Plugins.Single(p => p.Name == NonSourcePlugin);
        _sourcePlugin = _fixture.Plugins.Single(p => p.Name == SourcePlugin);
        _sourcePluginNpc = npc.ToString();
        SourceMods.Track(_sourcePlugin);
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
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private void ArrivalAnnouncing(Predicate<INotification> announced)
    {
        var before = _notifications.Notifications.Count;
        _index.NextSnapshotUntil(() => _notifications.Since(before).Any(n => announced(n)), "the arrival's announcement");
    }

    private void HandEditSourcePlugin(string editorId = "EditedByHand")
    {
        var document = _index.DocumentOf(_sourcePluginNpc, _sourcePlugin.KeyOf());
        _sourcePlugin.HandEdit(document, document.EditorId ?? "", editorId);
    }

    private void RewriteNonSourcePlugin(string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(NonSourcePlugin), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(_nonSourcePlugin.Path);
    }

    [Fact]
    public void AnEqualSnapshot_ReindexesANonSourcePluginBinaryRewrittenOutsideModbench_AndNamesThePlugin()
    {
        RewriteNonSourcePlugin("WrittenByAnotherTool");

        ArrivalAnnouncing(PluginChanged(_nonSourcePlugin));

        Assert.Contains(_index.ListedIn(_nonSourcePlugin.KeyOf()), row => row.EditorId == "WrittenByAnotherTool");
    }

    [Fact]
    public void AnEqualSnapshot_RefreshesASourcePluginDocumentEditedOutsideModbench_AndNamesTheRecord()
    {
        HandEditSourcePlugin();

        ArrivalAnnouncing(RowsChanged(_sourcePluginNpc));

        Assert.Equal("EditedByHand", _index.DocumentOf(_sourcePluginNpc, _sourcePlugin.KeyOf()).EditorId);
    }

    [Fact]
    public void AnEqualSnapshot_TakesTheRowsOfANonSourcePluginBinaryGoneFromDisk_AndNamesThePlugin()
    {
        File.Delete(_nonSourcePlugin.Path);

        ArrivalAnnouncing(PluginChanged(_nonSourcePlugin));

        Assert.Empty(_index.ListedIn(_nonSourcePlugin.KeyOf()));
    }

    [Fact]
    public void AReconcile_KeepsNoHashOfAFileTheLoadOrderNoLongerNames()
    {
        using (new FileStream(_nonSourcePlugin.Path, FileMode.Open, FileAccess.Read, FileShare.None))
            Assert.NotNull(_disk.HashOf(_nonSourcePlugin.Path));

        _index.Reconcile(_holder, _fixture.GameDirectory, [_sourcePlugin], GameRelease.Fallout4, _fixture.InstanceRoot);

        using var held = new FileStream(_nonSourcePlugin.Path, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.Null(_disk.HashOf(_nonSourcePlugin.Path));
    }

    [Fact]
    public void AnEqualSnapshot_TakesTheRowsOfANonSourcePluginBinaryTheAdapterSaysIsGone()
    {
        _disk.Gone(_nonSourcePlugin.Path);

        ArrivalAnnouncing(PluginChanged(_nonSourcePlugin));

        Assert.Empty(_index.ListedIn(_nonSourcePlugin.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_ReindexesANonSourcePluginBinaryTheAdapterSaysChanged()
    {
        _disk.Changed(_nonSourcePlugin.Path);

        ArrivalAnnouncing(PluginChanged(_nonSourcePlugin));

        Assert.Contains(_index.ListedIn(_nonSourcePlugin.KeyOf()), row => row.EditorId == "NonSourcePluginNpc");
    }

    [Fact]
    public void AnEqualSnapshot_TakesEveryRowOfAPluginWhoseRepositoryAndBinaryWent()
    {
        HandEditSourcePlugin();
        ArrivalAnnouncing(RowsChanged(_sourcePluginNpc));

        AnotherTool.Delete(Path.Combine(_sourcePlugin.ModFolderOf(), ".git"));
        File.Delete(_sourcePlugin.Path);
        ArrivalAnnouncing(PluginChanged(_sourcePlugin));

        Assert.Empty(_index.ListedIn(_sourcePlugin.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_ReindexesANonSourcePluginBinaryThatCameBack()
    {
        var bytes = File.ReadAllBytes(_nonSourcePlugin.Path);
        File.Delete(_nonSourcePlugin.Path);
        ArrivalAnnouncing(PluginChanged(_nonSourcePlugin));
        Assert.Empty(_index.ListedIn(_nonSourcePlugin.KeyOf()));

        File.WriteAllBytes(_nonSourcePlugin.Path, bytes);
        ArrivalAnnouncing(PluginChanged(_nonSourcePlugin));

        Assert.Contains(_index.ListedIn(_nonSourcePlugin.KeyOf()), row => row.EditorId == "NonSourcePluginNpc");
    }

    [Fact]
    public void AnEqualSnapshot_OfABinaryWhoseStampHolds_ReadsNothing()
    {
        using var held = new FileStream(_nonSourcePlugin.Path, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.IsType<PluginFailure.Inaccessible>(_disk.ClaimOf(_nonSourcePlugin.Path, GameRelease.Fallout4).Failure());

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _sourcePlugin.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
        Assert.Empty(_index.Status.Failures);
    }

    [Fact]
    public void AnEqualSnapshot_OfAPluginHeldWithAFailure_PublishesNothingWhileItsBytesStayTheSame()
    {
        File.WriteAllText(_nonSourcePlugin.Path, "not a plugin");
        ArrivalAnnouncing(FailureNamed(NonSourcePlugin));

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _sourcePlugin.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
    }

    [Fact]
    public void AnEqualSnapshot_OfAPluginWithNoTreeInASourceMod_PublishesNothing()
    {
        var loosePath = Path.Combine(_sourcePlugin.ModFolderOf(), "Loose.esp");
        var loose = new Fallout4Mod(ModKey.FromFileName("Loose.esp"), Fallout4Release.Fallout4);
        loose.Npcs.AddNew("LooseNpc");
        loose.WriteToBinary(loosePath);
        LoadOrderEntry[] plugins = [.. _fixture.Plugins, new("Loose.esp", loosePath, _sourcePlugin.Origin, 2, Enabled: true, Winning: true)];
        _index.Reconcile(_holder, _fixture.GameDirectory, plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        Assert.Contains(
            _index.ListedIn(new PluginAddress("Loose.esp", _sourcePlugin.Origin)), row => row.EditorId == "LooseNpc");

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _sourcePlugin.RenamedByHand(_index));

        Assert.All(announced, n => Assert.IsType<RowsChangedNotification>(n));
    }

    [Fact]
    public void AnEqualSnapshot_OfATreeThatFailedToRead_AndStandsUnchanged_ReadsNothingOfIt()
    {
        var document = _sourcePlugin.SourceFileOf(_index.DocumentOf(_sourcePluginNpc, _sourcePlugin.KeyOf()));
        File.Copy(document, Path.Combine(Path.GetDirectoryName(document).Require(), "Backup.json"));
        ArrivalAnnouncing(PluginChanged(_sourcePlugin));
        Assert.True(_index.ReadFromItsPluginFileForItsUnreadableSource(_sourcePlugin.KeyOf()));

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => Touched(_nonSourcePlugin));

        Assert.All(announced, n => Assert.IsType<PluginChangedNotification>(n));
        Assert.DoesNotContain(announced, PluginChanged(_sourcePlugin));
        Assert.True(_index.ReadFromItsPluginFileForItsUnreadableSource(_sourcePlugin.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_ReadsABinaryThatFailedAgain_OnceItsBytesChange()
    {
        File.WriteAllText(_nonSourcePlugin.Path, "not a plugin");
        ArrivalAnnouncing(FailureNamed(NonSourcePlugin));

        RewriteNonSourcePlugin("FixedByAnotherTool");
        ArrivalAnnouncing(PluginChanged(_nonSourcePlugin));

        Assert.Contains(_index.ListedIn(_nonSourcePlugin.KeyOf()), row => row.EditorId == "FixedByAnotherTool");
        Assert.DoesNotContain(_index.Status.Failures, f => f.Name == NonSourcePlugin);
    }

    [Fact]
    public async Task AnEqualSnapshot_TriesAFailedReconcileAgain()
    {
        var blocker = Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot))
            ?? throw new InvalidOperationException("The index file sits in a folder.");
        _index.Dispose();
        Directory.Delete(blocker, recursive: true);
        File.WriteAllText(blocker, "not a folder");
        var holder = new LoadOrderHolder();
        using var failing = Indexes.Open(holder);
        holder.Apply(_holder.Current);
        Waits.Reached(() => failing.Status.State == LoadOrderState.Failed, "the first arrival's failure");

        File.Delete(blocker);
        failing.NextSnapshotUntil(() => failing.Status.State == LoadOrderState.Ready, "the equal arrival's retry");
        Assert.NotEmpty(failing.ListedIn(_nonSourcePlugin.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_ReadsAPluginWhoseModGainedARepository_FromItsTree()
    {
        SourceMods.Track(_nonSourcePlugin);

        _index.NextSnapshotUntil(
            () => _index.ReadFromItsPluginSource(_nonSourcePlugin.KeyOf()), "the arrival's re-derivation of the plugin from its tree");
    }
}
