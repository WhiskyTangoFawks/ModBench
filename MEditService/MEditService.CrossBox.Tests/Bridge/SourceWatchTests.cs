using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.Ports;
using MEditService.Queries;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0015 invariant 2: a hand edit, a commit and a checkout reach the Index the same way
/// our own writes do. Wired the way the composition root wires it, over a real git working
/// tree.</summary>
public sealed class SourceWatchTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexedModFixture _mod;
    private readonly ModFolderWatcher _watcher;

    public SourceWatchTests()
    {
        _mod = IndexedModFixture.Tracked(_notifications);
        _watcher = TestWatcher.Over(_mod.Holder, _mod.Index, _notifications, TimeSpan.FromMilliseconds(100));
        _mod.Index.Reconcile(_mod.Holder, _mod.GameDirectory, [_mod.Entry], GameRelease.Fallout4);
        // The watch set arrives the way it does in the composition root: the load-order endpoint
        // hands the watcher the value it just put, and every tracked copy in it is watched.
        _watcher.Rearm(_mod.Holder.Current);
    }

    public void Dispose()
    {
        _watcher.Dispose();
        _mod.Dispose();
    }

    private IRecordIndex Index =>
        _mod.Index.Store ?? throw new InvalidOperationException("Expected the index to already hold a built store.");

    private string? EditorIdAt(RecordRef recordRef) =>
        Index.At(recordRef).GetDocument(_mod.Npc.ToString(), _mod.Plugin)?.EditorId;

    private void RenameTheNpcByHand(string editorId)
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace($"\"{IndexedModFixture.NpcEditorId}\"", $"\"{editorId}\"", StringComparison.Ordinal));
    }

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);

    private async Task<bool> Settles(long from) =>
        await _mod.Index.AwaitSequenceAsync(from + 1, TimeSpan.FromSeconds(15));

    // The sequence says a projection landed, not which one, and a commit and the checkout after it
    // are two: what the committed view says is the condition to wait on.
    private async Task<string?> CommittedEditorIdReaches(string editorId)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(15);
        while (DateTime.UtcNow < deadline && EditorIdAt(RecordRef.Head) != editorId)
            await Task.Delay(50);
        return EditorIdAt(RecordRef.Head);
    }

    // Long enough for a debounce window and the projection behind it to have run, so "nothing
    // happened" is a decision rather than a race.
    private static void WaitOutTheWatcher() => Thread.Sleep(1000);

    private IReadOnlyList<RowsChangedNotification> RowsChanged() =>
        [.. _notifications.Notifications.OfType<RowsChangedNotification>()];

    // The kernel keeps its load order across a Close, so the watches armed from it are still live
    // while the store they would project into is gone.
    [Fact]
    public void AfterClose_AWatchThatFires_ProjectsNothingAndLogsNothing()
    {
        var entries = new List<LogEntry>();
        using var watcher = new ModFolderWatcher(
            _mod.Holder, _mod.Index, _notifications, new CollectingLogger(entries), TimeSpan.FromMilliseconds(100));
        watcher.Rearm(_mod.Holder.Current);

        _mod.Index.Close();
        RenameTheNpcByHand("RenamedAfterClose");
        WaitOutTheWatcher();

        // A refused projection is logged, so a batch that reached the closed store says so here.
        Assert.Empty(entries);
    }

    [Fact]
    public async Task AHandEditToASourceDocument_LandsInTheIndex_AndNamesItsKeyOnTheRecorder()
    {
        var before = _mod.Index.Sequence;

        RenameTheNpcByHand("RenamedByHand");

        Assert.True(await Settles(before));
        Assert.Equal("RenamedByHand", EditorIdAt(RecordRef.Effective));
        Assert.Contains(RowsChanged(), n => n.Plugin == _mod.Plugin && n.Keys.Contains(_mod.Npc.ToString(), StringComparer.Ordinal));
    }

    [Fact]
    public async Task ACommitMadeOutsideModbench_MovesTheCommittedView()
    {
        var before = _mod.Index.Sequence;
        RenameTheNpcByHand("RenamedByHand");
        Assert.True(await Settles(before));
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Head));

        var beforeCommit = _mod.Index.Sequence;
        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");

        Assert.True(await Settles(beforeCommit));
        Assert.Equal("RenamedByHand", await CommittedEditorIdReaches("RenamedByHand"));
        Assert.Equal("RenamedByHand", EditorIdAt(RecordRef.Effective));
    }

    [Fact]
    public async Task ACheckoutMadeOutsideModbench_MovesTheCommittedViewWithIt()
    {
        var before = _mod.Index.Sequence;
        RenameTheNpcByHand("RenamedByHand");
        Assert.True(await Settles(before));
        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");
        Assert.Equal("RenamedByHand", await CommittedEditorIdReaches("RenamedByHand"));

        Git("checkout", "-q", "main");

        Assert.Equal(IndexedModFixture.NpcEditorId, await CommittedEditorIdReaches(IndexedModFixture.NpcEditorId));
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
    }

    // ADR-0015 invariant 2: our own write reaches the Index the way a hand edit does, and a second
    // signal over bytes that already landed changes nothing.
    [Fact]
    public async Task AWriteThroughTheWriteApi_LandsThroughTheWatcher_AndChangesNoRowASecondTime()
    {
        var service = TestEditService.EditHandler(_mod.Holder);
        var before = _mod.Index.Sequence;

        var edit = service.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.75").RootElement);
        Assert.True(edit.Applied);

        Assert.True(await Settles(before));
        var document = Index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin);
        Assert.NotNull(document);
        Assert.NotNull(document.Body);
        Assert.Contains("0.75", document.Body, StringComparison.Ordinal);
        var afterTheProjection = _mod.Index.Sequence;
        var projections = _notifications.Notifications.Count;

        // The same bytes, signalled again: a projection idempotent by content writes no row.
        File.SetLastWriteTimeUtc(_mod.NpcSourceFile, DateTime.UtcNow);
        WaitOutTheWatcher();

        Assert.Equal(afterTheProjection, _mod.Index.Sequence);
        Assert.Equal(projections, _notifications.Notifications.Count);
        // The watch is live all the same: the next hand edit lands through it.
        RenameTheNpcByHand("RenamedByHand");
        Assert.True(await Settles(afterTheProjection));
        Assert.Equal("RenamedByHand", EditorIdAt(RecordRef.Effective));
    }

    // The header is a source unit too (ADR-0007, ADR-0011): the watcher's own root is the mod
    // folder, so a hand edit to RecordData.json reaches the index the same way any other document's
    // does.
    [Fact]
    public async Task AHandEditToTheHeaderFile_LandsInTheIndex()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(_mod.ActualPluginName));
        var headerFile = Path.Combine(_mod.ModFolder, "source", _mod.ActualPluginName, "RecordData.json");
        var before = _mod.Index.Sequence;

        var text = File.ReadAllText(headerFile);
        File.WriteAllText(headerFile, text.Replace(
            "\"ModHeader\": {", "\"ModHeader\": {\n    \"Author\": \"RenamedByHand\",", StringComparison.Ordinal));

        Assert.True(await Settles(before));
        var document = Index.At(RecordRef.Effective).GetDocument(headerFormKey, _mod.Plugin);
        Assert.NotNull(document);
        Assert.NotNull(document.Body);
        Assert.Contains("RenamedByHand", document.Body, StringComparison.Ordinal);
    }

    // The gesture a user makes in the Source Control panel's "Discard Changes" — a working-tree
    // write the watcher sees exactly like a hand edit.
    [Fact]
    public async Task DiscardingAWorkingTreeChangeThroughGit_RestoresTheCommittedValue()
    {
        var service = TestEditService.EditHandler(_mod.Holder);
        var before = _mod.Index.Sequence;
        Assert.True(service.Set(
            _mod.Plugin, _mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.75").RootElement).Applied);
        Assert.True(await Settles(before));

        var relativePath = _mod.RelativeSourcePath(_mod.Npc, "npc_", IndexedModFixture.NpcEditorId).Replace('\\', '/');
        var afterEdit = _mod.Index.Sequence;
        Git("restore", "--", relativePath);

        Assert.True(await Settles(afterEdit));
        var stack = Index.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString());
        Assert.NotNull(stack);
        var entry = stack.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.NotNull(entry.Effective.Body);
        Assert.DoesNotContain("0.75", entry.Effective.Body, StringComparison.Ordinal);
    }

    // A BOM-carrying rewrite resolves identical to the codec's BOM-free text, so nothing about it
    // ever bumps the sequence — there is no landing to await, only an absence of drift to find.
    [Fact]
    public void ASourceFileRewrittenWithAUtf8Bom_DoesNotSettleAsPerpetualDirt()
    {
        var before = _mod.Index.Sequence;
        var original = File.ReadAllBytes(_mod.NpcSourceFile);
        var bomPrefixed = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(original).ToArray();
        File.WriteAllBytes(_mod.NpcSourceFile, bomPrefixed);

        WaitOutTheWatcher();

        Assert.Equal(before, _mod.Index.Sequence);
        var stack = Index.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString());
        Assert.NotNull(stack);
        var entry = stack.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(entry.Head.Body, entry.Effective.Body);
    }

    // The self-heal a watcher-driven refresh performs is still a mutation as far as _filter's
    // one-shot snapshot is concerned.
    [Fact]
    public async Task AHandEditThatMatchesAnActiveFilter_ReachesTheFilteredListing()
    {
        _mod.Index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'RenamedByHand'");
        var reads = _mod.Index.Reads
            ?? throw new InvalidOperationException("Expected the index to already hold Reads.");
        Assert.Equal(0, reads.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        var before = _mod.Index.Sequence;
        RenameTheNpcByHand("RenamedByHand");

        Assert.True(await Settles(before));
        var result = await FilteredNpcListingReachesOneRow();
        Assert.Equal(1, result.Total);
        Assert.Equal(_mod.Npc.ToString(), result.Items[0].FormKey);
    }

    // The sequence says the projection landed, not that ReapplyFilter's own re-materialization of
    // _filter has finished on the Index's lock — the two are two statements, not one.
    private async Task<PagedResult<RecordSummary>> FilteredNpcListingReachesOneRow()
    {
        var query = new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0);
        var reads = _mod.Index.Reads
            ?? throw new InvalidOperationException("Expected the index to already hold Reads.");
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(15);
        PagedResult<RecordSummary> result;
        do
        {
            result = reads.Search(query);
            if (result.Total > 0) return result;
            await Task.Delay(50);
        } while (DateTime.UtcNow < deadline);
        return result;
    }

    // Renamed with content unchanged: the old path is unreadable at signal time, so the batch is a
    // whole-plugin validate, which finds the FormKey wherever the tree now holds it. No drift, so
    // no sequence bump to await.
    [Fact]
    public void RenamingASourceFileByHand_WithItsContentUnchanged_StillReadsCorrectly()
    {
        var before = _mod.Index.Sequence;
        var originalPath = _mod.NpcSourceFile;
        var renamed = Path.Combine(
            PathShape.DirectoryOf(originalPath), $"SomeOtherName - {_mod.Npc.ID:X6}_{_mod.Npc.ModKey.FileName}.json");

        File.Move(originalPath, renamed);
        WaitOutTheWatcher();

        Assert.Equal(before, _mod.Index.Sequence);
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
        Assert.NotNull(Index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin));
    }

    // Never exclusive owners of the folder (ADR-0007): MO2's Replace install shell-deletes a mod
    // folder, repository and all, under a running backend.
    [Fact]
    public void ADeletedRepository_StopsTheWatch_AndTheModReadsAsUntracked()
    {
        Directory.Delete(Path.Combine(_mod.ModFolder, ".git"), recursive: true);
        WaitOutTheWatcher();
        var before = _mod.Index.Sequence;

        RenameTheNpcByHand("RenamedAfterTheRepositoryWent");
        WaitOutTheWatcher();

        Assert.False(SourceRepository.IsTracked(_mod.ModFolder));
        Assert.False(SourceRepository.IsEditable(IndexedModFixture.ModFolderOrigin, Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName)));
        Assert.Equal(before, _mod.Index.Sequence);
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
    }
}
