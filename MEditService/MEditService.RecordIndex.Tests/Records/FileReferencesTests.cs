using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

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

    [Fact]
    public void ACopyThatCannotBeRead_IsNamedAsUnread_AndTheCopiesBesideItStillAnswer()
    {
        FormKey naming = default, unreadable = default;
        using var fixture = new PluginFixtureBuilder("file-references-unread")
            .WithPlugin(Holding.Name, mod =>
            {
                var holder = mod.TextureSets.AddNew("Holder");
                holder.Diffuse = @"Decals\Stain_d.dds";
                var misplaced = mod.TextureSets.AddNew("Misplaced");
                misplaced.Diffuse = @"Other\Stain_d.dds";
                (naming, unreadable) = (holder.FormKey, misplaced.FormKey);
            }, origin: Holding.Origin)
            .BuildScattered()
            .CompiledPlugin();
        var entry = fixture.Plugins.Single();
        using (var live = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins))
            entry.HandEdit(live.DocumentOf(unreadable.ToString(), entry.Key), @"Other\\Stain_d.dds", "Data/Stain_d.dds");
        using var index = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

        var answer = index.Queries.GetFileReferences("Textures/Decals/Stain_d.dds").Value();

        Assert.Equal([naming.ToString()], answer.Copies.Select(copy => copy.FormKey));
        Assert.StartsWith($"{unreadable} in {Holding.Name} ({Holding.Origin}): ", Assert.Single(answer.Unread));
    }
}
