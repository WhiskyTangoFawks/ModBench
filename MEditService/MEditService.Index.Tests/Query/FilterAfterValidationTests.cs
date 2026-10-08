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
        entry.HandEdit(index.DocumentOf(formKey, entry.KeyOf()), "\"FixtureNpc\"", "\"EditedName\"");

        index.NextSnapshot();

        var listed = index.Records.GetRecords(["npc_"], plugin: null, search: null, limit: 100, offset: 0);
        Assert.Equal([formKey], listed.Items.Select(i => i.FormKey));
    }
}
