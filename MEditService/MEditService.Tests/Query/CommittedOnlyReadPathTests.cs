using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Query;

/// <summary>
/// #410/ADR-0041: the read path answers from the index alone. Every surface below used to read
/// through a pending overlay — a record list that appended staged-only rows, a compare whose
/// override values could be a staged value rather than the committed one, a reference list that
/// subtracted superseded references and unioned staged ones back in — and now reports exactly what
/// the loaded plugins declare.
///
/// These are green on arrival: with the pending model gone there is no longer any way to stage the
/// thing they forbid. Each one's non-vacuity was therefore established by rival (#410 execution
/// notes): the deleted overlay branch was re-applied by hand against a synthetic staged row, each
/// test observed failing, and the rival reverted from a file copy.
/// </summary>
[Collection(TestPluginFixtureCollection.Name)]
public sealed class CommittedOnlyReadPathTests : IDisposable
{
    private readonly SessionManager _manager;
    private readonly RecordQueryService _svc;

    public CommittedOnlyReadPathTests(TestPluginFixture fixture)
    {
        var reflector = SharedSchemaReflector.Instance;
        var factory = new DuckDbRecordRepositoryFactory(reflector, new TableDdlBuilder(reflector));
        _manager = new SessionManager(factory, new PluginWriter(reflector, NullLogger<PluginWriter>.Instance));
        _manager.Load(fixture.DataFolder, fixture.PluginsTxtPath, GameRelease.Fallout4);
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
        var formKey = _manager.Session!.Plugins.Count > 0
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

    [Fact]
    public void GetReferences_ReturnsOnlyReferencesTheIndexedPluginsDeclare()
    {
        // TestPlugin.esp's two NPCs reference nothing, so every reference query over it is empty —
        // the state a staged reference used to be able to add a row to.
        var formKey = _svc.GetRecords("npc_", TestPluginFixture.PluginName, "TestNPC01", 1, 0).Items[0].FormKey;

        Assert.Empty(_svc.GetReferences(formKey));
    }
}
