using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class CopyReplaceTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private CopyRecordResult CopyAsOverride(bool replace, params FormKey[] records) =>
        _fixture.CopyHandler.CopySync(
            [.. records.Select(record => new RecordAt(_fixture.SourcePlugin, record.ToString()))], CopyMode.Override, [_fixture.DestinationPlugin], replace);

    [Fact]
    public void CopyAsOverride_OnARecordTheDestinationHolds_WithoutReplace_IsRefusedNamingTheDestination_AndWritesNothing()
    {
        var flatNpc = _fixture.FlatNpc.ToString();
        CopyAsOverride(replace: false, _fixture.FlatNpc).OnlyLanded();
        Assert.True(_fixture.EditHandler.Set(_fixture.DestinationPlugin, flatNpc, "HeightMax", Json("0.75")).Applied);
        var held = _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body;

        var refused = CopyAsOverride(replace: false, _fixture.FlatNpc).OnlyRefused();

        Assert.Equal(RecordEditRefusal.DestinationHoldsRecord, refused.Refusal);
        Assert.Contains(ContainerCopyFixture.DestinationPluginName, refused.Message, StringComparison.Ordinal);
        Assert.Equal(held, _fixture.Document(_fixture.DestinationPlugin, flatNpc).Require().Body);
    }

    public static TheoryData<string, Func<ContainerCopyFixture, FormKey[]>, string, string, string> HeldRecords => new()
    {
        { "a flat record", f => [f.FlatNpc], ContainerCopyFixture.FlatNpcEditorId, "HeightMax", "0.75" },
        { "an interior cell, holding a reference copied in", f => [f.InteriorCell, f.PersistentRef], ContainerCopyFixture.InteriorCellEditorId, "WaterHeight", "7.0" },
        { "a placed reference", f => [f.PersistentRef], ContainerCopyFixture.PersistentRefEditorId, "Scale", "2.5" },
        { "a topic in its quest's document, holding a response copied in", f => [f.DialogTopic, f.Response1], ContainerCopyFixture.QuestEditorId, "Priority", "7.0" },
        { "a quest", f => [f.Quest], ContainerCopyFixture.QuestEditorId, "Name", "\"Edited\"" },
    };

    [Theory]
    [MemberData(nameof(HeldRecords))]
    public void CopyAsOverride_OnARecordTheDestinationHolds_WithReplace_WritesTheSourcesCopyBackInPlace_KeepingWhatItHolds(
        string _, Func<ContainerCopyFixture, FormKey[]> copiedIn, string carrierEditorId, string member, string edit)
    {
        var record = copiedIn(_fixture)[0];
        Assert.Empty(CopyAsOverride(replace: false, copiedIn(_fixture)).Refused);
        var copied = _fixture.DocumentCarrying(_fixture.DestinationPlugin, carrierEditorId).Body;
        var edited = _fixture.EditHandler.Set(_fixture.DestinationPlugin, record.ToString(), member, Json(edit));
        Assert.True(edited.Applied, edited.Message);

        CopyAsOverride(replace: true, record).OnlyLanded();

        Assert.Equal(copied, _fixture.DocumentCarrying(_fixture.DestinationPlugin, carrierEditorId).Body);
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
}
