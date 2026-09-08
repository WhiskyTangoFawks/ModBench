using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Api;

/// <summary>ADR-0046 invariant 4: a hand edit, a commit and a checkout reach the Index the same way
/// our own writes do. Wired the way the composition root wires it, over a real git working
/// tree.</summary>
public sealed class SourceWatchTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexedModFixture _mod;
    private readonly SourceChangeWatcher _watcher;

    public SourceWatchTests()
    {
        _mod = IndexedModFixture.Tracked(_notifications);
        _watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(100));
        var sourceMirror = new SourceMirror(_mod.Mirror.Projector, _mod.Mirror.WriteGate, _watcher, _notifications, NullLogger.Instance);
        _watcher.SourceChanged = sourceMirror.Apply;
        _mod.Mirror.LoadOrderChanged = sourceMirror.RefreshWatches;
        // The watch set arrives the way it does in the composition root: the mirror announces the
        // load order it now holds, and every tracked copy in it is watched.
        ((ILoadOrderMirror)_mod.Mirror).Reconcile(_mod.GameDirectory, [_mod.Entry], GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _watcher.Dispose();
        _mod.Dispose();
    }

    private IRecordIndex Index => _mod.Mirror.Index!;

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
        await _mod.Mirror.AwaitSequenceAsync(from + 1, TimeSpan.FromSeconds(15));

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

    [Fact]
    public async Task AHandEditToASourceDocument_LandsInTheIndex_AndNamesItsKeyOnTheRecorder()
    {
        var before = _mod.Mirror.Sequence;

        RenameTheNpcByHand("RenamedByHand");

        Assert.True(await Settles(before));
        Assert.Equal("RenamedByHand", EditorIdAt(RecordRef.Effective));
        Assert.Contains(RowsChanged(), n => n.Plugin == _mod.Plugin && n.Keys.Contains(_mod.Npc.ToString(), StringComparer.Ordinal));
    }

    [Fact]
    public async Task ACommitMadeOutsideModbench_MovesTheCommittedView()
    {
        var before = _mod.Mirror.Sequence;
        RenameTheNpcByHand("RenamedByHand");
        Assert.True(await Settles(before));
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Head));

        var beforeCommit = _mod.Mirror.Sequence;
        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");

        Assert.True(await Settles(beforeCommit));
        Assert.Equal("RenamedByHand", await CommittedEditorIdReaches("RenamedByHand"));
        Assert.Equal("RenamedByHand", EditorIdAt(RecordRef.Effective));
    }

    [Fact]
    public async Task ACheckoutMadeOutsideModbench_MovesTheCommittedViewWithIt()
    {
        var before = _mod.Mirror.Sequence;
        RenameTheNpcByHand("RenamedByHand");
        Assert.True(await Settles(before));
        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");
        Assert.Equal("RenamedByHand", await CommittedEditorIdReaches("RenamedByHand"));

        Git("checkout", "-q", "main");

        Assert.Equal(IndexedModFixture.NpcEditorId, await CommittedEditorIdReaches(IndexedModFixture.NpcEditorId));
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
    }

    // ADR-0046 invariant 4: our own write reaches the Index the way a hand edit does, and a second
    // signal over bytes that already landed changes nothing.
    [Fact]
    public async Task AWriteThroughTheWriteApi_LandsThroughTheWatcher_AndChangesNoRowASecondTime()
    {
        var service = TestEditService.Over(_mod.Mirror);
        var before = _mod.Mirror.Sequence;

        var edit = service.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.75").RootElement);
        Assert.True(edit.Applied);

        Assert.True(await Settles(before));
        Assert.Contains(
            "0.75",
            Index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!,
            StringComparison.Ordinal);
        var afterTheProjection = _mod.Mirror.Sequence;
        var projections = _notifications.Notifications.Count;

        // The same bytes, signalled again: a projection idempotent by content writes no row.
        File.SetLastWriteTimeUtc(_mod.NpcSourceFile, DateTime.UtcNow);
        WaitOutTheWatcher();

        Assert.Equal(afterTheProjection, _mod.Mirror.Sequence);
        Assert.Equal(projections, _notifications.Notifications.Count);
        // The watch is live all the same: the next hand edit lands through it.
        RenameTheNpcByHand("RenamedByHand");
        Assert.True(await Settles(afterTheProjection));
        Assert.Equal("RenamedByHand", EditorIdAt(RecordRef.Effective));
    }

    // The header is a source unit too (ADR-0041, ADR-0005): the watcher's own root is the mod
    // folder, so a hand edit to RecordData.json reaches the index the same way any other document's
    // does.
    [Fact]
    public async Task AHandEditToTheHeaderFile_LandsInTheIndex()
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(_mod.ActualPluginName));
        var headerFile = Path.Combine(_mod.ModFolder, "source", _mod.ActualPluginName, "RecordData.json");
        var before = _mod.Mirror.Sequence;

        var text = File.ReadAllText(headerFile);
        File.WriteAllText(headerFile, text.Replace(
            "\"ModHeader\": {", "\"ModHeader\": {\n    \"Author\": \"RenamedByHand\",", StringComparison.Ordinal));

        Assert.True(await Settles(before));
        Assert.Contains(
            "RenamedByHand",
            Index.At(RecordRef.Effective).GetDocument(headerFormKey, _mod.Plugin)!.Body!,
            StringComparison.Ordinal);
    }

    // The gesture a user makes in the Source Control panel's "Discard Changes" — a working-tree
    // write the watcher sees exactly like a hand edit.
    [Fact]
    public async Task DiscardingAWorkingTreeChangeThroughGit_RestoresTheCommittedValue()
    {
        var service = TestEditService.Over(_mod.Mirror);
        var before = _mod.Mirror.Sequence;
        Assert.True(service.Set(
            _mod.Plugin, _mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.75").RootElement).Applied);
        Assert.True(await Settles(before));

        var relativePath = _mod.RelativeSourcePath(_mod.Npc, "npc_", IndexedModFixture.NpcEditorId).Replace('\\', '/');
        var afterEdit = _mod.Mirror.Sequence;
        Git("restore", "--", relativePath);

        Assert.True(await Settles(afterEdit));
        var entry = Index.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.DoesNotContain("0.75", entry.Effective.Body!, StringComparison.Ordinal);
    }

    // A BOM-carrying rewrite resolves identical to the codec's BOM-free text, so nothing about it
    // ever bumps the sequence — there is no landing to await, only an absence of drift to find.
    [Fact]
    public void ASourceFileRewrittenWithAUtf8Bom_DoesNotSettleAsPerpetualDirt()
    {
        var before = _mod.Mirror.Sequence;
        var original = File.ReadAllBytes(_mod.NpcSourceFile);
        var bomPrefixed = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(original).ToArray();
        File.WriteAllBytes(_mod.NpcSourceFile, bomPrefixed);

        WaitOutTheWatcher();

        Assert.Equal(before, _mod.Mirror.Sequence);
        var entry = Index.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(entry.Head.Body, entry.Effective.Body);
    }

    // The self-heal a watcher-driven refresh performs is still a mutation as far as _filter's
    // one-shot snapshot is concerned.
    [Fact]
    public async Task AHandEditThatMatchesAnActiveFilter_ReachesTheFilteredListing()
    {
        _mod.Mirror.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'RenamedByHand'");
        Assert.Equal(0, _mod.Mirror.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        var before = _mod.Mirror.Sequence;
        RenameTheNpcByHand("RenamedByHand");

        Assert.True(await Settles(before));
        var result = await FilteredNpcListingReachesOneRow();
        Assert.Equal(1, result.Total);
        Assert.Equal(_mod.Npc.ToString(), result.Items[0].FormKey);
    }

    // The sequence says the projection landed, not that ReapplyFilter's own re-materialization of
    // _filter has finished on the mirror's lock — the two are two statements, not one.
    private async Task<PagedResult<RecordSummary>> FilteredNpcListingReachesOneRow()
    {
        var query = new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0);
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(15);
        PagedResult<RecordSummary> result;
        do
        {
            result = _mod.Mirror.Reads!.Search(query);
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
        var before = _mod.Mirror.Sequence;
        var originalPath = _mod.NpcSourceFile;
        var renamed = Path.Combine(
            Path.GetDirectoryName(originalPath)!, $"SomeOtherName - {_mod.Npc.ID:X6}_{_mod.Npc.ModKey.FileName}.json");

        File.Move(originalPath, renamed);
        WaitOutTheWatcher();

        Assert.Equal(before, _mod.Mirror.Sequence);
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
        Assert.NotNull(Index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin));
    }

    // Never exclusive owners of the folder (ADR-0041): MO2's Replace install shell-deletes a mod
    // folder, repository and all, under a running backend.
    [Fact]
    public void ADeletedRepository_StopsTheWatch_AndTheModReadsAsUntracked()
    {
        Directory.Delete(Path.Combine(_mod.ModFolder, ".git"), recursive: true);
        WaitOutTheWatcher();
        var before = _mod.Mirror.Sequence;

        RenameTheNpcByHand("RenamedAfterTheRepositoryWent");
        WaitOutTheWatcher();

        Assert.False(SourceRepository.IsTracked(_mod.ModFolder));
        Assert.False(ModFolders.IsEditable(IndexedModFixture.ModFolderOrigin, Path.Combine(_mod.ModFolder, IndexedModFixture.PluginName)));
        Assert.Equal(before, _mod.Mirror.Sequence);
        Assert.Equal(IndexedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
    }
}
