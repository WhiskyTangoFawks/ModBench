using System.Text;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Records;

/// <summary>A container's document is the only thing a write hands the index; every embedded
/// descendant's row follows from it.</summary>
public sealed class WorkingTreeEmbeddedChildTests : IDisposable
{
    private readonly IndexedContainerFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private IRecordIndex Index =>
        _fixture.Index.Store ?? throw new InvalidOperationException("Expected the index to hold a store.");
    private IRecordReads Effective => Index.At(RecordRef.Effective);
    private IRecordReads Head => Index.At(RecordRef.Head);

    private string CellBody() =>
        Effective.GetDocument(_fixture.EmbedCell.ToString(), _fixture.Plugin).Require().Body.Require();

    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    // The container's document as the write path produces it: read through the codec, changed on the
    // object graph, written back through the codec.
    private string CellBodyAfter(Action<IMajorRecord> change)
    {
        var cell = Codec.DeserializeFromBytesAsync(Encoding.UTF8.GetBytes(CellBody()), GameRelease.Fallout4, "cell")
            .GetAwaiter().GetResult();
        change(cell);
        return Encoding.UTF8.GetString(Codec.SerializeToBytesAsync(cell, GameRelease.Fallout4).GetAwaiter().GetResult());
    }

    [Fact]
    public void ApplyingAContainersDocument_WithAChildHeldAtNeitherRef_CreatesTheChildsRowAndPlacement()
    {
        var newRef = FormKey.Factory($"000F10:{ContainerModFixture.PluginName}");
        var body = CellBodyAfter(cell => ((Cell)cell).Temporary.Add(
            new PlacedObject(newRef, Fallout4Release.Fallout4) { EditorID = "AppendedRef", Position = new P3Float(4f, 5f, 6f) }));

        Index.ProjectDocuments(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), body)]);

        var newDocument = Effective.GetDocument(newRef.ToString(), _fixture.Plugin).Require();
        Assert.Equal("AppendedRef", newDocument.EditorId);
        Assert.Null(Head.GetDocument(newRef.ToString(), _fixture.Plugin));
        var placement = Assert.NotNull(Effective.GetPlacement(newRef.ToString(), _fixture.Plugin));
        Assert.Equal(_fixture.EmbedCell.ToString(), placement.ParentCell);
    }

    [Fact]
    public void ApplyingAContainersDocument_ThatNoLongerCarriesAChild_RemovesTheChildAtEffective_AndKeepsItAtHead()
    {
        var removed = _fixture.TemporaryRef.ToString();
        var body = CellBodyAfter(cell =>
        {
            var target = ((Cell)cell).Temporary.Single(p => p.FormKey.ToString() == removed);
            Assert.True(((Cell)cell).Temporary.Remove(target));
        });

        Index.ProjectDocuments(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), body)]);

        Assert.Null(Effective.GetDocument(removed, _fixture.Plugin));
        Assert.NotNull(Head.GetDocument(removed, _fixture.Plugin));
        Assert.Null(Effective.GetPlacement(removed, _fixture.Plugin));
        // The sibling in the other slot is exactly as it was.
        Assert.NotNull(Effective.GetDocument(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        var persistentPlacement = Assert.NotNull(Effective.GetPlacement(_fixture.PersistentRef.ToString(), _fixture.Plugin));
        Assert.Equal(_fixture.EmbedCell.ToString(), persistentPlacement.ParentCell);
    }

    [Fact]
    public void DeletingAContainer_TakesEveryEmbeddedDescendantWithIt_TwoLevelsDeep()
    {
        Index.ProjectDocuments(_fixture.Plugin, [(_fixture.Worldspace.ToString(), null)]);

        foreach (var formKey in new[] { _fixture.Worldspace, _fixture.TopCell, _fixture.TopCellRef })
        {
            Assert.Null(Effective.GetDocument(formKey.ToString(), _fixture.Plugin));
            Assert.NotNull(Head.GetDocument(formKey.ToString(), _fixture.Plugin));
        }
        Assert.Null(Effective.GetPlacement(_fixture.TopCellRef.ToString(), _fixture.Plugin));
        // A cell in another container is nobody's descendant here.
        Assert.NotNull(Effective.GetDocument(_fixture.TemporaryRef.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void ApplyingAContainersDocument_DerivesTheEmbeddedChildsOwnDocument_AtEffectiveOnly()
    {
        // The two placed refs carry distinct scales, so this substitution reaches exactly TemporaryRef.
        var edited = CellBody().Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal);
        Assert.NotEqual(CellBody(), edited);

        Index.ProjectDocuments(_fixture.Plugin, [(_fixture.EmbedCell.ToString(), edited)]);

        var child = _fixture.TemporaryRef.ToString();
        var effectiveChild = Effective.GetDocument(child, _fixture.Plugin).Require();
        var headChild = Head.GetDocument(child, _fixture.Plugin).Require();
        Assert.Contains("\"Scale\": 2.5", effectiveChild.Body.Require(), StringComparison.Ordinal);
        Assert.DoesNotContain("\"Scale\": 2.5", headChild.Body.Require(), StringComparison.Ordinal);
    }
}
