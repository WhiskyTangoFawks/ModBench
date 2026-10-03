using DuckDB.NET.Data;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Microsoft.Extensions.Time.Testing;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

/// <summary>ADR-0009 invariant 4: every reconcile validates every file, so a snapshot equal to the
/// one held still finds what changed on disk since, and one that finds nothing publishes
/// nothing.</summary>
public sealed class EveryReconcileValidatesTests : IDisposable
{
    private const string Untracked = "Untracked.esp";
    private const string Tracked = "Tracked.esp";

    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _untracked;
    private readonly LoadOrderEntry _tracked;
    private readonly string _trackedNpc;
    private readonly LoadOrderHolder _holder = new();
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly Indexer _index;

    public EveryReconcileValidatesTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("every-reconcile-validates")
            .WithPlugin(Untracked, mod => mod.Npcs.AddNew("UntrackedNpc"), origin: "UntrackedMod")
            .WithPlugin(Tracked, mod => npc = mod.Npcs.AddNew("TrackedNpc").FormKey, origin: "TrackedMod")
            .BuildScattered();
        _untracked = _fixture.Plugins.Single(p => p.Name == Untracked);
        _tracked = _fixture.Plugins.Single(p => p.Name == Tracked);
        _trackedNpc = npc.ToString();
        TrackedMods.Track(_tracked, _fixture.GameDirectory);
        // Past every write the fixture makes, so a stamp the store takes is one it may keep.
        var clock = new FakeTimeProvider(TimeProvider.System.GetUtcNow() + TimeSpan.FromHours(1));
        _index = new Indexer(
            _holder, TestAdapters.Mutagen(), SharedSchemaReflector.Instance,
            notifications: _notifications, timeProvider: clock);
        Reconcile();
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private void Reconcile() =>
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Plugins, GameRelease.Fallout4, _fixture.InstanceRoot);

    private IReadOnlyList<Notification> PublishedDuring(Action act)
    {
        var before = _notifications.Notifications.Count;
        act();
        return [.. _notifications.Notifications.Skip(before)];
    }

    private void RewriteUntracked(string editorId)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Untracked), Fallout4Release.Fallout4);
        mod.Npcs.AddNew(editorId);
        mod.WriteToBinary(_untracked.Path);
    }

    [Fact]
    public void AnEqualSnapshot_ReindexesAnUntrackedBinaryRewrittenOutsideModbench_AndNamesThePlugin()
    {
        RewriteUntracked("WrittenByAnotherTool");

        var published = PublishedDuring(Reconcile);

        Assert.Contains(_index.RequireReads().GetDocuments(_untracked.KeyOf()), d => d.EditorId == "WrittenByAnotherTool");
        Assert.Contains(published, n => n is PluginChangedNotification changed
            && PluginAddress.Comparer.Equals(changed.Plugin, _untracked.KeyOf()));
    }

    [Fact]
    public void AnEqualSnapshot_RefreshesATrackedDocumentEditedOutsideModbench_AndNamesTheRecord()
    {
        var document = _index.RequireReads().DocumentOf(_trackedNpc, _tracked.KeyOf());
        _tracked.HandEdit(document, "TrackedNpc", "EditedByHand");

        var published = PublishedDuring(Reconcile);

        Assert.Equal("EditedByHand", _index.RequireReads().DocumentOf(_trackedNpc, _tracked.KeyOf()).EditorId);
        Assert.Contains(published, n => n is RowsChangedNotification rows && rows.Keys.Contains(_trackedNpc));
    }

    [Fact]
    public void AnEqualSnapshot_TakesTheRowsOfAnUntrackedBinaryGoneFromDisk_AndNamesThePlugin()
    {
        File.Delete(_untracked.Path);

        var published = PublishedDuring(Reconcile);

        Assert.Empty(_index.RequireReads().GetDocuments(_untracked.KeyOf()));
        Assert.Contains(published, n => n is PluginChangedNotification changed
            && PluginAddress.Comparer.Equals(changed.Plugin, _untracked.KeyOf()));
    }

    // A tracked mod whose repository and binary both went: its rows at HEAD go with the rest, the
    // committed state of a dirty record included.
    [Fact]
    public void AnEqualSnapshot_TakesEveryRowOfAPluginWhoseRepositoryAndBinaryWent_ItsDirtyRecordsHeadRowsToo()
    {
        var document = _index.RequireReads().DocumentOf(_trackedNpc, _tracked.KeyOf());
        _tracked.HandEdit(document, "TrackedNpc", "EditedByHand");
        Reconcile();
        Assert.NotEqual(0, CommittedRowsOf(_tracked));

        Directory.Delete(Path.Combine(_tracked.ModFolderOf(), ".git"), recursive: true);
        File.Delete(_tracked.Path);
        Reconcile();

        Assert.Equal(0, CommittedRowsOf(_tracked));
        Assert.Empty(_index.RequireReads().GetDocuments(_tracked.KeyOf()));
    }

    // Read off the store itself: every read through the Index answers only for a registered plugin,
    // and an unindexed one is unregistered.
    private long CommittedRowsOf(LoadOrderEntry plugin)
    {
        using var connection = new DuckDBConnection($"Data Source={IndexFiles.In(_fixture.InstanceRoot)}");
        connection.Open();
        using var cmd = connection.CreateCommand();
        cmd.CommandText = "SELECT count(*) FROM mirror.records_committed WHERE plugin = $1 AND origin = $2";
        cmd.Parameters.Add(new DuckDBParameter(plugin.Name));
        cmd.Parameters.Add(new DuckDBParameter(plugin.Origin));
        return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    [Fact]
    public void AnEqualSnapshot_ReindexesAnUntrackedBinaryThatCameBack()
    {
        var bytes = File.ReadAllBytes(_untracked.Path);
        File.Delete(_untracked.Path);
        Reconcile();
        Assert.Empty(_index.RequireReads().GetDocuments(_untracked.KeyOf()));

        File.WriteAllBytes(_untracked.Path, bytes);
        Reconcile();

        Assert.Contains(_index.RequireReads().GetDocuments(_untracked.KeyOf()), d => d.EditorId == "UntrackedNpc");
    }

    // A handle that denies sharing makes a read fail, so a clean answer while it is open came from
    // the hash the stamp kept.
    [Fact]
    public void AnEqualSnapshot_OfABinaryWhoseStampHolds_ReadsNothing()
    {
        Reconcile();

        using var held = new FileStream(_untracked.Path, FileMode.Open, FileAccess.Read, FileShare.None);
        Assert.Null(PluginBinaryHash.OfFile(_untracked.Path));

        Assert.Empty(PublishedDuring(Reconcile));
        Assert.Empty(_index.Status.Failures);
    }

    // Held with a failure, the plugin is read again only once its bytes change: a re-read of bytes
    // that failed before would publish on every snapshot that merely names it.
    [Fact]
    public void AnEqualSnapshot_ThatFindsNothingChanged_PublishesNothing()
    {
        File.WriteAllText(_untracked.Path, "not a plugin");
        Reconcile();
        Reconcile();

        Assert.Empty(PublishedDuring(Reconcile));
    }

    // A tracked mod holds a tree per plugin, and may hold none for one: that plugin reads from its
    // binary, and validates against it.
    [Fact]
    public void AnEqualSnapshot_OfAPluginWithNoTreeInATrackedMod_PublishesNothing()
    {
        var loosePath = Path.Combine(_tracked.ModFolderOf(), "Loose.esp");
        var loose = new Fallout4Mod(ModKey.FromFileName("Loose.esp"), Fallout4Release.Fallout4);
        loose.Npcs.AddNew("LooseNpc");
        loose.WriteToBinary(loosePath);
        LoadOrderEntry[] plugins = [.. _fixture.Plugins, new("Loose.esp", loosePath, _tracked.Origin, 2, Enabled: true, Winning: true)];
        void ReconcileWithLoose() =>
            _index.Reconcile(_holder, _fixture.GameDirectory, plugins, GameRelease.Fallout4, _fixture.InstanceRoot);
        ReconcileWithLoose();
        Assert.Contains(
            _index.RequireReads().GetDocuments(new PluginAddress("Loose.esp", _tracked.Origin)), d => d.EditorId == "LooseNpc");

        Assert.Empty(PublishedDuring(ReconcileWithLoose));
    }

    // Git's status is the tree's stamp (ADR-0009): a tree that failed to read is asked again through
    // the files git names, and a file it does not name is never opened. One held shut proves it.
    [Fact]
    public void AnEqualSnapshot_OfATreeThatFailedToRead_OpensNoFileGitDoesNotName()
    {
        var document = _tracked.SourceFileOf(_index.RequireReads().DocumentOf(_trackedNpc, _tracked.KeyOf()));
        File.Copy(document, Path.Combine(Path.GetDirectoryName(document).Require(), "Backup.json"));
        Reconcile();
        Assert.Contains(_index.Status.Failures, f => f.Name == Tracked);
        var header = Path.Combine(SourceRepository.RootIn(_tracked.ModFolderOf(), Tracked), "RecordData.json");

        using var heldShut = new FileStream(header, FileMode.Open, FileAccess.Read, FileShare.None);
        var published = PublishedDuring(Reconcile);

        Assert.Empty(published);
        Assert.Contains(_index.Status.Failures, f => f.Name == Tracked);
    }

    [Fact]
    public void AnEqualSnapshot_ReadsABinaryThatFailedAgain_OnceItsBytesChange()
    {
        File.WriteAllText(_untracked.Path, "not a plugin");
        Reconcile();

        RewriteUntracked("FixedByAnotherTool");
        Reconcile();

        Assert.Contains(_index.RequireReads().GetDocuments(_untracked.KeyOf()), d => d.EditorId == "FixedByAnotherTool");
        Assert.DoesNotContain(_index.Status.Failures, f => f.Name == Untracked);
    }

    // plugins.md, States, story 6: the next change to the instance tries a failed index again, and a
    // change that moves no plugin arrives as the same snapshot.
    [Fact]
    public async Task Subscribed_AnEqualSnapshotArriving_TriesAFailedReconcileAgain()
    {
        var blocker = Path.GetDirectoryName(IndexFiles.In(_fixture.InstanceRoot))
            ?? throw new InvalidOperationException("The index file sits in a folder.");
        _index.Dispose();
        Directory.Delete(blocker, recursive: true);
        File.WriteAllText(blocker, "not a folder");
        var holder = new LoadOrderHolder();
        using var failing = Indexes.Open(holder);
        failing.Subscribe();
        holder.Apply(_holder.Current);
        Assert.True(await Waits.Until(() => failing.Status.State == LoadOrderState.Failed), "the first arrival never failed");

        File.Delete(blocker);
        holder.Apply(_holder.Current);

        Assert.True(await Waits.Until(() => failing.Status.State == LoadOrderState.Ready), "the equal arrival never retried");
        Assert.NotEmpty(failing.RequireReads().GetDocuments(_untracked.KeyOf()));
    }

    // ADR-0007 invariant 3: a mod gaining a repository moves which truth answers for its plugin,
    // and nothing in the load order moves with it.
    [Fact]
    public async Task Subscribed_AnEqualSnapshotArriving_ReadsAPluginWhoseModGainedARepository_FromItsTree()
    {
        _index.Subscribe();
        TrackedMods.Track(_untracked, _fixture.GameDirectory);

        _holder.Apply(_holder.Current);

        Assert.True(
            await Waits.Until(() => _index.RequireReads().GetTrackedPlugins().Contains(_untracked.KeyOf())),
            "the arrival never re-derived the plugin from its tree");
    }

    [Fact]
    public async Task Subscribed_AnEqualSnapshotArriving_FindsWhatChangedOnDisk()
    {
        _index.Subscribe();
        RewriteUntracked("SeenAtTheNextArrival");

        _holder.Apply(_holder.Current);

        Assert.True(
            await Waits.Until(() => _notifications.Notifications.OfType<PluginChangedNotification>()
                .Any(n => PluginAddress.Comparer.Equals(n.Plugin, _untracked.KeyOf()))),
            "the arrival never validated the plugin");
        Assert.Contains(_index.RequireReads().GetDocuments(_untracked.KeyOf()), d => d.EditorId == "SeenAtTheNextArrival");
    }
}
