using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.RecordIndex.Tests.Records;

public class FileReferencesTests
{
    private static readonly PluginAddress Holding = new("Holding.esp", "ModA");

    [Fact]
    public void ACopyThatNamesAFile_IsAReferenceToItsPathInTheDataFolder_InAnyCaseAndSeparator_AtTheMemberThatNamesIt()
    {
        string naming = "";
        using var plugins = new PluginFixtureBuilder("file-references")
            .WithPlugin(Holding.Name, mod =>
            {
                var holder = mod.TextureSets.AddNew("Holder");
                holder.Diffuse = @"Decals\Stain_d.dds";
                naming = holder.FormKey.ToString();
                mod.TextureSets.AddNew("SameName").Diffuse = @"Other\Stain_d.dds";
            }, origin: Holding.Origin)
            .BuildScattered();
        var holder = new LoadOrderHolder();
        using var opens = new GatedPluginAdapter();
        using var index = Indexes.Open(holder, opens);
        index.Reconcile(holder, plugins.DataFolder, plugins.Plugins, GameRelease.Fallout4);

        var copies = index.Queries.GetFileReferences("textures/DECALS/stain_d.dds").Value().Copies;

        var copy = Assert.Single(copies);
        Assert.Equal((naming, Holding, false), (copy.FormKey, copy.Plugin, copy.InPluginSource));
        Assert.Equal(["Diffuse"], copy.FieldPaths);
    }
}
