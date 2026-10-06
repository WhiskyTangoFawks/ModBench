using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.PluginAdapter;
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
    private (string Prefix, Action Act)? _onLogged;
    private readonly ILoggerFactory _loggerFactory;

    public FailedReadStateTests() =>
        _loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log, ActOnceLogged)));

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

    private void ClaimedTwice()
    {
        var document = NpcDocument;
        var backup = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "Backup")).FullName;
        File.Copy(document, Path.Combine(backup, Path.GetFileName(document)));
    }

    private void ActOnceLogged(LogEntry entry)
    {
        if (_onLogged is not { } once || !entry.Message.StartsWith(once.Prefix, StringComparison.Ordinal)) return;
        _onLogged = null;
        once.Act();
    }

    private void Mend()
    {
        foreach (var backup in Directory.EnumerateDirectories(Plugin.ModFolderOf(), "Backup", SearchOption.AllDirectories).ToList())
            Directory.Delete(backup, recursive: true);
    }

    private void MendOnceLogged(string prefix) => _onLogged = (prefix, Mend);

    private string StrayDocument => Path.Combine(Path.GetDirectoryName(NpcDocument).Require(), "Stray.json");

    private int TreeReads()
    {
        string[] treeReads = [$"Ingesting {PluginName} from its source tree", $"Re-ingesting {PluginName} from its source tree"];
        lock (_log) return _log.Count(e => treeReads.Contains(e.Message));
    }

    private static bool Failed(OpenedIndex index) => index.Status.Failures.Any(f => f.Name == PluginName);

    [Fact]
    public void ABinaryRewrittenDuringAFailedRead_IsReadAgain()
    {
        var adapter = new FailsOnce(atOpen: 1, new InvalidOperationException("injected read failure"), () =>
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
        Assert.Contains("Showing the compiled binary instead", index.Status.Failures.Single(f => f.Name == PluginName).Reason, StringComparison.Ordinal);
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
        Assert.Contains("Showing the compiled binary instead", index.Status.Failures.Single(f => f.Name == PluginName).Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ATreeMendedWhileItsBinaryStoodInForIt_IsReadAgain()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();
        MendOnceLogged($"Could not ingest {PluginName} from its source tree");

        using var index = Reconciled();

        Assert.Null(_onLogged);
        Assert.False(Failed(index));
        Assert.Contains(Plugin.KeyOf(), index.RequireReads().GetTrackedPlugins());
    }

    [Fact]
    public void ATreeMendedDuringTheValidationItFailed_IsReadAgainAtTheNextSnapshot()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        ClaimedTwice();
        MendOnceLogged($"Reconciling {PluginName}:");
        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");
        Assert.Null(_onLogged);

        index.NextSnapshotUntil(() => !Failed(index), "the mended tree read again");

        Assert.Contains(Plugin.KeyOf(), index.RequireReads().GetTrackedPlugins());
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
        var stray = StrayDocument;
        var untyped = Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(NpcDocument)).Require(), "Untyped")).FullName;
        _onLogged = ($"Re-ingesting {PluginName}", () => File.WriteAllText(stray, "{}"));
        File.WriteAllText(Path.Combine(untyped, "Gained.json"), $$"""{"FormKey":"000ABC:{{PluginName}}"}""");
        index.NextSnapshotUntil(() => Failed(index), "the whole read's failure");
        Assert.Null(_onLogged);
        File.Delete(stray);
        var readsBefore = TreeReads();

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the tree read again");
    }

    [Fact]
    public void ABinaryHeldByAnotherProcessWhenItIsReadAgain_IsReadAtTheNextSnapshot()
    {
        using var index = Reconciled(new FailsOnce(atOpen: 2, new IOException("held by another process")));
        PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenBeforeTheHold"));
        index.NextSnapshotUntil(() => Failed(index), "the held read's failure");

        index.NextSnapshotUntil(() => !Failed(index), "the binary read again");

        Assert.Contains(index.RequireReads().GetDocuments(Plugin.KeyOf()), d => d.EditorId == "WrittenBeforeTheHold");
    }

    [Fact]
    public void ABinaryHeldByAnotherProcessWhenItArrives_IsReadAgainWithItsBytesUnchanged()
    {
        var adapter = new FailsOnce(atOpen: 1, new IOException("held by another process"));

        using var index = Reconciled(adapter);

        Assert.True(adapter.Threw);
        Assert.False(Failed(index));
        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
    }

    private sealed class FailsOnce(int atOpen, Exception failure, Action? beforeFailing = null)
        : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private int _opened;

        public bool Threw => Volatile.Read(ref _opened) >= atOpen;

        public override IPluginDocuments OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null)
        {
            if (Interlocked.Increment(ref _opened) != atOpen) return base.OpenDocuments(modPath, gameRelease, schemas, strings);
            beforeFailing?.Invoke();
            throw failure;
        }
    }
}
