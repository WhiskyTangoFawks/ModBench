using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Tests.TestSupport;

namespace MEditService.Tests.Edits;

/// <summary>The always-overwrite rule is scoped to the container-copy family (xEdit's copy-into
/// behavior); a flat record keeps the <c>FormKeyCollision</c> refusal.</summary>
public sealed class CopyOverwriteTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private CopyRecordAsOverrideHandler CopyHandler() => _fixture.CopyAsOverrideHandler;

    // The replace is own-fields-only: children the destination's override accumulated (a copied-in
    // placed ref, embedded inline in the cell's document) survive the overwrite.
    [Fact]
    public void CopyAsOverride_OnACellTheDestinationAlreadyOverrides_ReplacesOwnFields_KeepingItsChildren()
    {
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin).Applied);
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var cellFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        var cellText = File.ReadAllText(cellFile);
        // Own fields re-copied, and the copied-in child still embedded.
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.NotNull(_fixture.Document(_fixture.DestinationPlugin, _fixture.PersistentRef.ToString()));
    }

    // The scope boundary: a flat record keeps the FormKeyCollision refusal — the overwrite rule
    // is the container-copy family's divergence, not a general one.
    [Fact]
    public void CopyAsOverride_OnAFlatRecordTheDestinationAlreadyOverrides_StillRefuses()
    {
        var service = CopyHandler();
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
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_fixture.Document(_fixture.DestinationPlugin, _fixture.PersistentRef.ToString()));
        // Still exactly one embedding of the ref in the cell's document.
        var cellFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.PersistentRefEditorId);
        var occurrences = File.ReadAllText(cellFile).Split(ContainerCopyFixture.PersistentRefEditorId).Length - 1;
        Assert.Equal(1, occurrences);
    }

    // The narrow underride refusal: a destination that loads before the record's origin plugin
    // would underride it — typed refusal, nothing written. Flat and container targets both refuse
    // the same way.
    [Fact]
    public void CopyAsOverride_IntoADestinationThatLoadsBeforeTheOrigin_RefusesAsUnderride()
    {
        using var underrideFixture = ContainerCopyFixture.CreateWithDestinationLoadingFirst();

        var result = underrideFixture.CopyAsOverrideHandler.CopyRecordAsOverride(
            underrideFixture.SourcePlugin, underrideFixture.FlatNpc.ToString(), underrideFixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UnderrideDestination, result.Refusal);
        Assert.Null(underrideFixture.Document(
            underrideFixture.DestinationPlugin, underrideFixture.FlatNpc.ToString()));
    }

    // The embedded-child half of the same rule: the topic has no document of its own, and the
    // response already appended into it survives the topic's own re-copy.
    [Fact]
    public void CopyAsOverride_OnATopicTheDestinationAlreadyHoldsEmbedded_ReplacesOwnFields_KeepingItsResponse()
    {
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin).Applied);
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Response1.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var topic = _fixture.Document(_fixture.DestinationPlugin, _fixture.DialogTopic.ToString());
        Assert.NotNull(topic);
        Assert.Equal(
            _fixture.Response1.ToString(),
            Assert.Single(JsonDocument.Parse(topic.Require().Body).RootElement.GetProperty("Responses").EnumerateArray())
                .GetProperty("FormKey").GetString());
    }

    [Fact]
    public void CopyAsOverride_OnAQuestTheDestinationAlreadyOverrides_ReplacesInsteadOfRefusing()
    {
        var service = CopyHandler();
        Assert.True(service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyRecordAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin);

        Assert.True(result.Applied, result.Message);

        var questDocument = _fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, questDocument.Require().EditorId);

        // Replaced in place: still exactly one quest file, one document row.
        Assert.Single(
            Directory.EnumerateFiles(Path.Combine(_fixture.DestinationSourceRoot, "Quests")),
            f => Path.GetFileName(f) != "GroupRecordData.json");
    }
}
