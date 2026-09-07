using System.Text.Json;
using MEditService.Api;
using MEditService.Bridge;
using MEditService.Core.Edits;
using MEditService.Core.Notifications;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>ADR-0046 invariant 4, for a container and an embedded child: a revert to a quest's or a
/// placed ref's owning cell file reaches the index the same way a flat record's does.</summary>
public sealed class SourceWatchContainerTests : IDisposable
{
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly ContainerModFixture _fixture;
    private readonly SourceChangeWatcher _watcher;

    public SourceWatchContainerTests()
    {
        _fixture = new ContainerModFixture(_notifications);
        _watcher = new SourceChangeWatcher(TimeSpan.FromMilliseconds(100));
        var sourceMirror = new SourceMirror(_fixture.Mirror, _watcher, _notifications, NullLogger.Instance);
        _watcher.SourceChanged = sourceMirror.Apply;
        _fixture.Mirror.LoadOrderChanged = sourceMirror.RefreshWatches;
        // ContainerModFixture's own constructor already reconciled, before any watch could be
        // registered from that reconcile's own signal.
        sourceMirror.RefreshWatches();
    }

    public void Dispose()
    {
        _watcher.Dispose();
        _fixture.Dispose();
    }

    private IRecordQueryService Reads() =>
        new RecordQueryService(_fixture.Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, args);

    private string RelativePath(string absolutePath) => Path.GetRelativePath(_fixture.ModFolder, absolutePath);

    private async Task<bool> Settles(long from) =>
        await _fixture.Mirror.AwaitSequenceAsync(from + 1, TimeSpan.FromSeconds(15));

    [Fact]
    public async Task RevertingAQuestsSourceFile_ReachesTheRecordEditorThroughTheWatcher()
    {
        var service = TestEditService.Over(_fixture.Mirror);
        var file = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);

        var before = _fixture.Mirror.Sequence;
        var applied = service.Set(
            _fixture.Plugin, _fixture.Quest.ToString(), "Filter", JsonDocument.Parse("\"EditedFilter\"").RootElement);
        Assert.True(applied.Applied, applied.Message);
        Assert.True(await Settles(before));
        Assert.Equal(
            "EditedFilter",
            Reads().GetRecord(_fixture.Quest.ToString())!.Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());

        var afterEdit = _fixture.Mirror.Sequence;
        Git("restore", "--", RelativePath(file).Replace('\\', '/'));

        Assert.True(await Settles(afterEdit));
        Assert.NotEqual(
            "EditedFilter",
            Reads().GetRecord(_fixture.Quest.ToString())!.Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());
    }

    [Fact]
    public async Task RevertingAPlacedRefsOwningCellFile_ReachesTheRecordEditorThroughTheWatcher()
    {
        var service = TestEditService.Over(_fixture.Mirror);
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);

        var before = _fixture.Mirror.Sequence;
        var applied = service.Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", JsonDocument.Parse("2.5").RootElement);
        Assert.True(applied.Applied, applied.Message);
        Assert.True(await Settles(before));
        Assert.Equal(
            2.5f,
            Assert.IsType<JsonElement>(
                Reads().GetRecord(_fixture.TemporaryRef.ToString())!.Fields.Single(f => f.Metadata.Name == "Scale").Value).GetSingle());

        var afterEdit = _fixture.Mirror.Sequence;
        Git("restore", "--", RelativePath(file).Replace('\\', '/'));

        Assert.True(await Settles(afterEdit));
        Assert.NotEqual(
            2.5f,
            (Reads().GetRecord(_fixture.TemporaryRef.ToString())!.Fields.Single(f => f.Metadata.Name == "Scale").Value as JsonElement?)?.GetSingle());
    }
}
