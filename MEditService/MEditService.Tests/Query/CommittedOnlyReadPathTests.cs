using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.Api;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

/// <summary>
/// ADR-0041: the read path answers from the index alone. A record list reports exactly the records
/// its plugin declares, a compare's override values are the committed ones, and a reference list is
/// what the plugin declares and nothing else — no surface reconstructs a second answer on the way
/// out.
///
/// Each test's non-vacuity was established by rival: an overlay branch that appended synthetic
/// unindexed rows was applied by hand, each test observed failing, and the rival reverted from a
/// file copy.
/// </summary>
[Collection(TestPluginFixtureCollection.Name)]
public sealed class CommittedOnlyReadPathTests : IDisposable
{
    private readonly LoadOrderMirror _manager;
    private readonly RecordQueryService _svc;

    public CommittedOnlyReadPathTests(TestPluginFixture fixture)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new LoadOrderMirror(factory);
        _manager.Reconcile(fixture.DataFolder, fixture.Plugins, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, reflector, new ConflictClassifier());
    }

    public void Dispose() => _manager.Dispose();

    [Fact]
    public void GetRecords_ForAPlugin_ReturnsExactlyTheRecordsThatPluginDeclares()
    {
        var result = _svc.GetRecords("npc_", TestPluginFixture.PluginName, search: null, limit: 100, offset: 0);

        Assert.Equal(TestPluginFixture.RecordCount, result.Total);
        Assert.Equal(
            ["TestNPC01", "TestNPC02"],
            result.Items.Select(r => r.EditorId ?? "").OrderBy(e => e, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public void GetPluginRecordTypes_CountsOnlyIndexedRecords()
    {
        var counts = _svc.GetPluginRecordTypes(TestPluginFixture.PluginName);

        var npcs = Assert.Single(counts, c => c.Type == "npc_");
        Assert.Equal(TestPluginFixture.RecordCount, npcs.Count);
    }

    [Fact]
    public void GetCompare_OverrideCarriesTheCommittedFieldValue()
    {
        var formKey = _manager.LoadOrder!.Plugins.Count > 0
            ? _svc.GetRecords("npc_", TestPluginFixture.PluginName, "TestNPC01", 1, 0).Items[0].FormKey
            : throw new InvalidOperationException("fixture did not load");

        var compare = _svc.GetCompare(formKey);

        Assert.NotNull(compare);
        var only = Assert.Single(compare.Overrides);
        Assert.Equal(TestPluginFixture.PluginName, only.Plugin);
        Assert.Equal("TestNPC01", only.EditorId);
        // A scalar field read straight off the index — the slot a staged value used to be able to
        // stand in for.
        var deleted = Assert.Single(only.Fields, f => f.Metadata.Name == "is_deleted");
        Assert.Equal("False", deleted.Value?.ToString());
    }
}

/// <summary>
/// #410/ADR-0041: the references read is committed-only. Split from the class above because it
/// needs a fixture that actually declares a reference — <see cref="ReferencePluginFixture"/>, the
/// same one the API-level reference tests use — where the class above deliberately loads a plugin
/// whose records reference nothing.
/// </summary>
public sealed class CommittedOnlyReferencesTests : IDisposable
{
    private readonly LoadOrderMirror _manager;
    private readonly RecordQueryService _svc;
    private readonly ReferencePluginFixture _fixture = new();

    public CommittedOnlyReferencesTests()
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordIndexFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new LoadOrderMirror(factory);
        _manager.Reconcile(_fixture.DataFolder, _fixture.Plugins, GameRelease.Fallout4);
        _svc = new RecordQueryService(_manager, reflector, new ConflictClassifier());
    }

    public void Dispose()
    {
        _manager.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void GetReferences_ReturnsWhatThePluginDeclares_AndNothingElse()
    {
        // Positive control first, through the identical call path: a reference the indexed plugin
        // really declares must come back. Without it the absence half below would pass just as
        // happily against a broken query, a wrong connection or an empty index — exactly the shape
        // the staged-reference union used to be able to hide behind.
        var referenced = _svc.GetReferences(_fixture.KeywordFormKey.ToString());

        var hit = Assert.Single(referenced);
        Assert.Equal(_fixture.NpcWithKeywordFormKey.ToString(), hit.FormKey);
        Assert.Equal(ReferencePluginFixture.PluginName, hit.Plugin);

        // And nothing beyond it: the NPC that declares no keyword is not a referencing source —
        // the row a staged reference used to be able to add here.
        Assert.DoesNotContain(referenced, r => r.FormKey == _fixture.NpcWithoutKeywordFormKey.ToString());
    }
}
