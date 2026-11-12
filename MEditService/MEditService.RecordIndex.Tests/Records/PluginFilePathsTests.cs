using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public class PluginFilePathsTests
{
    private static readonly PluginAddress Compiled = new("Holding.esp", "ModA");

    [Fact]
    public void ACompiledPlugin_AnswersEachPathItsSourceNames_OnTheFileThatHoldsTheRecord()
    {
        using var fixture = new PluginFixtureBuilder("plugin-file-paths")
            .WithPlugin(Compiled.Name, mod => mod.TextureSets.AddNew("Holder").Diffuse = @"Decals\Stain_d.dds", origin: Compiled.Origin)
            .BuildScattered()
            .CompiledPlugin();
        using var index = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

        var answered = Assert.Single(index.Queries.GetFilePaths().Value());

        var path = Assert.Single(answered.Paths);
        Assert.Equal((Compiled, "Diffuse", "Textures/Decals/Stain_d.dds", null), (answered.Plugin, path.FieldPath, path.DataPath, answered.Failure));
        Assert.EndsWith(".json", path.SourceRelativePath, StringComparison.Ordinal);
        Assert.Empty(answered.Unread);
    }

    [Fact]
    public void APluginWithNoSource_IsNotAnswered()
    {
        using var fixture = new PluginFixtureBuilder("plugin-file-paths-binary")
            .WithPlugin(Compiled.Name, mod => mod.TextureSets.AddNew("Holder").Diffuse = @"Decals\Stain_d.dds", origin: Compiled.Origin)
            .BuildScattered();
        using var index = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

        Assert.Empty(index.Queries.GetFilePaths().Value());
    }

    [Fact]
    public void ARecordWhosePathIsRefused_IsUnreadOnItsPlugin_AndThePathsBesideItStillAnswer()
    {
        FormKey naming = default, refused = default;
        using var fixture = new PluginFixtureBuilder("plugin-file-paths-unread")
            .WithPlugin(Compiled.Name, mod =>
            {
                var holder = mod.TextureSets.AddNew("Holder");
                holder.Diffuse = @"Decals\Stain_d.dds";
                var misplaced = mod.TextureSets.AddNew("Misplaced");
                misplaced.Diffuse = @"Other\Stain_d.dds";
                (naming, refused) = (holder.FormKey, misplaced.FormKey);
            }, origin: Compiled.Origin)
            .BuildScattered()
            .CompiledPlugin();
        var entry = fixture.Plugins.Single();
        using (var live = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins))
            entry.HandEdit(live.DocumentOf(refused.ToString(), entry.Key), @"Other\\Stain_d.dds", "Data/Stain_d.dds");
        using var index = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

        var answered = Assert.Single(index.Queries.GetFilePaths().Value());

        Assert.Equal([naming.ToString()], answered.Paths.Select(path => path.FormKey));
        Assert.StartsWith($"{refused}: ", Assert.Single(answered.Unread));
    }
}
