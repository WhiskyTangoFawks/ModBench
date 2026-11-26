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

    private Action<string> _stamping = _ => { };

    public FailedReadStateTests() => _source = new HookedSource(FireIfArmed, text => _stamping(text));

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

    private string GitIndex => Path.Combine(Plugin.ModFolderOf(), ".git", "index");

    private OpenedIndex ATreeWhoseStatusGitCannotReport_OnceARecordChanges()
    {
        SourceMods.Init(Plugin);
        var index = Reconciled();
        var npc = NpcDocument;
        File.Copy(GitIndex, GitIndex + ".good");
        File.WriteAllText(GitIndex, "not an index");
        File.WriteAllText(npc, File.ReadAllText(npc).Replace(NpcEditorId, "RenamedNpc", StringComparison.Ordinal));
        index.NextCheckUntil(() => SourceUnreadable(index), "the binary read in the tree's place");
        return index;
    }

    [Fact]
    public void ATreeWhoseGitIsRepairedOutsideModbench_IsReadFromItsTree_AtTheNextCheck()
    {
        using var index = ATreeWhoseStatusGitCannotReport_OnceARecordChanges();

        File.Move(GitIndex + ".good", GitIndex, overwrite: true);

        index.NextCheckUntil(() => ReadFromSource(index), "the tree read again");
        Assert.Contains(index.ListedIn(Plugin.Key), row => row.EditorId == "RenamedNpc");
    }

    private void TreeReadAgainAtTheNextCheck(OpenedIndex index)
    {
        var readsBefore = TreeReads();
        index.NextCheckUntil(() => TreeReads() > readsBefore, "the tree read again at the next check");
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
    public void ATreeReadAgainAtEveryCheck_ReadsTheBinaryInItsPlaceOncePerChangeOfItsBytes()
    {
        SourceMods.Init(Plugin);
        File.WriteAllText(StrayDocument, "{}");
        using var adapter = new GatedPluginAdapter();
        using var index = Reconciled(adapter);
        Assert.True(SourceUnreadable(index));
        var binaryReads = adapter.OpenedTotal;

        TreeReadAgainAtTheNextCheck(index);
        TreeReadAgainAtTheNextCheck(index);

        Assert.Equal(binaryReads, adapter.OpenedTotal);
        Assert.True(SourceUnreadable(index));
    }

    [Fact]
    public void ATreeUnreadableWhenItsWholeReadBegan_IsReadAgainOnceReadable()
    {
        SourceMods.Init(Plugin);
        using var index = Reconciled();
        var untyped = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(NpcDocument)).Require(), "Untyped")).FullName;
        Arm(TreeMoment.StampsTaken, () => File.WriteAllText(StrayDocument, "{}"));
        File.WriteAllText(Path.Combine(untyped, "Gained.json"), $$"""{"FormKey":"000ABC:{{PluginName}}"}""");
        index.NextCheckUntil(() => SourceUnreadable(index), "the binary read in the tree's place");
        Assert.Null(_armed);
        File.Delete(StrayDocument);
        var readsBefore = TreeReads();

        index.NextCheckUntil(() => TreeReads() > readsBefore, "the tree read again");
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
    public void ABinaryHeldWhenAWarmLoadOpensIt_KeepsItsLastRead()
    {
        Reconciled().Dispose();

        using var index = Reconciled(new HeldAtFirstRead());

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.True(Failed(index));
    }

    [Fact]
    public void ABinaryThatHashesButIsHeldWhenItOpens_IsOpenedAtTheNextCheck()
    {
        using var index = Reconciled(new HeldAtFirstRead());
        Assert.True(Failed(index));

        index.NextCheckUntil(() => !Failed(index), "the binary opened again");

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

        index.NextCheckThatMayFailUntil(() => Failed(index), "the plugin's failure");

        Assert.StartsWith("Could not validate this plugin's source tree (", Reason(index), StringComparison.Ordinal);
        Assert.Contains(thrown.Message, Reason(index), StringComparison.Ordinal);
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Equal(readsBefore, TreeReads());
    }

    [Fact]
    public void AnEditWhoseProjectionRunsOutOfMemoryAfterTheCheckStampedIt_IsThePluginsFailedToRead_WithoutReadingItWhole()
    {
        SourceMods.Init(Plugin);
        using var index = Reconciled();
        var document = NpcDocument;
        File.WriteAllText(document, File.ReadAllText(document).Replace($"\"{NpcEditorId}\"", "\"EditedNpc\"", StringComparison.Ordinal));
        var thrown = Faults.Of(typeof(OutOfMemoryException));
        const int theProjectionsStamp = 2;
        var stampsOfTheEdit = 0;
        _stamping = text =>
        {
            if (text.Contains("\"EditedNpc\"", StringComparison.Ordinal) && Interlocked.Increment(ref stampsOfTheEdit) == theProjectionsStamp)
                throw thrown;
        };
        var readsBefore = TreeReads();

        index.NextCheckThatMayFailUntil(() => Failed(index), "the plugin's failure");

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

    [Theory]
    [InlineData(typeof(InvalidOperationException), "", "could not be read", true)]
    [InlineData(typeof(IOException), "the file is held", "the file is held", false)]
    [InlineData(typeof(UnauthorizedAccessException), "the file is held", "the file is held", false)]
    public void ATreeWhoseReadThrows_SaysWhy_NeverBlank_AndWhetherDecompileRepairsIt(Type thrown, string message, string expected, bool repairs)
    {
        SourceMods.Init(Plugin);
        void Throw()
        {
            Arm(TreeMoment.ReadBegins, Throw);
            throw (Exception)Activator.CreateInstance(thrown, message).Require();
        }
        Arm(TreeMoment.ReadBegins, Throw);

        using var index = Reconciled();

        var unreadable = index.PluginResponseOf(Plugin.Key)?.PluginSourceUnreadable.Require();
        Assert.Contains(expected, unreadable?.Reason, StringComparison.Ordinal);
        Assert.Equal(repairs, unreadable?.DecompileRepairs);
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

        public override Answer<PluginContent, PluginFailure> ReadContent(
            ModPath modPath, LoadOrderSnapshot loadOrder, PluginStrings strings) =>
            Interlocked.Increment(ref _read) == 1
                ? PluginFailures.Inaccessible()
                : base.ReadContent(modPath, loadOrder, strings);
    }

    private enum TreeMoment { StampsTaken, ReadBegins, ReadEnds, RecordRead }

    private sealed class HookedSource(Action<TreeMoment, PluginAddress> at, Action<string> stamping) : DelegatingSourceAdapter(TestAdapters.Source())
    {
        public override string ContentStamp(string text)
        {
            stamping(text);
            return base.ContentStamp(text);
        }

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

        public Answer<FilesRead?, SourceFailure> ReadFiles(PluginAddress plugin, IReadOnlyList<string> files, IReadOnlyList<WrittenDocument> written) =>
            inner.ReadFiles(plugin, files, written);

        public Answer<IReadOnlyDictionary<string, RecordChange>, SourceFailure> ChangedSinceLastCommitIn(
            PluginAddress plugin, IReadOnlyList<string> files, IReadOnlyList<WrittenDocument> written) =>
            inner.ChangedSinceLastCommitIn(plugin, files, written);

        public FilesStamp RepositoryStamp() => inner.RepositoryStamp();

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
