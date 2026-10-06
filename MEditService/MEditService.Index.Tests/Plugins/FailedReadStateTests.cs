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
    private string? _mendOnLogged;
    private readonly ILoggerFactory _loggerFactory;

    public FailedReadStateTests() =>
        _loggerFactory = LoggerFactory.Create(b => b.AddProvider(new CollectingLoggerProvider(_log, MendTheTreeOnce)));

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

    private void MendTheTreeOnce(LogEntry entry)
    {
        if (_mendOnLogged is not { } prefix || !entry.Message.StartsWith(prefix, StringComparison.Ordinal)) return;
        _mendOnLogged = null;
        foreach (var backup in Directory.EnumerateDirectories(Plugin.ModFolderOf(), "Backup", SearchOption.AllDirectories).ToList())
            Directory.Delete(backup, recursive: true);
    }

    private int TreeReads()
    {
        lock (_log) return _log.Count(e => e.Message.Contains($"ngesting {PluginName} from its source tree", StringComparison.Ordinal));
    }

    private static bool Failed(OpenedIndex index) => index.Status.Failures.Any(f => f.Name == PluginName);

    [Fact]
    public void ABinaryRewrittenDuringAFailedRead_IsReadAgain()
    {
        var adapter = new FailsOnceAfter(() =>
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
    public void ATreeMendedWhileItsBinaryStoodInForIt_IsReadAgain()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice();
        _mendOnLogged = $"Could not ingest {PluginName} from its source tree";

        using var index = Reconciled();

        Assert.Null(_mendOnLogged);
        Assert.False(Failed(index));
        Assert.Contains(Plugin.KeyOf(), index.RequireReads().GetTrackedPlugins());
    }

    [Fact]
    public void ATreeMendedDuringTheValidationItFailed_IsReadAgainAtTheNextSnapshot()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        ClaimedTwice();
        _mendOnLogged = $"Reconciling {PluginName}:";
        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");
        Assert.Null(_mendOnLogged);

        index.NextSnapshotUntil(() => !Failed(index), "the mended tree read again");

        Assert.Contains(Plugin.KeyOf(), index.RequireReads().GetTrackedPlugins());
    }

    [Fact]
    public void ATreeWithAnUnreadableDocument_IsReadAgainAtEverySnapshot()
    {
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        using var index = Reconciled();
        File.WriteAllText(Path.Combine(Path.GetDirectoryName(NpcDocument).Require(), "Stray.json"), "{}");
        index.NextSnapshotUntil(() => Failed(index), "the validation's failure");
        var readsBefore = TreeReads();

        index.NextSnapshotUntil(() => TreeReads() > readsBefore, "the tree read again");
    }

    private sealed class FailsOnceAfter(Action beforeFailing) : DelegatingPluginAdapter(TestAdapters.Mutagen())
    {
        private int _opened;

        public override IPluginDocuments OpenDocuments(
            ModPath modPath, GameRelease gameRelease, IReadOnlyDictionary<string, RecordTableSchema> schemas,
            PluginStrings? strings = null)
        {
            if (Interlocked.Increment(ref _opened) > 1) return base.OpenDocuments(modPath, gameRelease, schemas, strings);
            beforeFailing();
            throw new InvalidOperationException("injected read failure");
        }
    }
}
