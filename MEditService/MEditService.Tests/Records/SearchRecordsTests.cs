using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

[Collection(TestPluginFixtureCollection.Name)]
public class SearchRecordsTests(TestPluginFixture fixture)
{
    private readonly TestPluginFixture _fixture = fixture;

    private LoadOrderMirror MakeLoadedManager()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        var manager = new LoadOrderMirror(factory);
        manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        return manager;
    }

    // The picker's search has no `type` filter when a field allows more than one
    // record type (e.g. any object reference), so it goes through the multi-table union path
    // rather than a single-type query — the FormKey-shaped match needs to resolve there too.
    [Fact]
    public void Search_AcrossMultipleRecordTypes_ByFormKey_ResolvesRecord()
    {
        using var manager = MakeLoadedManager();
        var reader = manager.Reads!;

        var byEditorId = reader.Search(new RecordQuery(RecordTypes: ["npc_"], Search: "TestNPC01", Limit: 10, Offset: 0));
        var formKey = byEditorId.Items[0].FormKey;

        var result = reader.Search(new RecordQuery(RecordTypes: ["npc_", "weap"], Search: formKey, Limit: 10, Offset: 0));

        Assert.Equal(1, result.Total);
        Assert.Equal(formKey, result.Items[0].FormKey);
    }
}
