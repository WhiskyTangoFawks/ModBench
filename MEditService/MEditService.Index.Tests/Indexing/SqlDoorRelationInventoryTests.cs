using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Index.Tests.Indexing;

/// <summary>ADR-0011: a typed read reconstitutes through the codec, so the relations a filter may
/// name are the record types and the side tables, never a decomposition of a record's own
/// fields.</summary>
public sealed class SqlDoorRelationInventoryTests(CutDownPluginFixture fixture) : IClassFixture<CutDownPluginFixture>
{
    // Named through EXISTS rather than selected from: a side table keys its rows by source and
    // target, so only `records` and the per-type relations carry a bare form_key.
    private bool Names(string relation) =>
        fixture.Index.Accepts($"SELECT form_key FROM records WHERE EXISTS (SELECT 1 FROM \"{relation}\")");

    [Theory]
    [InlineData("records")]
    [InlineData("form_lookup")]
    [InlineData("form_references")]
    [InlineData("placement")]
    [InlineData("header")]
    [InlineData("npc_")]
    [InlineData("weap")]
    [InlineData("armo")]
    [InlineData("cell")]
    [InlineData("glob")]
    public void AFilterNamesTheRelationsTheSchemaDeclares(string relation) => Assert.True(Names(relation));

    // The accepted cases above are this theory's positive control: a door that refused everything
    // would satisfy absence as well as a real deletion does.
    [Theory]
    [InlineData("vmad_scripts")]
    [InlineData("vmad_properties")]
    [InlineData("vmad_property_list_items")]
    [InlineData("conditions")]
    [InlineData("condition_parameters")]
    public void AFilterNamesNoDecompositionOfARecordsOwnFields(string relation) => Assert.False(Names(relation));
}
