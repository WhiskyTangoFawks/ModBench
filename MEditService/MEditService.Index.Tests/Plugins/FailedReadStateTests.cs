using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
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
    private (TreeMoment When, Action Act)? _armed;
    private int _treeReads;
    private readonly HookedSource _source;

    public FailedReadStateTests() => _source = new HookedSource(FireIfArmed);

    public void Dispose() => _fixture.Dispose();

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private OpenedIndex Reconciled(IPluginAdapter? adapter = null) =>
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter, source: _source);

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

    private void Arm(TreeMoment when, Action act) => _armed = (when, act);

    private void FireIfArmed(TreeMoment moment, PluginAddress plugin)
    {
        if (!PluginAddress.Comparer.Equals(plugin, Plugin.KeyOf())) return;
        if (moment == TreeMoment.ReadBegins) Interlocked.Increment(ref _treeReads);
        if (_armed is not { } armed || armed.When != moment) return;
        _armed = null;
        armed.Act();
    }

    private int TreeReads() => Volatile.Read(ref _treeReads);

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
        Arm(TreeMoment.ReadEnds, Mend);

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
        Arm(TreeMoment.ReadEnds, Mend);
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
        Arm(TreeMoment.StampsTaken, () => File.WriteAllText(StrayDocument, "{}"));
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
        Arm(TreeMoment.ReadBegins, () =>
        {
            var hold = File.Open(document, FileMode.Open, FileAccess.Read, FileShare.None);
            Arm(TreeMoment.ReadEnds, hold.Dispose);
        });

        using var index = Reconciled();

        Assert.Equal(2, TreeReads());
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

        Arm(TreeMoment.RecordRead, () => throw new TimeoutException("the tree could not be compared"));

        using var index = Reconciled();

        Assert.Null(_armed);
        Assert.False(Failed(index));
        Assert.Contains(index.ListedIn(Plugin.KeyOf()), row => row.EditorId == "EditedNpc");
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

    private enum TreeMoment { StampsTaken, ReadBegins, ReadEnds, RecordRead }

    private sealed class HookedSource(Action<TreeMoment, PluginAddress> at) : ISourceAdapter
    {
        private readonly GitSourceAdapter _inner = new();

        public bool SourceReads(RegisteredPlugin plugin) => _inner.SourceReads(plugin);

        public bool IsTracked(RegisteredPlugin plugin) => _inner.IsTracked(plugin);

        public ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
            _inner.Over(plugin, release) is { } reads ? new HookedRepository(reads, at) : null;

        public RecordOfFileAnswer RecordOfFile(LoadOrderSnapshot loadOrder, string path) => _inner.RecordOfFile(loadOrder, path);

        public string FileNameOf(RecordIdentity identity) => _inner.FileNameOf(identity);
    }

    private sealed class HookedRepository(ISourceRepositoryReads inner, Action<TreeMoment, PluginAddress> at) : ISourceRepositoryReads
    {
        public RecordStamps StampsOf(PluginAddress plugin)
        {
            var stamps = inner.StampsOf(plugin);
            at(TreeMoment.StampsTaken, plugin);
            return stamps;
        }

        public IPluginDocuments OpenDocuments(PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas)
        {
            at(TreeMoment.ReadBegins, plugin);
            return new ReleasedDocuments(inner.OpenDocuments(plugin, schemas), () => at(TreeMoment.ReadEnds, plugin));
        }

        public SourceDocument? RecordOf(PluginAddress plugin, RecordIdentity identity)
        {
            at(TreeMoment.RecordRead, plugin);
            return inner.RecordOf(plugin, identity);
        }

        public IReadOnlyDictionary<string, RecordChange> ChangedSinceLastCommit(
            PluginAddress plugin, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
            inner.ChangedSinceLastCommit(plugin, schemas);

        public void RefuseUnreadable(
            PluginAddress plugin, RecordIdentity identity, string body, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
            inner.RefuseUnreadable(plugin, identity, body, schemas);

        public SourceDocument? RecordFromText(
            PluginAddress plugin, string formKey, string text, IReadOnlyDictionary<string, RecordTableSchema> schemas) =>
            inner.RecordFromText(plugin, formKey, text, schemas);

        public DocumentFile? DocumentOf(PluginAddress plugin, RecordIdentity identity) => inner.DocumentOf(plugin, identity);

        public string? RelativePathOf(PluginAddress plugin, RecordIdentity identity) => inner.RelativePathOf(plugin, identity);

        public string? FileNameOf(PluginAddress plugin, RecordIdentity identity) => inner.FileNameOf(plugin, identity);
    }

    private sealed class ReleasedDocuments(IPluginDocuments inner, Action released) : IPluginDocuments
    {
        public PluginDocument Header => inner.Header;

        public IEnumerable<PluginDocument> Records => inner.Records;

        public IReadOnlyList<RecordTypeFailure> Failures => inner.Failures;

        public void Dispose()
        {
            inner.Dispose();
            released();
        }
    }
}
