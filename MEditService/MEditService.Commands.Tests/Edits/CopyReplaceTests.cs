using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyReplaceTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private CopyRecordHandler CopyHandler() => _fixture.CopyHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void CopyAsOverride_OnAFlatRecordTheDestinationHolds_WithoutReplace_IsRefusedNamingTheDestination_AndWritesNothing()
    {
        var service = CopyHandler();
        var flatNpc = _fixture.FlatNpc.ToString();
        Assert.True(service.CopyAsOverride(_fixture.SourcePlugin, flatNpc, _fixture.DestinationPlugin).Applied);
        Assert.True(_fixture.EditHandler.Set(_fixture.DestinationPlugin, flatNpc, "HeightMax", Json("0.75")).Applied);
        var held = _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body;

        var result = service.CopyAsOverride(_fixture.SourcePlugin, flatNpc, _fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
        Assert.Contains(ContainerCopyFixture.DestinationPluginName, result.Message, StringComparison.Ordinal);
        Assert.Equal(held, _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body);
    }

    [Fact]
    public void CopyAsOverride_OnAFlatRecordTheDestinationHolds_WithReplace_WritesTheSourcesCopyOverIt()
    {
        var service = CopyHandler();
        var flatNpc = _fixture.FlatNpc.ToString();
        Assert.True(service.CopyAsOverride(_fixture.SourcePlugin, flatNpc, _fixture.DestinationPlugin).Applied);
        var copied = _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body;
        Assert.True(_fixture.EditHandler.Set(_fixture.DestinationPlugin, flatNpc, "HeightMax", Json("0.75")).Applied);

        var result = service.CopyAsOverride(_fixture.SourcePlugin, flatNpc, _fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(copied, _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body);
    }

    [Fact]
    public void CopyAsOverride_OnACellTheDestinationHolds_WithoutReplace_IsRefused()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
    }

    [Fact]
    public void CopyAsOverride_OnACellTheDestinationHolds_WithReplace_ReplacesOwnFields_KeepingItsChildren()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin).Applied);
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.InteriorCell.ToString(), _fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        var cellFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.InteriorCellEditorId);
        var cellText = File.ReadAllText(cellFile);
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.NotNull(_fixture.Document(_fixture.DestinationPlugin, _fixture.PersistentRef.ToString()));
    }

    [Fact]
    public void CopyAsOverride_OnAPlacedReferenceTheDestinationHolds_WithoutReplace_IsRefused()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, result.Refusal);
    }

    [Fact]
    public void CopyAsOverride_OnAPlacedReferenceTheDestinationHolds_WithReplace_ReplacesItInPlace()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.PersistentRef.ToString(), _fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(_fixture.Document(_fixture.DestinationPlugin, _fixture.PersistentRef.ToString()));
        var cellFile = _fixture.DestinationSourceFileContaining(ContainerCopyFixture.PersistentRefEditorId);
        var occurrences = File.ReadAllText(cellFile).Split(ContainerCopyFixture.PersistentRefEditorId).Length - 1;
        Assert.Equal(1, occurrences);
    }

    [Fact]
    public void CopyAsOverride_IntoADestinationThatLoadsBeforeTheOrigin_RefusesAsUnderride()
    {
        using var underrideFixture = ContainerCopyFixture.CreateWithDestinationLoadingFirst();

        var result = underrideFixture.CopyHandler.CopyAsOverride(
            underrideFixture.SourcePlugin, underrideFixture.FlatNpc.ToString(), underrideFixture.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UnderrideDestination, result.Refusal);
        Assert.Null(underrideFixture.Document(
            underrideFixture.DestinationPlugin, underrideFixture.FlatNpc.ToString()));
    }

    [Fact]
    public void CopyAsOverride_OnATopicTheDestinationHoldsEmbedded_WithReplace_ReplacesOwnFields_KeepingItsResponse()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin).Applied);
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.Response1.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.DialogTopic.ToString(), _fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        var topic = _fixture.Document(_fixture.DestinationPlugin, _fixture.DialogTopic.ToString());
        Assert.NotNull(topic);
        Assert.Equal(
            _fixture.Response1.ToString(),
            Assert.Single(JsonDocument.Parse(topic.Require().Body).RootElement.GetProperty("Responses").EnumerateArray())
                .GetProperty("FormKey").GetString());
    }

    [Fact]
    public void CopyAsOverride_OnAQuestTheDestinationHolds_WithReplace_ReplacesItInPlace()
    {
        var service = CopyHandler();
        Assert.True(service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin).Applied);

        var result = service.CopyAsOverride(
            _fixture.SourcePlugin, _fixture.Quest.ToString(), _fixture.DestinationPlugin, replace: true);

        Assert.True(result.Applied, result.Message);
        var questDocument = _fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, questDocument.Require().EditorId);
        Assert.Single(
            Directory.EnumerateFiles(Path.Combine(_fixture.DestinationSourceRoot, "Quests")),
            f => Path.GetFileName(f) != "GroupRecordData.json");
    }
}
