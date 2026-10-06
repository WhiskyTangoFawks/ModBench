using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.PluginAdapter;
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

    public void Dispose() => _fixture.Dispose();

    private LoadOrderEntry Plugin => _fixture.Plugins.Single();

    private OpenedIndex Reconciled(IPluginAdapter? adapter = null) =>
        Indexes.Reconciled(_fixture, _fixture.InstanceRoot, adapter);

    private RecordDocument TheNpc(OpenedIndex index) =>
        index.RequireReads().GetDocuments(Plugin.KeyOf()).Single(d => d.EditorId == NpcEditorId);

    private static void ClaimedTwice(string document) =>
        File.Copy(document, Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(document).Require(), "Backup")).FullName, Path.GetFileName(document)));

    [Fact]
    public void ABinaryRewrittenDuringAFailedRead_IsReadAgain()
    {
        var adapter = new FailsOnceAfter(() =>
            PluginBinaries.Rewrite(Plugin.Path, mod => mod.Npcs.AddNew("WrittenAfterTheFailure")));

        using var index = Reconciled(adapter);

        Assert.DoesNotContain(index.Status.Failures, f => f.Name == PluginName);
        Assert.Contains(index.RequireReads().GetDocuments(Plugin.KeyOf()), d => d.EditorId == "WrittenAfterTheFailure");
    }

    [Fact]
    public void ATreeThatFailsWhenItsModGainsARepository_LeavesTheBinaryServing_AndSaysSo()
    {
        using var index = Reconciled();
        var npc = TheNpc(index);
        TrackedMods.Track(Plugin, _fixture.GameDirectory);
        ClaimedTwice(Plugin.SourceFileOf(npc));

        index.NextSnapshotUntil(() => index.Status.Failures.Any(f => f.Name == PluginName), "the tree's failure");

        Assert.Equal(NpcEditorId, TheNpc(index).EditorId);
        Assert.Contains("Showing the compiled binary instead", index.Status.Failures.Single(f => f.Name == PluginName).Reason, StringComparison.Ordinal);
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
