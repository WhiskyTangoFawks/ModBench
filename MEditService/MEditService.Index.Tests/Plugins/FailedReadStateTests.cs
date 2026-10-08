using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Ports;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Plugins;

public sealed class FailedReadStateTests : IDisposable
{
    private const string PluginName = "Plain.esp";
    private const string NpcEditorId = "PlainNpc";

    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("failed-read-state")
        .WithPlugin(PluginName, mod => mod.Npcs.AddNew(NpcEditorId), origin: "PlainMod")
        .BuildScattered();
    private readonly List<LogEntry> _log = [];
    private (Func<LogEntry, bool> When, Action Act)? _armed;
    private readonly ILoggerFactory _loggerFactory;

    public FailedReadStateTests() =>
        _loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log, FireIfArmed)));

    public void Dispose()
    {
        _loggerFactory.Dispose();
        _fixture.Dispose();
    }

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private OpenedIndex Reconciled(IPluginAdapter? adapter = null) =>
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter, _loggerFactory);

    private RecordSummary TheNpc(OpenedIndex index) =>
        index.ListedIn(Plugin.KeyOf()).Single(row => row.EditorId == NpcEditorId);

    private string NpcDocument => Directory.EnumerateFiles(Plugin.ModFolderOf(), "*.json", SearchOption.AllDirectories)
        .Single(file => File.ReadAllText(file).Contains($"\"{NpcEditorId}\"", StringComparison.Ordinal));

    private string StrayDocument => Path.Combine(Path.GetDirectoryName(NpcDocument).Require(), "Stray.json");

    private void ClaimedTwice()
    {
        var document = NpcDocument;
        var backup = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "Backup")).FullName;
        File.Copy(document, Path.Combine(backup, Path.GetFileName(document)));
    }

    private void Mend()
    {
        foreach (var backup in Directory.EnumerateDirectories(Plugin.ModFolderOf(), "Backup", SearchOption.AllDirectories).ToList())
            Directory.Delete(backup, recursive: true);
    }

    private void Arm(Func<LogEntry, bool> when, Action act) => _armed = (when, act);

    private void ArmOn(string logged, Action act) => Arm(e => e.Message.StartsWith(logged, StringComparison.Ordinal), act);

    private void FireIfArmed(LogEntry entry)
    {
        if (_armed is not { } armed || !armed.When(entry)) return;
        _armed = null;
        armed.Act();
    }

    private int TreeReads()
    {
        lock (_log) return _log.Count(e => e.Message == $"Ingesting {PluginName} from its source tree");
    }

    private static bool Failed(OpenedIndex index) => index.Status.Failures.Any(f => f.Name == PluginName);

    private bool ReadFromSource(OpenedIndex index) => index.ReadFromItsPluginSource(Plugin.KeyOf());

    private bool SourceUnreadable(OpenedIndex index) => index.ReadFromItsPluginFileForItsUnreadableSource(Plugin.KeyOf());

    private static string Reason(OpenedIndex index) => index.Status.Failures.Single(f => f.Name == PluginName).Reason;

    private string Relative(string path) => Path.GetRelativePath(Plugin.ModFolderOf(), path);

    [Fact]
    public void ATreeWithADocumentDeclaringNoFormKey_NamesThatFile_WhileItsBinaryStandsIn()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        File.WriteAllText(StrayDocument, "{}");

        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(StrayDocument), (string?)null), (failure.SourceRelativePath, failure.FormKey));
        Assert.Contains("declares no FormKey", failure.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void ATreeWhoseFormKeyTwoDocumentsClaim_NamesEachOfThem_WithTheFormKey()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        var formKey = TheNpc(index).FormKey;
        var original = NpcDocument;
        ClaimedTwice();

        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");

        var copy = Path.Combine(Path.GetDirectoryName(original).Require(), "Backup", Path.GetFileName(original));
        Assert.Equivalent(
            new[] { (Relative(original), formKey), (Relative(copy), formKey) },
            index.SourceProblems().Select(f => (f.SourceRelativePath, f.FormKey)), strict: true);
        Assert.All(index.SourceProblems(), f => Assert.Contains(Relative(copy), f.Message, StringComparison.Ordinal));
    }

    [Fact]
    public void ATreeWhoseFormKeyTwoDocumentsClaimWhenFirstRead_NamesEachOfThem_WhileItsBinaryStandsIn()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        var original = NpcDocument;
        ClaimedTwice();

        using var index = Reconciled();

        var copy = Path.Combine(Path.GetDirectoryName(original).Require(), "Backup", Path.GetFileName(original));
        Assert.Equivalent(new[] { Relative(original), Relative(copy) }, index.SourceProblems().Select(f => f.SourceRelativePath), strict: true);
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.True(SourceUnreadable(index));
    }

    [Fact]
    public void ATreeMended_NamesNoFile()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        ClaimedTwice();
        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");
        Mend();

        index.NextSnapshotUntil(() => ReadFromSource(index), "the mended tree read again");

        Assert.Empty(index.SourceProblems());
    }

    [Fact]
    public void ABinaryRewrittenDuringAFailedRead_IsReadAgain()
    {
        var adapter = new FailsToOpen(new InvalidOperationException("injected read failure"), atOpen: n => n == 1, () =>
            PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenAfterTheFailure")));

        using var index = Reconciled(adapter);

        Assert.False(Failed(index));
        Assert.Contains(index.ListedIn(Plugin.KeyOf()), row => row.EditorId == "WrittenAfterTheFailure");
    }

    [Fact]
    public void ATreeThatFailsWhenItsModGainsARepository_LeavesTheBinaryServing_MarkedAsSuch()
    {
        using var index = Reconciled();
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();

        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.False(Failed(index));
    }

    [Fact]
    public void ATreeThatStillFailsAfterAChange_LeavesItsBinaryStandingIn()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();
        using var index = Reconciled();
        var readsBefore = TreeReads();
        Mend();
        File.WriteAllText(StrayDocument, "{}");

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the changed tree read again");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.True(SourceUnreadable(index));
    }

    [Fact]
    public void ATreeThatStillFailsAfterAChange_WithNothingServing_SaysOnlyThatItFailed()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();
        using var index = Reconciled(new FailsToOpen(new InvalidOperationException("injected read failure"), atOpen: _ => true));
        Assert.True(Failed(index));
        var readsBefore = TreeReads();
        Mend();
        File.WriteAllText(StrayDocument, "{}");

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the changed tree read again");

        Assert.Empty(index.ListedIn(Plugin.KeyOf()));
        Assert.DoesNotContain("showing", Reason(index), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ATreeMendedWhileItsBinaryStoodInForIt_IsReadAgain()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();
        ArmOn($"Could not ingest {PluginName} from its source tree", Mend);

        using var index = Reconciled();

        Assert.Null(_armed);
        Assert.False(Failed(index));
        Assert.True(ReadFromSource(index));
    }

    [Fact]
    public void ATreeMendedDuringTheReadItFailedOnceRead_IsReadAgainAtTheNextSnapshot()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        ClaimedTwice();
        ArmOn($"Could not ingest {PluginName} from its source tree", Mend);
        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");
        Assert.Null(_armed);

        index.NextSnapshotUntil(() => ReadFromSource(index), "the mended tree read again");
    }

    private string GitIndex => Path.Combine(Plugin.ModFolderOf(), ".git", "index");

    private OpenedIndex ATreeWhoseStatusGitCannotReport_OnceARecordChanges()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        var index = Reconciled();
        var npc = NpcDocument;
        File.Copy(GitIndex, GitIndex + ".good");
        File.WriteAllText(GitIndex, "not an index");
        File.WriteAllText(npc, File.ReadAllText(npc).Replace(NpcEditorId, "RenamedNpc", StringComparison.Ordinal));
        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");
        return index;
    }

    [Fact]
    public void ATreeWhoseStatusGitCannotReport_WhenARecordChanges_ReadsThePluginFile_MarkedAsSuch_AtThisSnapshotAndTheNext()
    {
        using var index = ATreeWhoseStatusGitCannotReport_OnceARecordChanges();
        Assert.False(Failed(index));
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        var readsBefore = TreeReads();

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the tree read again");

        Assert.True(SourceUnreadable(index));
        Assert.False(Failed(index));
    }

    [Fact]
    public void ATreeWhoseGitIsRepairedOutsideModbench_IsReadFromItsTree_AtTheNextSnapshot()
    {
        using var index = ATreeWhoseStatusGitCannotReport_OnceARecordChanges();

        File.Move(GitIndex + ".good", GitIndex, overwrite: true);

        index.NextSnapshotUntil(() => ReadFromSource(index), "the tree read again");
        Assert.Contains(index.ListedIn(Plugin.KeyOf()), row => row.EditorId == "RenamedNpc");
    }

    [Fact]
    public void ATreeWithAnUnreadableDocument_IsReadAgainAtEverySnapshot()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        File.WriteAllText(StrayDocument, "{}");
        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");

        for (var snapshot = 1; snapshot <= 3; snapshot++)
        {
            var readsBefore = TreeReads();
            index.NextSnapshotUntil(() => TreeReads() > readsBefore, $"the tree read again at snapshot {snapshot}");
        }
    }

    [Fact]
    public void ATreeReadAgainAtEverySnapshot_ReadsTheBinaryInItsPlaceOncePerChangeOfItsBytes()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        File.WriteAllText(StrayDocument, "{}");
        using var adapter = new GatedPluginAdapter();
        using var index = Reconciled(adapter);
        Assert.True(SourceUnreadable(index));
        var binaryReads = adapter.OpenedTotal;

        for (var snapshot = 1; snapshot <= 2; snapshot++)
        {
            var readsBefore = TreeReads();
            index.NextSnapshotUntil(() => TreeReads() > readsBefore, $"the tree read again at snapshot {snapshot}");
        }

        Assert.Equal(binaryReads, adapter.OpenedTotal);
    }

    [Fact]
    public void ATreeUnreadableWhenItsWholeReadBegan_IsReadAgainOnceReadable()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        var untyped = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(NpcDocument)).Require(), "Untyped")).FullName;
        ArmOn($"Reconciling {PluginName}:", () => File.WriteAllText(StrayDocument, "{}"));
        File.WriteAllText(Path.Combine(untyped, "Gained.json"), $$"""{"FormKey":"000ABC:{{PluginName}}"}""");
        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");
        Assert.Null(_armed);
        File.Delete(StrayDocument);
        var readsBefore = TreeReads();

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the tree read again");
    }

    [Fact]
    public void ABinaryHeldByAnotherProcessWhenItIsReadAgain_IsReadAtTheNextSnapshot()
    {
        using var index = Reconciled(new FailsToOpen(new IOException("held by another process"), atOpen: n => n == 2));
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenBeforeTheHold"));
        index.NextSnapshotUntil(() => Failed(index), "the held read's failure");

        index.NextSnapshotUntil(() => !Failed(index), "the binary read again");

        Assert.Contains(index.ListedIn(Plugin.KeyOf()), row => row.EditorId == "WrittenBeforeTheHold");
    }

    [Fact]
    public void ABinaryHeldByAnotherProcessWhenItArrives_IsReadAgainWithItsBytesUnchanged()
    {
        var adapter = new FailsToOpen(new IOException("held by another process"), atOpen: n => n == 1);

        using var index = Reconciled(adapter);

        Assert.True(adapter.Threw);
        Assert.False(Failed(index));
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
    }

    [Fact]
    public void ATreeDocumentHeldOnlyWhileTheTreeIsRead_IsReadAgainWithItsBytesUnchanged()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        var document = NpcDocument;
        ArmOn($"Ingesting {PluginName} from its source tree", () =>
        {
            var hold = File.Open(document, FileMode.Open, FileAccess.Read, FileShare.None);
            Arm(e => e.Level == LogLevel.Warning, hold.Dispose);
        });

        using var index = Reconciled();

        Assert.Null(_armed);
        Assert.False(Failed(index));
        Assert.True(ReadFromSource(index));
    }

    [Fact]
    public void AJustTrackedTreeWhoseBinaryAlsoFails_SaysTheBinarysLastReadStillShows()
    {
        using var index = Reconciled(new FailsToOpen(new InvalidOperationException("injected read failure"), atOpen: n => n == 2));
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();

        index.NextSnapshotUntil(() => Failed(index), "the tree's and the binary's failure");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Still showing what was last read from its compiled binary", Reason(index), StringComparison.Ordinal);
    }

    [Fact]
    public void ABinaryRewrittenThatFailsToRead_SaysItsLastReadStillShows()
    {
        using var index = Reconciled(new FailsToOpen(new InvalidOperationException("injected read failure"), atOpen: n => n == 2));
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenByAnotherTool"));

        index.NextSnapshotUntil(() => Failed(index), "the rewritten binary's failure");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Still showing what was last read from its compiled binary", Reason(index), StringComparison.Ordinal);
    }

    [Fact]
    public void ABinaryHeldWhenAWarmLoadOpensIt_SaysItsLastReadStillShows()
    {
        Reconciled().Dispose();

        using var index = Reconciled(new HeldAtFirstRead());

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Still showing what was last read from its compiled binary", Reason(index), StringComparison.Ordinal);
    }

    [Fact]
    public void ABinaryThatHashesButIsHeldWhenItOpens_IsOpenedAtTheNextSnapshot()
    {
        using var index = Reconciled(new HeldAtFirstRead());
        Assert.True(Failed(index));

        index.NextSnapshotUntil(() => !Failed(index), "the binary opened again");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
    }

    [Fact]
    public void AWarmValidationThatThrows_ReadsThePluginWhole()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        Reconciled().Dispose();
        var document = NpcDocument;
        File.WriteAllText(document, File.ReadAllText(document).Replace($"\"{NpcEditorId}\"", "\"EditedNpc\"", StringComparison.Ordinal));

        using var index = Indexes.Reconciled(_fixture, _fixture.InstanceRoot, loggerFactory: _loggerFactory, notifications: new RowsChangedFaultsOnce());

        Assert.False(Failed(index));
        Assert.Contains(index.ListedIn(Plugin.KeyOf()), row => row.EditorId == "EditedNpc");
    }

    private sealed class RowsChangedFaultsOnce : INotificationPublisher
    {
        private int _faulted;

        public void Publish(INotification notification)
        {
            if (notification is RowsChangedNotification && Interlocked.Exchange(ref _faulted, 1) == 0)
                throw new TimeoutException("the stream could not take the push");
        }
    }

    private sealed class HeldAtFirstRead : DelegatingPluginAdapter
    {
        private int _read;

        public HeldAtFirstRead() : base(TestAdapters.Mutagen()) { }

        public override (PluginContent Content, Exception? Unreachable) ReadContent(
            ModPath modPath, GameRelease gameRelease, PluginStrings? strings = null) =>
            Interlocked.Increment(ref _read) == 1
                ? throw new IOException("held by another process")
                : base.ReadContent(modPath, gameRelease, strings);
    }

    private sealed class FailsToOpen(Exception failure, Func<int, bool> atOpen, Action? beforeFailing = null)
        : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private int _opened;

        public bool Threw { get; private set; }

        public override IPluginDocuments OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null)
        {
            if (!atOpen(Interlocked.Increment(ref _opened))) return base.OpenDocuments(modPath, gameRelease, schemas, strings);
            beforeFailing?.Invoke();
            Threw = true;
            throw failure;
        }
    }
}
