using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Records;

[Collection(TestPluginFixtureCollection.Name)]
public class SearchRecordsTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private OpenedIndex MakeLoadedManager(LoadOrderHolder holder)
    {
        var manager = Indexes.Open(holder);
        manager.Reconcile(holder, _fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return manager;
    }

    [Fact]
    public void Search_AcrossMultipleRecordTypes_ByFormKey_ResolvesRecord()
    {
        var holder = new LoadOrderHolder();
        using var manager = MakeLoadedManager(holder);
        var reader = manager.RequireReads();

        var byEditorId = reader.Search(new RecordQuery(RecordTypes: ["npc_"], Search: "TestNPC01", Limit: 10, Offset: 0));
        var formKey = byEditorId.Items[0].FormKey;

        var result = reader.Search(new RecordQuery(RecordTypes: ["npc_", "weap"], Search: formKey, Limit: 10, Offset: 0));

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }
}
