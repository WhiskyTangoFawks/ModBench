using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public class FileReferencesTests
{
    private static readonly PluginAddress Holding = new("Holding.esp", "ModA");

    [Fact]
    public void ACopyThatNamesAFile_IsPlacedAtTheMemberThatNamesItsPathInTheDataFolder_InAnyCaseAndSeparator()
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
        using var index = Indexes.Reconciled(plugins);

        var placed = index.Queries.GetPlacedFileReferences("textures/DECALS/stain_d.dds").Value();

        var copy = Assert.Single(placed.Copies);
        Assert.Equal((naming, Holding, CopyDocumentKind.Rendered), (copy.FormKey, copy.Plugin, copy.Document.Kind));
        Assert.Equal(@"Decals\\Stain_d.dds", PlacedText.TextAt(index.Queries.GetRenderedDocument(Holding, naming).Value().Require().Text, Assert.Single(copy.Ranges)));
        Assert.Empty(placed.LeftOut);
    }

    [Fact]
    public void ACopyThatCannotBeRead_IsNamedAsUnread_WhateverMessageMutagenGivesIt_AndTheCopiesBesideItStillAnswer()
    {
        var rootedSoMutagensMessageNamesNoFile = OperatingSystem.IsWindows() ? "C:/Other/Stain_d.dds" : "/Other/Stain_d.dds";
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
            entry.HandEdit(live.DocumentOf(unreadable.ToString(), entry.Key), @"Other\\Stain_d.dds", rootedSoMutagensMessageNamesNoFile);
        using var index = Indexes.Reconciled(fixture.DataFolder, fixture.Plugins);

        var placed = index.Queries.GetPlacedFileReferences("Textures/Decals/Stain_d.dds").Value();

        var copy = Assert.Single(placed.Copies);
        Assert.Equal(naming.ToString(), copy.FormKey);
        Assert.Equal(@"Decals\\Stain_d.dds", PlacedText.TextAt(File.ReadAllText(copy.Document.Location), Assert.Single(copy.Ranges)));
        Assert.StartsWith($"{unreadable} in {Holding.Name} ({Holding.Origin}): ", Assert.Single(placed.LeftOut));
    }
}
