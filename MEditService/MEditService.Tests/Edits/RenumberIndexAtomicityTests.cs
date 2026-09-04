using MEditService.Core.Records;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>A renumber's index update commits once or not at all (#677). The fault is real, not
/// injected: a body the declared record type cannot parse throws after its own insert is written.
/// Reader isolation is not claimed.</summary>
public sealed class RenumberIndexAtomicityTests : IDisposable
{
    // Free at both refs in ContainerModFixture's plugin.
    private static readonly string NewFormKey =
        FormKey.Factory($"000F00:{ContainerModFixture.PluginName}").ToString();

    // Valid JSON, and nothing the codec can rebuild a record from.
    private const string UnparseableBody = """{ "not": "a record" }""";

    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private IRecordIndex Index => _fixture.Mirror.Index!;
    private IRecordReads Effective => Index.At(RecordRef.Effective);

    [Fact]
    public void AFaultInsideRenumbersCreateStep_LeavesNoRowForTheNewIdentity()
    {
        var quest = _fixture.Quest.ToString();
        var before = Snapshot(quest);

        Assert.ThrowsAny<Exception>(() => Index.ApplyRenumber(
            _fixture.Plugin,
            new RenumberedRecord(quest, NewFormKey, RecordTypeOf(quest), UnparseableBody)));

        Assert.Null(Effective.GetDocument(NewFormKey, _fixture.Plugin));
        Assert.Null(Index.At(RecordRef.Head).GetDocument(NewFormKey, _fixture.Plugin));
        Assert.Equal(before, Snapshot(quest));
    }

    [Fact]
    public void AFaultInsideRenumbersCreateStep_AlsoUndoesTheOwnerRowWrittenBeforeIt()
    {
        var placedRef = _fixture.TemporaryRef.ToString();
        var owner = _fixture.EmbedCell.ToString();
        var ownerBefore = Effective.GetDocument(owner, _fixture.Plugin)!.Body!;

        // A different but still parseable owner document, so "the owner's row did not move" is a
        // claim with something to distinguish it from "the owner's row was never asked to move".
        var ownerAfter = ownerBefore.Replace(
            ContainerModFixture.TemporaryRefEditorId, "TempRefRenamed", StringComparison.Ordinal);
        Assert.NotEqual(ownerBefore, ownerAfter);

        Assert.ThrowsAny<Exception>(() => Index.ApplyRenumber(
            _fixture.Plugin,
            new RenumberedRecord(
                placedRef, NewFormKey, RecordTypeOf(placedRef), UnparseableBody,
                new EmbeddingOwner(owner, ownerAfter))));

        Assert.Equal(ownerBefore, Effective.GetDocument(owner, _fixture.Plugin)!.Body);
        Assert.Null(Effective.GetDocument(NewFormKey, _fixture.Plugin));
        Assert.NotNull(Effective.GetDocument(placedRef, _fixture.Plugin));
    }

    private string RecordTypeOf(string formKey) =>
        Effective.GetDocument(formKey, _fixture.Plugin)!.RecordType;

    private string Snapshot(string formKey) =>
        $"{Effective.GetDocument(formKey, _fixture.Plugin)?.Body ?? "absent"}\n" +
        string.Join(",", Effective.GetContainerChildren(_fixture.Plugin, formKey)
            .Select(c => $"{c.SlotName}[{c.SlotIndex}]={c.ChildFormKey}")
            .OrderBy(s => s, StringComparer.Ordinal));
}
