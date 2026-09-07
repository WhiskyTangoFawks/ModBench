using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Api;

/// <summary>ADR-0046 invariant 4: a hand edit, a commit and a checkout reach the Index the same way
/// our own writes do. Wired the way the composition root wires it, over a real git working
/// tree.</summary>
public sealed class SourceWatchTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly TrackedModFixture _mod;
    private readonly SourceChangeWatcher _watcher;

    public SourceWatchTests()
    {
        _mod = TrackedModFixture.Tracked(_notifications);
        _watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(100));
        var sourceMirror = new SourceMirror(_mod.Mirror, _watcher, _notifications, NullLogger.Instance);
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
        File.WriteAllText(_mod.NpcSourceFile, text.Replace($"\"{TrackedModFixture.NpcEditorId}\"", $"\"{editorId}\"", StringComparison.Ordinal));
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
        Assert.Equal(TrackedModFixture.NpcEditorId, EditorIdAt(RecordRef.Head));

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

        Assert.Equal(TrackedModFixture.NpcEditorId, await CommittedEditorIdReaches(TrackedModFixture.NpcEditorId));
        Assert.Equal(TrackedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
    }

    // ADR-0046 invariant 4: our own writes are not suppressed, because a refresh that finds the same
    // bytes changes nothing — the push the write already made stands.
    [Fact]
    public async Task AWriteThroughTheWriteApi_IsObserved_AndChangesNoRowASecondTime()
    {
        var service = ProjectingEditService.Over(_mod.Mirror);

        var edit = service.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", System.Text.Json.JsonDocument.Parse("0.75").RootElement);
        Assert.True(edit.Applied);
        var afterTheWrite = _mod.Mirror.Sequence;
        var projectionsAfterTheWrite = _notifications.Notifications.Count;

        WaitOutTheWatcher();

        Assert.Equal(afterTheWrite, _mod.Mirror.Sequence);
        Assert.Equal(projectionsAfterTheWrite, _notifications.Notifications.Count);
        // The watch is live all the same: the next hand edit lands through it.
        RenameTheNpcByHand("RenamedByHand");
        Assert.True(await Settles(afterTheWrite));
        Assert.Equal("RenamedByHand", EditorIdAt(RecordRef.Effective));
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
        Assert.False(ModFolders.IsEditable(TrackedModFixture.ModFolderOrigin, Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName)));
        Assert.Equal(before, _mod.Mirror.Sequence);
        Assert.Equal(TrackedModFixture.NpcEditorId, EditorIdAt(RecordRef.Effective));
    }
}
