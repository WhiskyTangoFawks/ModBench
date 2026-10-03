using MEditService.Index.Tests.TestSupport;

namespace MEditService.Index.Tests.Indexing;

public sealed class SqlDoorRelationInventoryTests(SqlDoorFixture fixture) : IClassFixture<SqlDoorFixture>
{
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

    [Theory]
    [InlineData("vmad_scripts")]
    [InlineData("vmad_properties")]
    [InlineData("vmad_property_list_items")]
    [InlineData("conditions")]
    [InlineData("condition_parameters")]
    public void AFilterNamesNoDecompositionOfARecordsOwnFields(string relation) => Assert.False(Names(relation));
}
