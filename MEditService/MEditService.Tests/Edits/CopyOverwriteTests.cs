using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #550 AC7 — the always-overwrite rule, scoped exactly per the Q3 resolution: a Copy as Override
/// whose destination already overrides the <b>explicitly-selected</b> record replaces it without
/// refusal — for the container-copy family only, matching xEdit's own copy-into behavior. A flat
/// record keeps #436's <c>FormKeyCollision</c> refusal, and records incidentally touched by the
/// parent-chain machinery are never overwritten (their own tests live with the parent-chain rules).
/// </summary>
public sealed class CopyOverwriteTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    // The replace is own-fields-only: children the destination's override accumulated (a copied-in
    // placed ref, embedded inline in the cell's document) survive the overwrite.
    [Fact]
    public void CopyAsOverride_OnACellTheDestinationAlreadyOverrides_ReplacesOwnFields_KeepingItsChildren()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin).Applied);
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var cellFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        var cellText = File.ReadAllText(cellFile);
        // Own fields re-copied, and the previously copied-in child still embedded.
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);
        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.NotNull(reads.GetDocument(_fixture.PersistentRef.ToString(), _fixture.DestinationPlugin));
    }

    // The scope boundary: a flat record keeps #436's FormKeyCollision refusal — the overwrite rule
    // is the container-copy family's divergence, not a general one.
    [Fact]
    public void CopyAsOverride_OnAFlatRecordTheDestinationAlreadyOverrides_StillRefuses()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.FlatNpc.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.FlatNpc.ToString(), _fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    // A placed reference is an explicitly-selectable copy target too: re-copying it replaces it in
    // place, at its existing slot position in the destination's cell — never duplicated, never
    // refused.
    [Fact]
    public void CopyAsOverride_OnAPlacedReferenceTheDestinationAlreadyHolds_ReplacesItInPlace()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        var placement = reads.GetPlacement(_fixture.PersistentRef.ToString(), _fixture.DestinationPlugin);
        Assert.NotNull(placement);
        // Still exactly one embedding of the ref in the cell's document.
        var cellFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.PersistentRefEditorId);
        var occurrences = File.ReadAllText(cellFile).Split(ContainerCopyFixture.PersistentRefEditorId).Length - 1;
        Assert.Equal(1, occurrences);
    }

    // #550 AC6's narrow underride refusal: a destination that loads before the record's origin
    // plugin would underride it (#439's territory) — typed refusal, nothing written. Flat and
    // container targets both refuse the same way.
    [Fact]
    public void CopyAsOverride_IntoADestinationThatLoadsBeforeTheOrigin_RefusesAsUnderride()
    {
        using var underrideFixture = ContainerCopyFixture.CreateWithDestinationLoadingFirst();
        var service = new RecordEditService(
            underrideFixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.CopyRecordAsOverride(
            underrideFixture.SourcePlugin, underrideFixture.FlatNpc.ToString(), underrideFixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UnderrideDestination, result.Refusal);
        Assert.Null(underrideFixture.Mirror.Index!.At(RecordRef.Effective)
            .GetDocument(underrideFixture.FlatNpc.ToString(), underrideFixture.DestinationPlugin));
    }

    [Fact]
    public void CopyAsOverride_OnAQuestTheDestinationAlreadyOverrides_ReplacesInsteadOfRefusing()
    {
        var service = EditService();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        var questDoc = reads.GetDocument(_fixture.Quest.ToString(), _fixture.DestinationPlugin);
        Assert.Equal(ContainerCopyFixture.QuestEditorId, questDoc!.EditorId);

        // Replaced in place: still exactly one quest directory, one document row.
        Assert.Single(Directory.EnumerateDirectories(Path.Combine(_fixture.DestinationSourceRoot, "Quests")));
    }
}
