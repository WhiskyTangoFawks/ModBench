using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class WorkingTreeEmbeddedChildTests : IDisposable
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private readonly IndexedContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private void Project(string formKey, string? body) =>
        _fixture.Index.Project(_fixture.Entry, [(formKey, body)]);

    private string CellBody() => _fixture.Reads.DocumentOf(_fixture.EmbedCell, _fixture.Plugin).BodyOf();

    private string CellBodyAfterCodecRoundTripThrough(Action<JsonArray> changeTemporaryRefs)
    {
        var cell = JsonNode.Parse(CellBody())?.AsObject() ?? throw new InvalidOperationException("Expected the cell's body to be an object.");
        changeTemporaryRefs(cell["Temporary"]?.AsArray() ?? throw new InvalidOperationException("Expected the cell to hold temporary refs."));
        return Codec.RoundTrip(cell.ToJsonString(), GameRelease.Fallout4, "cell");
    }

    [Fact]
    public void ApplyingAContainersDocument_WithAChildHeldAtNeitherRef_CreatesTheChildsRowAndPlacement()
    {
        var newRef = FormKey.Factory($"000F10:{ContainerMod.PluginName}");
        var body = CellBodyAfterCodecRoundTripThrough(temporary =>
        {
            var appended = (temporary[0]?.DeepClone().AsObject()) ?? throw new InvalidOperationException("Expected a temporary ref to copy.");
            appended["FormKey"] = newRef.ToString();
            appended["EditorID"] = "AppendedRef";
            temporary.Add(appended);
        });

        Project(_fixture.EmbedCell, body);

        var newDocument = _fixture.Reads.DocumentOf(newRef.ToString(), _fixture.Plugin);
        Assert.Equal("AppendedRef", newDocument.EditorId);
        var entry = _fixture.Reads.StackEntry(newRef.ToString(), _fixture.Plugin);
        Assert.NotNull(entry);
        Assert.True(entry.HasWorkingTreeChange);
        Assert.Equal("temporary", _fixture.Reads.PlacementGroupIn(_fixture.Plugin, _fixture.EmbedCell, newRef.ToString()));
    }

    [Fact]
    public void ApplyingAContainersDocument_ThatNoLongerCarriesAChild_RemovesTheChildAtEffective()
    {
        var removed = _fixture.TemporaryRef;
        var body = CellBodyAfterCodecRoundTripThrough(temporary =>
        {
            var target = temporary.Single(placed => placed?["FormKey"]?.GetValue<string>() == removed);
            Assert.True(temporary.Remove(target));
        });

        Project(_fixture.EmbedCell, body);

        Assert.Null(_fixture.Reads.GetDocument(removed, _fixture.Plugin));
        Assert.Null(_fixture.Reads.PlacementGroupIn(_fixture.Plugin, _fixture.EmbedCell, removed));
        var siblingInTheOtherSlot = _fixture.PersistentRef;
        Assert.NotNull(_fixture.Reads.GetDocument(siblingInTheOtherSlot, _fixture.Plugin));
        Assert.Equal("persistent", _fixture.Reads.PlacementGroupIn(_fixture.Plugin, _fixture.EmbedCell, siblingInTheOtherSlot));
    }

    [Fact]
    public void DeletingAContainer_TakesEveryEmbeddedDescendantWithIt_TwoLevelsDeep()
    {
        Project(_fixture.Worldspace, null);

        foreach (var formKey in new[] { _fixture.Worldspace, _fixture.TopCell, _fixture.TopCellRef })
            Assert.Null(_fixture.Reads.GetDocument(formKey, _fixture.Plugin));
        var refInAnotherContainer = _fixture.TemporaryRef;
        Assert.NotNull(_fixture.Reads.GetDocument(refInAnotherContainer, _fixture.Plugin));
    }

    [Fact]
    public void ApplyingAContainersDocument_DerivesTheEmbeddedChildsOwnDocument()
    {
        var scaleEditReachingOnlyTemporaryRefBecauseThePlacedRefsCarryDistinctScales =
            CellBody().Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal);
        Assert.NotEqual(CellBody(), scaleEditReachingOnlyTemporaryRefBecauseThePlacedRefsCarryDistinctScales);

        Project(_fixture.EmbedCell, scaleEditReachingOnlyTemporaryRefBecauseThePlacedRefsCarryDistinctScales);

        var effectiveChild = _fixture.Reads.DocumentOf(_fixture.TemporaryRef, _fixture.Plugin);
        Assert.Contains("\"Scale\": 2.5", effectiveChild.BodyOf(), StringComparison.Ordinal);
    }
}
