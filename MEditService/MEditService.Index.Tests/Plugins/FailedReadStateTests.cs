using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
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

    private RecordDocument TheNpc(OpenedIndex index) =>
        index.RequireReads().GetDocuments(Plugin.KeyOf()).Single(d => d.EditorId == NpcEditorId);

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
        string[] treeReads = [$"Ingesting {PluginName} from its source tree", $"Re-ingesting {PluginName} from its source tree"];
        lock (_log) return _log.Count(e => treeReads.Contains(e.Message));
    }

    private static bool Failed(OpenedIndex index) => index.Status.Failures.Any(f => f.Name == PluginName);

    private static string Reason(OpenedIndex index) => index.Status.Failures.Single(f => f.Name == PluginName).Reason;

    private string Relative(string path) => Path.GetRelativePath(Plugin.ModFolderOf(), path);

    [Fact]
    public void ATreeWithADocumentDeclaringNoFormKey_NamesThatFile_WhileItFails()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        File.WriteAllText(StrayDocument, "{}");

        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");

        var failure = Assert.Single(index.SourceFileFailures);
        Assert.Equal((Plugin.KeyOf(), Relative(StrayDocument), (string?)null), (failure.Plugin, failure.SourceRelativePath, failure.FormKey));
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

        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");

        var copy = Path.Combine(Path.GetDirectoryName(original).Require(), "Backup", Path.GetFileName(original));
        Assert.Equivalent(
            new[] { (Relative(original), formKey), (Relative(copy), formKey) },
            index.SourceFileFailures.Select(f => (f.SourceRelativePath, f.FormKey)), strict: true);
        Assert.All(index.SourceFileFailures, f => Assert.Contains(Relative(copy), f.Message, StringComparison.Ordinal));
    }

    [Fact]
    public void ATreeWhoseFormKeyTwoDocumentsClaimWhenFirstRead_NamesEachOfThem_WhileItsBinaryStandsIn()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        var original = NpcDocument;
        ClaimedTwice();

        using var index = Reconciled();

        var copy = Path.Combine(Path.GetDirectoryName(original).Require(), "Backup", Path.GetFileName(original));
        Assert.Equivalent(new[] { Relative(original), Relative(copy) }, index.SourceFileFailures.Select(f => f.SourceRelativePath), strict: true);
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Still showing what was last read from its compiled binary", Reason(index), StringComparison.Ordinal);
    }

    [Fact]
    public void ATreeMended_NamesNoFile()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        ClaimedTwice();
        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");
        Mend();

        index.NextSnapshotUntil(() => !Failed(index), "the mended tree read again");

        Assert.Empty(index.SourceFileFailures);
    }

    [Fact]
    public void ABinaryRewrittenDuringAFailedRead_IsReadAgain()
    {
        var adapter = new FailsToOpen(new InvalidOperationException("injected read failure"), atOpen: n => n == 1, () =>
            PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenAfterTheFailure")));

        using var index = Reconciled(adapter);

        Assert.False(Failed(index));
        Assert.Contains(index.RequireReads().GetDocuments(Plugin.KeyOf()), d => d.EditorId == "WrittenAfterTheFailure");
    }

    [Fact]
    public void ATreeThatFailsWhenItsModGainsARepository_LeavesTheBinaryServing_AndSaysSo()
    {
        using var index = Reconciled();
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();

        index.NextSnapshotUntil(() => Failed(index), "the tree's failure");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Still showing what was last read from its compiled binary", Reason(index), StringComparison.Ordinal);
    }

    [Fact]
    public void ATreeThatStillFailsAfterAChange_SaysItsBinaryStillStandsIn()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();
        using var index = Reconciled();
        var readsBefore = TreeReads();
        Mend();
        File.WriteAllText(StrayDocument, "{}");

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the changed tree read again");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Still showing what was last read from its compiled binary", Reason(index), StringComparison.Ordinal);
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

        index.NextSnapshotUntil(() => TreeReads() > readsBefore + 1, "the changed tree re-derived and read again");

        Assert.Empty(index.RequireReads().GetDocuments(Plugin.KeyOf()));
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
        Assert.Contains(Plugin.KeyOf(), index.RequireReads().GetTrackedPlugins());
    }

    [Fact]
    public void ATreeMendedDuringTheValidationItFailed_IsReadAgainAtTheNextSnapshot()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        ClaimedTwice();
        ArmOn($"Reconciling {PluginName}:", Mend);
        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");
        Assert.Null(_armed);

        index.NextSnapshotUntil(() => !Failed(index), "the mended tree read again");

        Assert.Contains(Plugin.KeyOf(), index.RequireReads().GetTrackedPlugins());
    }

    [Fact]
    public void ATreeWhoseStatusGitCannotReport_WhenARecordChanges_FailsThePlugin_NamingGit()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        var npc = NpcDocument;
        File.WriteAllText(Path.Combine(Plugin.ModFolderOf(), ".git", "index"), "not an index");
        File.WriteAllText(npc, File.ReadAllText(npc).Replace(NpcEditorId, "RenamedNpc", StringComparison.Ordinal));

        index.NextSnapshotUntil(() => Failed(index), "the failed read");

        Assert.Contains("git cannot report what changed", Reason(index), StringComparison.Ordinal);
        Assert.DoesNotContain("is filed as a record", Reason(index), StringComparison.Ordinal);
    }

    [Fact]
    public void ATreeWithAnUnreadableDocument_IsReadAgainAtEverySnapshot()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        File.WriteAllText(StrayDocument, "{}");
        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");

        for (var snapshot = 1; snapshot <= 3; snapshot++)
        {
            var readsBefore = TreeReads();
            index.NextSnapshotUntil(() => TreeReads() > readsBefore, $"the tree read again at snapshot {snapshot}");
        }
    }

    [Fact]
    public void ATreeUnreadableWhenItsWholeReadBegan_IsReadAgainOnceReadable()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        var untyped = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(NpcDocument)).Require(), "Untyped")).FullName;
        ArmOn($"Re-ingesting {PluginName}", () => File.WriteAllText(StrayDocument, "{}"));
        File.WriteAllText(Path.Combine(untyped, "Gained.json"), $$"""{"FormKey":"000ABC:{{PluginName}}"}""");
        index.NextSnapshotUntil(() => Failed(index), "the whole read's failure");
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

        Assert.Contains(index.RequireReads().GetDocuments(Plugin.KeyOf()), d => d.EditorId == "WrittenBeforeTheHold");
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
        Assert.Contains(Plugin.KeyOf(), index.RequireReads().GetTrackedPlugins());
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
        Assert.Contains(index.RequireReads().GetDocuments(Plugin.KeyOf()), d => d.EditorId == "EditedNpc");
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
