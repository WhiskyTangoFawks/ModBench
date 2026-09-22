using System.Text;
using MEditService.Codec.Serialization;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Index.Tests.Records;

/// <summary>A container's document is the only thing a write hands the index; every embedded
/// descendant's row follows from it.</summary>
public sealed class WorkingTreeEmbeddedChildTests : IDisposable
{
    private static readonly RecordTextCodec Codec = new(NullLogger<RecordTextCodec>.Instance);

    private readonly IndexedContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private void Project(string formKey, string? body) =>
        _fixture.Index.Project(_fixture.Entry, [(formKey, body)]);

    private string CellBody() => _fixture.Reads.DocumentOf(_fixture.EmbedCell, _fixture.Plugin).BodyOf();

    // The container's document as the write path produces it: read through the codec, changed on the
    // object graph, written back through the codec.
    private string CellBodyAfter(Action<IMajorRecord> change)
    {
        var cell = Codec.DeserializeFromBytes(Encoding.UTF8.GetBytes(CellBody()), GameRelease.Fallout4, "cell");
        change(cell);
        return Encoding.UTF8.GetString(Codec.SerializeToBytes(cell, GameRelease.Fallout4));
    }

    [Fact]
    public void ApplyingAContainersDocument_WithAChildHeldAtNeitherRef_CreatesTheChildsRowAndPlacement()
    {
        var newRef = FormKey.Factory($"000F10:{ContainerMod.PluginName}");
        var body = CellBodyAfter(cell => ((Cell)cell).Temporary.Add(
            new PlacedObject(newRef, Fallout4Release.Fallout4) { EditorID = "AppendedRef", Position = new P3Float(4f, 5f, 6f) }));

        Project(_fixture.EmbedCell, body);

        var newDocument = _fixture.Reads.DocumentOf(newRef.ToString(), _fixture.Plugin);
        Assert.Equal("AppendedRef", newDocument.EditorId);
        var entry = _fixture.Reads.StackEntry(newRef.ToString(), _fixture.Plugin);
        Assert.NotNull(entry);
        Assert.True(entry.HasWorkingTreeChange);
        var placement = Assert.NotNull(_fixture.Reads.GetPlacement(newRef.ToString(), _fixture.Plugin));
        Assert.Equal(_fixture.EmbedCell, placement.ParentCell);
    }

    [Fact]
    public void ApplyingAContainersDocument_ThatNoLongerCarriesAChild_RemovesTheChildAtEffective()
    {
        var removed = _fixture.TemporaryRef;
        var body = CellBodyAfter(cell =>
        {
            var target = ((Cell)cell).Temporary.Single(p => p.FormKey.ToString() == removed);
            Assert.True(((Cell)cell).Temporary.Remove(target));
        });

        Project(_fixture.EmbedCell, body);

        Assert.Null(_fixture.Reads.GetDocument(removed, _fixture.Plugin));
        Assert.Null(_fixture.Reads.GetPlacement(removed, _fixture.Plugin));
        // The sibling in the other slot is exactly as it was.
        Assert.NotNull(_fixture.Reads.GetDocument(_fixture.PersistentRef, _fixture.Plugin));
        var persistentPlacement = Assert.NotNull(_fixture.Reads.GetPlacement(_fixture.PersistentRef, _fixture.Plugin));
        Assert.Equal(_fixture.EmbedCell, persistentPlacement.ParentCell);
    }

    [Fact]
    public void DeletingAContainer_TakesEveryEmbeddedDescendantWithIt_TwoLevelsDeep()
    {
        Project(_fixture.Worldspace, null);

        foreach (var formKey in new[] { _fixture.Worldspace, _fixture.TopCell, _fixture.TopCellRef })
            Assert.Null(_fixture.Reads.GetDocument(formKey, _fixture.Plugin));
        Assert.Null(_fixture.Reads.GetPlacement(_fixture.TopCellRef, _fixture.Plugin));
        // A cell in another container is nobody's descendant here.
        Assert.NotNull(_fixture.Reads.GetDocument(_fixture.TemporaryRef, _fixture.Plugin));
    }

    [Fact]
    public void ApplyingAContainersDocument_DerivesTheEmbeddedChildsOwnDocument_AtEffectiveOnly()
    {
        // The two placed refs carry distinct scales, so this substitution reaches exactly TemporaryRef.
        var edited = CellBody().Replace("\"Scale\": 1.0", "\"Scale\": 2.5", StringComparison.Ordinal);
        Assert.NotEqual(CellBody(), edited);

        Project(_fixture.EmbedCell, edited);

        var effectiveChild = _fixture.Reads.DocumentOf(_fixture.TemporaryRef, _fixture.Plugin);
        var headChild = _fixture.Reads.HeadDocument(_fixture.TemporaryRef, _fixture.Plugin);
        Assert.NotNull(headChild);
        Assert.Contains("\"Scale\": 2.5", effectiveChild.BodyOf(), StringComparison.Ordinal);
        Assert.DoesNotContain("\"Scale\": 2.5", headChild.BodyOf(), StringComparison.Ordinal);
    }
}
