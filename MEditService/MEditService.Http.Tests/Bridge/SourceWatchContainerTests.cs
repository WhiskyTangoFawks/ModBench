using System.Text.Json;
using MEditService.Queries;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using MEditService.Watcher;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Bridge;

/// <summary>ADR-0015 invariant 2, for a container and an embedded child: a revert to a quest's or a
/// placed ref's owning cell file reaches the index the same way a flat record's does.</summary>
public sealed class SourceWatchContainerTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly IndexedContainerFixture _fixture;
    private readonly ModFolderWatcher _watcher;

    public SourceWatchContainerTests()
    {
        _fixture = new IndexedContainerFixture(_notifications);
        _watcher = TestWatcher.Over(_fixture.Holder, _fixture.Index, _notifications, TimeSpan.FromMilliseconds(100));
        // The fixture's own constructor already reconciled, so the re-arm the load-order endpoint
        // would have made is made here.
        _watcher.Rearm(_fixture.Holder.Current);
    }

    public void Dispose()
    {
        _watcher.Dispose();
        _fixture.Dispose();
    }

    private IRecordQueryService Reads() =>
        new RecordQueryService(_fixture.Index, _fixture.Holder, SharedSchemaReflector.Instance, new ConflictClassifier());

    private void Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, args);

    private string RelativePath(string absolutePath) => Path.GetRelativePath(_fixture.ModFolder, absolutePath);

    private async Task<bool> Settles(long from) =>
        await _fixture.Index.AwaitSequenceAsync(from + 1, TimeSpan.FromSeconds(15));

    [Fact]
    public async Task RevertingAQuestsSourceFile_ReachesTheRecordEditorThroughTheWatcher()
    {
        var service = TestEditService.EditHandler(_fixture.Holder);
        var file = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);

        var before = _fixture.Index.Sequence;
        var applied = service.Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Filter", JsonDocument.Parse("\"EditedFilter\"").RootElement);
        Assert.True(applied.Applied, applied.Message);
        Assert.True(await Settles(before));
        var edited = Reads().GetRecord(_fixture.Quest.ToString());
        Assert.NotNull(edited);
        Assert.Equal(
            "EditedFilter",
            edited.Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());

        var afterEdit = _fixture.Index.Sequence;
        Git("restore", "--", RelativePath(file).Replace('\\', '/'));

        Assert.True(await Settles(afterEdit));
        var reverted = Reads().GetRecord(_fixture.Quest.ToString());
        Assert.NotNull(reverted);
        Assert.NotEqual(
            "EditedFilter",
            reverted.Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());
    }

    [Fact]
    public async Task RevertingAPlacedRefsOwningCellFile_ReachesTheRecordEditorThroughTheWatcher()
    {
        var service = TestEditService.EditHandler(_fixture.Holder);
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);

        var before = _fixture.Index.Sequence;
        var applied = service.Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", JsonDocument.Parse("2.5").RootElement);
        Assert.True(applied.Applied, applied.Message);
        Assert.True(await Settles(before));
        var edited = Reads().GetRecord(_fixture.TemporaryRef.ToString());
        Assert.NotNull(edited);
        Assert.Equal(
            2.5f,
            Assert.IsType<JsonElement>(edited.Fields.Single(f => f.Metadata.Name == "Scale").Value).GetSingle());

        var afterEdit = _fixture.Index.Sequence;
        Git("restore", "--", RelativePath(file).Replace('\\', '/'));

        Assert.True(await Settles(afterEdit));
        var reverted = Reads().GetRecord(_fixture.TemporaryRef.ToString());
        Assert.NotNull(reverted);
        Assert.NotEqual(
            2.5f,
            (reverted.Fields.Single(f => f.Metadata.Name == "Scale").Value as JsonElement?)?.GetSingle());
    }
}
