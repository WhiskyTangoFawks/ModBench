using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class CompiledPluginDerivationTests
{
    [Fact]
    public void ACompiledPluginWhoseRepositoryWentAway_ReadsAsNonCompiledPlugin_AfterTheNextCheck()
    {
        using var fixture = new PluginFixtureBuilder("compiled-plugin-derivation")
            .WithPlugin("Fixture.esp", mod => mod.Npcs.AddNew("FixtureNpc"), origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        var mod = fixture.Plugins.Single();
        using var index = Indexes.Reconciled(fixture);
        Assert.True(index.ReadFromItsPluginSource(mod.Key));

        AnotherTool.Delete(Path.Combine(mod.ModFolderOf(), ".git"));

        index.NextCheckUntil(() => !index.ReadFromItsPluginSource(mod.Key), "the plugin reading as non-compiled plugin");
    }
}
