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

    // #550 AC6/Q4 — the batch door: every request validates before anything writes, and one bad
    // request refuses the whole batch as a unit. Nothing lands.
    [Fact]
    public void CopyBatch_WithOneInvalidRequest_RefusesTheWholeBatch_AndNothingLands()
    {
        var outcome = EditService().CopyRecordsBatch(
        [
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.FlatNpc.ToString(), _fixture.DestinationPlugin, AsNewRecord: false),
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin, AsNewRecord: true),
        ]);

        Assert.False(outcome.Applied);
        Assert.Equal(_fixture.InteriorCell.ToString(), outcome.RefusedFormKey);
        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, outcome.Refusal!.Refusal);
        Assert.Empty(outcome.Results);
        // The valid first request never landed either — refuse-or-commit-all.
        Assert.Null(_fixture.Mirror.Index!.At(RecordRef.Effective)
            .GetDocument(_fixture.FlatNpc.ToString(), _fixture.DestinationPlugin));
    }

    // Foreseeable key problems refuse up front, not partially: a caller-typed FormKey requested
    // twice in one batch is caught before anything writes.
    [Fact]
    public void CopyBatch_WithTheSameRequestedFormKeyTwice_RefusesTheWholeBatch()
    {
        var requested = "ABC123:" + ContainerCopyFixture.DestinationPluginName;
        var outcome = EditService().CopyRecordsBatch(
        [
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.FlatNpc.ToString(), _fixture.DestinationPlugin, AsNewRecord: true, requested),
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin, AsNewRecord: true, requested),
        ]);

        Assert.False(outcome.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, outcome.Refusal!.Refusal);
        Assert.Empty(outcome.Results);
        Assert.Null(_fixture.Mirror.Index!.At(RecordRef.Effective)
            .GetDocument(requested, _fixture.DestinationPlugin));
    }

    // The commit-time stop: the pre-validated gate set is exactly the ticket's enumerated three
    // (type, tracked destination, load-order direction) — parent-chain feasibility stays a
    // commit-time answer, so a TopCell ref mid-batch stops the batch there and the response
    // carries the partial landing (ADR-0026): item 1 landed, item 2 refused, nothing after.
    [Fact]
    public void CopyBatch_WithACommitTimeRefusalMidBatch_ReportsThePartialLanding()
    {
        var outcome = EditService().CopyRecordsBatch(
        [
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.FlatNpc.ToString(), _fixture.DestinationPlugin, AsNewRecord: false),
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.TopCellRef.ToString(), _fixture.DestinationPlugin, AsNewRecord: false),
        ]);

        Assert.False(outcome.Applied);
        Assert.Equal(2, outcome.Results.Count);
        Assert.True(outcome.Results[0].Result.Applied);
        Assert.False(outcome.Results[1].Result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerParentMissingInDestination, outcome.Results[1].Result.Refusal);

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.NotNull(reads.GetDocument(_fixture.FlatNpc.ToString(), _fixture.DestinationPlugin));
        Assert.Null(reads.GetDocument(_fixture.TopCellRef.ToString(), _fixture.DestinationPlugin));
    }

    [Fact]
    public void CopyBatch_AllValid_LandsEveryRequest()
    {
        var outcome = EditService().CopyRecordsBatch(
        [
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.FlatNpc.ToString(), _fixture.DestinationPlugin, AsNewRecord: false),
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin, AsNewRecord: false),
            new RecordCopyRequest(_fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin, AsNewRecord: true),
        ]);

        Assert.True(outcome.Applied, outcome.Refusal?.Message);
        Assert.Equal(3, outcome.Results.Count);
        Assert.All(outcome.Results, r => Assert.True(r.Result.Applied, r.Result.Message));

        var reads = _fixture.Mirror.Index!.At(RecordRef.Effective);
        Assert.NotNull(reads.GetDocument(_fixture.FlatNpc.ToString(), _fixture.DestinationPlugin));
        Assert.NotNull(reads.GetDocument(_fixture.InteriorCell.ToString(), _fixture.DestinationPlugin));
        var newQuestKey = outcome.Results[2].Result.NewFormKey!;
        Assert.NotNull(reads.GetDocument(newQuestKey, _fixture.DestinationPlugin));
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
