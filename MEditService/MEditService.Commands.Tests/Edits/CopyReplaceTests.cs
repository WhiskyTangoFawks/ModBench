using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyReplaceTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private CopyRecordChangesHandler CopyHandler() => _fixture.CopyHandler;

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void CopyAsOverride_OnAFlatRecordTheDestinationHolds_WithoutReplace_IsRefusedNamingTheDestination_AndWritesNothing()
    {
        var service = CopyHandler();
        var flatNpc = _fixture.FlatNpc.ToString();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, flatNpc)], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();
        Assert.True(_fixture.EditHandler.Set(_fixture.DestinationPlugin, flatNpc, "HeightMax", Json("0.75")).Applied);
        var held = _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body;

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, flatNpc)], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, refused.Refusal);
        Assert.Contains(ContainerCopyFixture.DestinationPluginName, refused.Message, StringComparison.Ordinal);
        Assert.Equal(held, _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body);
    }

    [Fact]
    public void CopyAsOverride_OnAFlatRecordTheDestinationHolds_WithReplace_WritesTheSourcesCopyOverIt()
    {
        var service = CopyHandler();
        var flatNpc = _fixture.FlatNpc.ToString();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, flatNpc)], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();
        var copied = _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body;
        Assert.True(_fixture.EditHandler.Set(_fixture.DestinationPlugin, flatNpc, "HeightMax", Json("0.75")).Applied);

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, flatNpc)], CopyMode.Override, [_fixture.DestinationPlugin], replace: true);

        result.OnlyLanded();
        Assert.Equal(copied, _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body);
    }

    [Fact]
    public void CopyAsOverride_OnACellTheDestinationHolds_WithoutReplace_IsRefused()
    {
        var service = CopyHandler();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.InteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.InteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, refused.Refusal);
    }

    [Fact]
    public void CopyAsOverride_OnACellTheDestinationHolds_WithReplace_ReplacesOwnFields_KeepingItsChildren()
    {
        var service = CopyHandler();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.InteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.PersistentRef.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.InteriorCell.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: true);

        result.OnlyLanded();
        var cellText = _fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.InteriorCellEditorId).Body;
        Assert.Contains(ContainerCopyFixture.PersistentRefEditorId, cellText, StringComparison.Ordinal);
        Assert.NotNull(_fixture.Document(_fixture.DestinationPlugin, _fixture.PersistentRef.ToString()));
    }

    [Fact]
    public void CopyAsOverride_OnAPlacedReferenceTheDestinationHolds_WithoutReplace_IsRefused()
    {
        var service = CopyHandler();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.PersistentRef.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.PersistentRef.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, refused.Refusal);
    }

    [Fact]
    public void CopyAsOverride_OnAPlacedReferenceTheDestinationHolds_WithReplace_ReplacesItInPlace()
    {
        var service = CopyHandler();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.PersistentRef.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.PersistentRef.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: true);

        result.OnlyLanded();
        Assert.NotNull(_fixture.Document(_fixture.DestinationPlugin, _fixture.PersistentRef.ToString()));
        var occurrences = _fixture.DocumentCarrying(_fixture.DestinationPlugin, ContainerCopyFixture.PersistentRefEditorId).Body.Split(ContainerCopyFixture.PersistentRefEditorId).Length - 1;
        Assert.Equal(1, occurrences);
    }

    [Fact]
    public void CopyAsOverride_IntoADestinationThatLoadsBeforeTheOrigin_RefusesAsUnderride()
    {
        using var underrideFixture = ContainerCopyFixture.CreateWithDestinationLoadingFirst();

        var result = underrideFixture.CopyHandler.CopySync([new RecordAt(underrideFixture.SourcePlugin, underrideFixture.FlatNpc.ToString())], CopyMode.Override, [underrideFixture.DestinationPlugin], replace: false);

        var refused = result.OnlyRefused();
        Assert.Equal(RecordEditRefusal.UnderrideDestination, refused.Refusal);
        Assert.Null(underrideFixture.Document(
            underrideFixture.DestinationPlugin, underrideFixture.FlatNpc.ToString()));
    }

    [Fact]
    public void CopyAsOverride_OnATopicTheDestinationHoldsEmbedded_WithReplace_ReplacesOwnFields_KeepingItsResponse()
    {
        var service = CopyHandler();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.DialogTopic.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Response1.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.DialogTopic.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: true);

        result.OnlyLanded();
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
        service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Quest.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: false).OnlyLanded();

        var result = service.CopySync([new RecordAt(_fixture.SourcePlugin, _fixture.Quest.ToString())], CopyMode.Override, [_fixture.DestinationPlugin], replace: true);

        result.OnlyLanded();
        var questDocument = _fixture.Document(_fixture.DestinationPlugin, _fixture.Quest.ToString());
        Assert.Equal(ContainerCopyFixture.QuestEditorId, questDocument.Require().EditorId);
    }
}
