using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Query;

public sealed class FilterAfterValidationTests
{
    [Fact]
    public void AHandEditThatMakesARecordNewlyMatch_AppearsInTheFilteredListing_AfterTheNextSnapshot()
    {
        FormKey npc = default;
        using var fixture = new PluginFixtureBuilder("filter-after-validation")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        var entry = fixture.Plugins.Single();
        using var index = Indexes.Reconciled(fixture);
        index.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'EditedName'", "filter.sql");
        var formKey = npc.ToString();
        entry.HandEdit(index.RequireReads().DocumentOf(formKey, entry.KeyOf()), "\"FixtureNpc\"", "\"EditedName\"");

        index.NextSnapshot();

        var listed = index.RequireReads().Search(new RecordQuery(RecordQueryScope.Navigator, RecordTypes: ["NPC_"], Limit: 100, Offset: 0));
        Assert.Equal([formKey], listed.Items.Select(i => i.FormKey));
    }
}
