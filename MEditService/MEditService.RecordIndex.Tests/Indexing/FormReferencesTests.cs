using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Indexing;

public class FormReferencesTests
{
    private static List<(string Source, string FieldPath, string RecordType)> ReferencesTo(OpenedIndex index, FormKey target) =>
        [.. index.Queries.GetReferencesInActiveOrCompiledPlugins(target.ToString()).Value().Select(r => (r.FormKey, r.FieldPath, r.RecordType))];

    [Fact]
    public void ReindexingAPlugin_ReplacesItsReferencesRatherThanDuplicating()
    {
        FormKey raceFormKey = default;
        using var fixture = new PluginFixtureBuilder("form-refs-reindex")
            .WithPlugin("Reindex.esp", mod =>
            {
                var race = mod.Races.AddNew("TestRace01");
                raceFormKey = race.FormKey;
                var npc = mod.Npcs.AddNew("TestNPC01");
                npc.Race.SetTo(race.FormKey);
            })
            .Build();
        using var index = Indexes.Reconciled(fixture);

        PluginBinaries.Touch(fixture.Plugins.Single().Path);
        index.NextCheck();

        Assert.Single(ReferencesTo(index, raceFormKey), r => r.FieldPath == "Race");
    }
}
