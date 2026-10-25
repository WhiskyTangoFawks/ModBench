using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Plugins;

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
        index.ListedIn(Plugin.Key).Single(row => row.EditorId == NpcEditorId);

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
        if (!PluginAddress.Comparer.Equals(plugin, Plugin.Key)) return;
        if (moment == TreeMoment.ReadBegins) Interlocked.Increment(ref _treeReads);
        if (_armed is not { } armed || armed.When != moment) return;
        _armed = null;
        armed.Act();
    }

    private int TreeReads() => Volatile.Read(ref _treeReads);

    private static bool Failed(OpenedIndex index) => index.Status.Failures.Any(f => f.Name == PluginName);

    private bool ReadFromSource(OpenedIndex index) => index.ReadFromItsPluginSource(Plugin.Key);

    private bool SourceUnreadable(OpenedIndex index) => index.ReadFromItsPluginFileForItsUnreadableSource(Plugin.Key);

    private static string Reason(OpenedIndex index) => index.Status.Failures.Single(f => f.Name == PluginName).Reason;

    private string Relative(string path) => Path.GetRelativePath(Plugin.ModFolderOf(), path);

    [Fact]
    public void ATreeWithADocumentDeclaringNoFormKey_NamesThatFile_WhileItsBinaryStandsIn()
    {
        SourceMods.Init(Plugin);
        using var index = Reconciled();
        File.WriteAllText(StrayDocument, "{}");

        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");

        var failure = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(StrayDocument), (string?)null), (failure.SourceRelativePath, failure.FormKey));
        Assert.Contains("declares no FormKey", failure.Message, StringComparison.Ordinal);
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.False(Failed(index));
    }

    [Fact]
    public void ATreeWhoseFormKeyTwoDocumentsClaim_NamesEachOfThem_WithTheFormKey()
    {
        SourceMods.Init(Plugin);
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
        SourceMods.Init(Plugin);
        var original = NpcDocument;
        ClaimedTwice();

        using var index = Reconciled();

        var copy = Path.Combine(Path.GetDirectoryName(original).Require(), "Backup", Path.GetFileName(original));
        Assert.Equivalent(new[] { Relative(original), Relative(copy) }, index.SourceProblems().Select(f => f.SourceRelativePath), strict: true);
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.True(SourceUnreadable(index));
        Assert.False(Failed(index));
    }

    [Fact]
    public void ATreeMended_NamesNoFile()
    {
        SourceMods.Init(Plugin);
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
        var adapter = new FailsToOpen(PluginFailures.Unparsed(), atOpen: n => n == 1, () =>
            PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenAfterTheFailure")));

        using var index = Reconciled(adapter);

        Assert.False(Failed(index));
        Assert.Contains(index.ListedIn(Plugin.Key), row => row.EditorId == "WrittenAfterTheFailure");
    }

    [Fact]
    public void ATreeThatFailsWhenItsModGainsARepository_LeavesTheBinaryServing_MarkedAsSuch()
    {
        using var index = Reconciled();
        SourceMods.Init(Plugin);
        ClaimedTwice();

        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.False(Failed(index));
    }

    [Fact]
    public void ATreeThatStillFailsAfterAChange_LeavesItsBinaryStandingIn()
    {
        SourceMods.Init(Plugin);
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
        SourceMods.Init(Plugin);
        ClaimedTwice();
        using var index = Reconciled(new FailsToOpen(PluginFailures.Unparsed(), atOpen: _ => true));
        Assert.True(Failed(index));
        var readsBefore = TreeReads();
        Mend();
        File.WriteAllText(StrayDocument, "{}");

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the changed tree read again");

        Assert.Empty(index.ListedIn(Plugin.Key));
        Assert.DoesNotContain("showing", Reason(index), StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AStandingFailureOfAPluginRespelledOnlyInCase_IsNamedAsSpelledNowAndNotReadAgain()
    {
        SourceMods.Init(Plugin);
        ClaimedTwice();
        using var index = Reconciled(new FailsToOpen(PluginFailures.Unparsed(), atOpen: _ => true));
        Assert.True(Failed(index));
        var readsBefore = TreeReads();

        index.Reconcile(index.Holder, _fixture.DataFolder, [Plugin with { Origin = Plugin.Origin.ToLowerInvariant() }],
            GameRelease.Fallout4, _fixture.InstanceRoot);

        var failure = Assert.Single(index.Status.Failures);
        Assert.Equal((PluginName, Plugin.Origin.ToLowerInvariant()), (failure.Name, failure.Origin));
        Assert.Equal(readsBefore, TreeReads());
    }

    [Fact]
    public void ATreeMendedWhileItsBinaryStoodInForIt_IsReadAgain()
    {
        SourceMods.Init(Plugin);
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
        SourceMods.Init(Plugin);
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
        SourceMods.Init(Plugin);
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
        Assert.Contains(index.ListedIn(Plugin.Key), row => row.EditorId == "RenamedNpc");
    }

    [Fact]
    public void ATreeWithAnUnreadableDocument_IsReadAgainAtEverySnapshot()
    {
        SourceMods.Init(Plugin);
        using var index = Reconciled();
        File.WriteAllText(StrayDocument, "{}");
        index.NextSnapshotUntil(() => SourceUnreadable(index), "the binary read in the tree's place");

        TreeReadAgainAtTheNextSnapshot(index);
        TreeReadAgainAtTheNextSnapshot(index);
    }

    private void TreeReadAgainAtTheNextSnapshot(OpenedIndex index)
    {
        var readsBefore = TreeReads();
        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the tree read again at the next snapshot");
    }

    [Fact]
    public void ABinaryReadThatRanOutOfMemory_BesideAnUnreadableDocument_IsNotReadAgainWhileItsBytesHold()
    {
        SourceMods.Init(Plugin);
        File.WriteAllText(StrayDocument, "{}");
        var binaryReads = 0;
        using var index = Reconciled(new PartwayAdapter(afterRecords: 0, () =>
        {
            Interlocked.Increment(ref binaryReads);
            throw Faults.Of(typeof(OutOfMemoryException));
        }));
        Assert.True(Failed(index));

        index.Reconcile(index.Holder, _fixture.DataFolder, [Plugin with { Origin = Plugin.Origin.ToLowerInvariant() }],
            GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal(1, Volatile.Read(ref binaryReads));
    }

    [Fact]
    public void ATreeReadAgainAtEverySnapshot_ReadsTheBinaryInItsPlaceOncePerChangeOfItsBytes()
    {
        SourceMods.Init(Plugin);
        File.WriteAllText(StrayDocument, "{}");
        using var adapter = new GatedPluginAdapter();
        using var index = Reconciled(adapter);
        Assert.True(SourceUnreadable(index));
        var binaryReads = adapter.OpenedTotal;

        TreeReadAgainAtTheNextSnapshot(index);
        TreeReadAgainAtTheNextSnapshot(index);

        Assert.Equal(binaryReads, adapter.OpenedTotal);
    }

    [Fact]
    public void ATreeUnreadableWhenItsWholeReadBegan_IsReadAgainOnceReadable()
    {
        SourceMods.Init(Plugin);
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
        using var index = Reconciled(new FailsToOpen(PluginFailures.Inaccessible(), atOpen: n => n == 2));
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenBeforeTheHold"));
        index.NextSnapshotUntil(() => Failed(index), "the held read's failure");

        index.NextSnapshotUntil(() => !Failed(index), "the binary read again");

        Assert.Contains(index.ListedIn(Plugin.Key), row => row.EditorId == "WrittenBeforeTheHold");
    }

    [Fact]
    public void ABinaryHeldByAnotherProcessWhenItArrives_IsReadAgainWithItsBytesUnchanged()
    {
        var adapter = new FailsToOpen(PluginFailures.Inaccessible(), atOpen: n => n == 1);

        using var index = Reconciled(adapter);

        Assert.True(adapter.Failed);
        Assert.False(Failed(index));
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
    }

    [Fact]
    public async Task APluginWhoseStringsFileWasMissing_IsReadAgainOnceItArrivesWithItsBytesUnchanged()
    {
        var adapter = new FailsToOpen(await PluginFailures.MissingStringsAsync(), atOpen: n => n == 1);
        using var index = Reconciled(adapter);
        Assert.True(adapter.Failed);

        index.NextSnapshotUntil(() => !Failed(index), "the plugin read again");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
    }

    [Fact]
    public void ATreeDocumentHeldOnlyWhileTheTreeIsRead_IsReadAgainWithItsBytesUnchanged()
    {
        SourceMods.Init(Plugin);
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
    public void AJustSourceModTreeWhoseBinaryAlsoFails_SaysTheBinarysLastReadStillShows()
    {
        using var index = Reconciled(new FailsToOpen(PluginFailures.Unparsed(), atOpen: n => n == 2));
        SourceMods.Init(Plugin);
        ClaimedTwice();

        index.NextSnapshotUntil(() => Failed(index), "the tree's and the binary's failure");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Still showing what was last read from its compiled binary", Reason(index), StringComparison.Ordinal);
    }

    [Fact]
    public void ABinaryRewrittenThatFailsToRead_SaysItsLastReadStillShows()
    {
        using var index = Reconciled(new FailsToOpen(PluginFailures.Unparsed(), atOpen: n => n == 2));
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
    public void AValidationThatRunsOutOfMemory_IsThePluginsFailedToRead_WithoutReadingItWhole()
    {
        SourceMods.Init(Plugin);
        using var index = Reconciled();
        var document = NpcDocument;
        File.WriteAllText(document, File.ReadAllText(document).Replace($"\"{NpcEditorId}\"", "\"EditedNpc\"", StringComparison.Ordinal));
        var thrown = Faults.Of(typeof(OutOfMemoryException));
        Arm(TreeMoment.RecordRead, () => throw thrown);
        var readsBefore = TreeReads();

        index.NextSnapshotUntil(() => Failed(index), "the plugin's failure");

        Assert.Contains(thrown.Message, Reason(index), StringComparison.Ordinal);
        Assert.Equal(readsBefore, TreeReads());
    }

    [Fact]
    public void AWarmLoadWhoseValidationRunsOutOfMemory_IsThePluginsFailedToRead_WithoutReadingItWhole()
    {
        SourceMods.Init(Plugin);
        using (Reconciled()) { }
        var document = NpcDocument;
        File.WriteAllText(document, File.ReadAllText(document).Replace($"\"{NpcEditorId}\"", "\"EditedNpc\"", StringComparison.Ordinal));
        var thrown = Faults.Of(typeof(OutOfMemoryException));
        Arm(TreeMoment.RecordRead, () => throw thrown);
        var readsBefore = TreeReads();

        using var index = Reconciled();

        Assert.Contains(thrown.Message, Reason(index), StringComparison.Ordinal);
        Assert.Equal(readsBefore, TreeReads());
    }

    [Fact]
    public void ATreeWhoseReadRunsOutOfMemory_SaysSo_AndIsNotReadAgainWhileItsDocumentsHold()
    {
        SourceMods.Init(Plugin);
        var thrown = Faults.Of(typeof(OutOfMemoryException));
        Arm(TreeMoment.ReadBegins, () => throw thrown);
        using var index = Reconciled();
        Assert.Contains(thrown.Message, index.PluginResponseOf(Plugin.Key)?.PluginSourceUnreadable?.Reason, StringComparison.Ordinal);
        var readsBefore = TreeReads();

        index.Reconcile(index.Holder, _fixture.DataFolder, [Plugin with { Origin = Plugin.Origin.ToLowerInvariant() }],
            GameRelease.Fallout4, _fixture.InstanceRoot);

        Assert.Equal(readsBefore, TreeReads());
    }

    [Theory]
    [InlineData("the codec broke", "the codec broke")]
    [InlineData("", "could not be read")]
    public void ATreeWhoseReadThrows_SaysWhy_NeverBlank_AndDecompileRepairsIt(string message, string expected)
    {
        SourceMods.Init(Plugin);
        void Throw()
        {
            Arm(TreeMoment.ReadBegins, Throw);
            throw new InvalidOperationException(message);
        }
        Arm(TreeMoment.ReadBegins, Throw);

        using var index = Reconciled();

        var unreadable = index.PluginResponseOf(Plugin.Key)?.PluginSourceUnreadable.Require();
        Assert.Contains(expected, unreadable?.Reason, StringComparison.Ordinal);
        Assert.True(unreadable?.DecompileRepairs);
    }

    [Theory]
    [InlineData(typeof(IOException))]
    [InlineData(typeof(UnauthorizedAccessException))]
    public void ATreeWhoseReadThrowsAFileSystemRefusal_SaysWhy_AndDecompileDoesNotRepairIt(Type refusal)
    {
        SourceMods.Init(Plugin);
        void Throw()
        {
            Arm(TreeMoment.ReadBegins, Throw);
            throw (Exception)Activator.CreateInstance(refusal, "the file is held").Require();
        }
        Arm(TreeMoment.ReadBegins, Throw);

        using var index = Reconciled();

        var unreadable = index.PluginResponseOf(Plugin.Key)?.PluginSourceUnreadable.Require();
        Assert.Contains("the file is held", unreadable?.Reason, StringComparison.Ordinal);
        Assert.False(unreadable?.DecompileRepairs);
    }

    [PosixFact]
    public void ATreeWhoseDocumentCannotBeOpened_SaysWhy_AndDecompileDoesNotRepairIt()
    {
        SourceMods.Init(Plugin);
        var document = NpcDocument;
        FileModes.Set(document, "000");
        try
        {
            using var index = Reconciled();

            var unreadable = index.PluginResponseOf(Plugin.Key)?.PluginSourceUnreadable.Require();
            Assert.False(string.IsNullOrWhiteSpace(unreadable?.Reason));
            Assert.False(unreadable?.DecompileRepairs);
        }
        finally
        {
            FileModes.Set(document, "600");
        }
    }

    [Fact]
    public void AWarmValidationThatThrows_ReadsThePluginWhole()
    {
        SourceMods.Init(Plugin);
        Reconciled().Dispose();
        var document = NpcDocument;
        File.WriteAllText(document, File.ReadAllText(document).Replace($"\"{NpcEditorId}\"", "\"EditedNpc\"", StringComparison.Ordinal));

        Arm(TreeMoment.RecordRead, () => throw new TimeoutException("the tree could not be compared"));

        using var index = Reconciled();

        Assert.Null(_armed);
        Assert.False(Failed(index));
        Assert.Contains(index.ListedIn(Plugin.Key), row => row.EditorId == "EditedNpc");
    }

    private sealed class HeldAtFirstRead : DelegatingPluginAdapter
    {
        private int _read;

        public HeldAtFirstRead() : base(TestAdapters.Mutagen()) { }

        public override Answer<(PluginContent Content, PluginFailure? Unreachable), PluginFailure> ReadContent(
            ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings strings) =>
            Interlocked.Increment(ref _read) == 1
                ? PluginFailures.Inaccessible()
                : base.ReadContent(modPath, loadOrder, strings);
    }

    private sealed class FailsToOpen(PluginFailure failure, Func<int, bool> atOpen, Action? beforeFailing = null)
        : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private int _opened;

        public bool Failed { get; private set; }

        public override Answer<IPluginDocuments, PluginFailure> OpenDocuments(
            ModPath modPath, LoadOrderSnapshot loadOrder, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings strings)
        {
            if (!atOpen(Interlocked.Increment(ref _opened))) return base.OpenDocuments(modPath, loadOrder, schemas, strings);
            beforeFailing?.Invoke();
            Failed = true;
            return failure;
        }
    }

    private enum TreeMoment { StampsTaken, ReadBegins, ReadEnds, RecordRead }

    private sealed class HookedSource(Action<TreeMoment, PluginAddress> at) : DelegatingSourceAdapter(TestAdapters.Source())
    {
        public override ISourceRepositoryReads? Over(RegisteredPlugin plugin, GameRelease release) =>
            base.Over(plugin, release) is { } reads ? new HookedRepository(reads, at) : null;

        public override ISourceRepositoryReads? TreeOf(RegisteredPlugin plugin, GameRelease release) =>
            SourceReads(plugin) ? Over(plugin, release) : null;
    }

    private sealed class HookedRepository(ISourceRepositoryReads inner, Action<TreeMoment, PluginAddress> at) : ISourceRepositoryReads
    {
        public RecordStamps StampsOf(PluginAddress plugin)
        {
            var stamps = inner.StampsOf(plugin);
            at(TreeMoment.StampsTaken, plugin);
            return stamps;
        }

        public Answer<T, SourceFailure> ReadDocuments<T>(PluginAddress plugin, Func<IPluginDocuments, T> read)
        {
            at(TreeMoment.ReadBegins, plugin);
            try
            {
                return inner.ReadDocuments(plugin, read);
            }
            finally
            {
                at(TreeMoment.ReadEnds, plugin);
            }
        }

        public Answer<SourceDocument?, SourceFailure> RecordOf(PluginAddress plugin, RecordIdentity identity)
        {
            at(TreeMoment.RecordRead, plugin);
            return inner.RecordOf(plugin, identity);
        }

        public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommit(PluginAddress plugin) =>
            inner.ChangedSinceLastCommit(plugin);

        public Answer<IReadOnlyList<string>, SourceFailure> WorkingTreeChangesOf(PluginAddress plugin) =>
            inner.WorkingTreeChangesOf(plugin);

        public SourceFailure? WhyUnreadable(PluginAddress plugin, RecordIdentity identity, string body) =>
            inner.WhyUnreadable(plugin, identity, body);

        public Answer<SourceDocument?, SourceFailure> RecordFromText(PluginAddress plugin, string formKey, string text) =>
            inner.RecordFromText(plugin, formKey, text);

        public Answer<DocumentFile?, SourceFailure> DocumentOf(PluginAddress plugin, RecordIdentity identity) => inner.DocumentOf(plugin, identity);

        public Answer<string?, SourceFailure> RelativePathOf(PluginAddress plugin, RecordIdentity identity) => inner.RelativePathOf(plugin, identity);

        public Answer<string?, SourceFailure> FileNameOf(PluginAddress plugin, RecordIdentity identity) => inner.FileNameOf(plugin, identity);
    }
}
