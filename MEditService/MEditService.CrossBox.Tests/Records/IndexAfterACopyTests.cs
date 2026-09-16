using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Queries;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

/// <summary>ADR-0014: a copy writes trees and nothing else, so what the Index serves afterwards is
/// what a projection of those trees made of it. Read here, never in the copy suites.</summary>
public sealed class IndexAfterACopyTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();
    private readonly LoadOrderHolder _holder = new();
    private readonly IndexProjector _index;

    public IndexAfterACopyTests()
    {
        _index = new IndexProjector(
            _holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        _index.Reconcile(_holder, _fixture.GameDirectory, _fixture.Entries, GameRelease.Fallout4);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private ProjectingEditService Service() => ProjectingEditService.Over(_index, _holder);

    // A brand-new row must be evaluated against an active filter's one-shot snapshot, or the copy
    // lands and the listing never shows it.
    [Fact]
    public void ACopiedOverride_AppearsInAnActiveFilteredListing()
    {
        _index.SetFilter($"SELECT form_key FROM npc_ WHERE plugin = '{ContainerCopyFixture.DestinationPluginName}'");
        var query = new RecordQuery(RecordTypes: ["npc_"], Plugin: _fixture.DestinationPlugin.Name, Origin: _fixture.DestinationPlugin.Origin, Limit: 50, Offset: 0);
        var before = _index.SettledReads().Search(query).Total;

        var result = Service().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.FlatNpc.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(before + 1, _index.SettledReads().Search(query).Total);
    }

    // The spatial mint writes directories rather than one document, and its rows reach the filter by
    // the same route.
    [Fact]
    public void ACopiedExteriorCell_AppearsInAnActiveFilteredListing()
    {
        // Scoped to the destination plugin: the source already holds a "cell" row under this FormKey, so
        // an unscoped filter would match pre-copy and pass whether or not the new row was re-evaluated.
        _index.SetFilter($"SELECT form_key FROM cell WHERE plugin = '{ContainerCopyFixture.DestinationPluginName}'");
        var query = new RecordQuery(RecordTypes: ["cell"], Plugin: _fixture.DestinationPlugin.Name, Origin: _fixture.DestinationPlugin.Origin, Limit: 50, Offset: 0);
        var before = _index.SettledReads().Search(query).Total;

        var result = Service().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(before + 1, _index.SettledReads().Search(query).Total);
    }

    // Block and sub-block are the directories the mint wrote and the grid is a field the mint carried
    // into the cell's document; the projector re-derives the row from both.
    [Fact]
    public void AMintedExteriorCell_GetsTheSourceCellsOwnLocationRow()
    {
        var result = Service().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorPersistentRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(result.Applied, result.Message);

        var reads = _index.Projected();
        var source = reads.GetCellLocation(_fixture.SourcePlugin, _fixture.ExteriorCell.ToString())
            ?? throw new InvalidOperationException("Expected the source exterior cell to carry a location row.");
        var minted = reads.GetCellLocation(_fixture.DestinationPlugin, _fixture.ExteriorCell.ToString())
            ?? throw new InvalidOperationException("Expected the minted exterior cell to carry a location row.");
        Assert.Equal(
            (source.ParentWorldspace, source.BlockX, source.BlockY, source.SubX, source.SubY, source.IsInterior),
            (minted.ParentWorldspace, minted.BlockX, minted.BlockY, minted.SubX, minted.SubY, minted.IsInterior));
        Assert.Equal(ContainerCopyFixture.ExteriorGridX, minted.GridX);
        Assert.Equal(ContainerCopyFixture.ExteriorGridY, minted.GridY);
    }

    // The slot a copied reference lands in reaches the placement row, so the worldspace tree shows it
    // where the source has it.
    [Fact]
    public void ACopiedTemporaryPlacedReference_GetsATemporaryPlacementRow()
    {
        var result = Service().CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.ExteriorTemporaryRef.ToString(), _fixture.DestinationPlugin);
        Assert.True(result.Applied, result.Message);

        Assert.Equal(
            "temporary",
            _index.Projected().GetPlacement(_fixture.ExteriorTemporaryRef.ToString(), _fixture.DestinationPlugin)
                ?.PlacementGroup);
    }

    // A copy as new record lands a whole embedded subtree in one document; the projector derives a
    // container_child row per re-keyed descendant.
    [Fact]
    public void ACopiedDialogTopic_GetsAContainerChildRowPerReKeyedResponse()
    {
        var result = Service().CopyRecordAsNewRecord(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);
        Assert.True(result.Applied, result.Message);

        var newFormKey = result.NewFormKey
            ?? throw new InvalidOperationException("Expected the dialog topic copy to report its new form key.");
        var reads = _index.Projected();
        var children = reads.GetContainerChildren(_fixture.DestinationPlugin, newFormKey);
        Assert.Equal(2, children.Count);
        Assert.Equal(
            [ContainerCopyFixture.Response1EditorId, ContainerCopyFixture.Response2EditorId],
            children.OrderBy(c => c.SlotIndex)
                .Select(c => reads.GetDocument(c.ChildFormKey, _fixture.DestinationPlugin) is { EditorId: { } editorId }
                    ? editorId
                    : throw new InvalidOperationException(
                        $"Expected the copied child {c.ChildFormKey} to resolve to a document with an EditorID."))
                .ToArray());
        Assert.DoesNotContain(_fixture.Response1.ToString(), children.Select(c => c.ChildFormKey));
    }
}
