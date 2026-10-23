using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Http.Tests.Api;

public sealed class SpatialWorkingTreeStateApiTests : HostedTests
{
    private const string Plugin = "Spatial.esp";
    private const string Origin = "SpatialMod";

    private static ScatteredFixtureData Build(Dictionary<string, string> formKeys) =>
        new PluginFixtureBuilder("trace-edit-spatial")
            .WithPlugin(Plugin, mod =>
            {
                var wrld = mod.Worldspaces.AddNew("World");
                var exterior = new Cell(mod) { EditorID = "Exterior", Grid = new CellGrid { Point = new P2Int(0, 0) } };
                var exteriorRef = new PlacedObject(mod) { EditorID = "ExteriorRef" };
                exterior.Persistent.Add(exteriorRef);
                var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
                subBlock.Items.Add(exterior);
                var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
                block.Items.Add(subBlock);
                wrld.SubCells.Add(block);

                var interior = new Cell(mod) { EditorID = "Interior" };
                var interiorRef = new PlacedObject(mod) { EditorID = "InteriorRef" };
                interior.Persistent.Add(interiorRef);
                var interiorSub = new CellSubBlock { BlockNumber = 0 };
                interiorSub.Cells.Add(interior);
                var interiorBlock = new CellBlock { BlockNumber = 0 };
                interiorBlock.SubBlocks.Add(interiorSub);
                mod.Cells.Records.Add(interiorBlock);

                formKeys["worldspace"] = wrld.FormKey.ToString();
                formKeys["exteriorCell"] = exterior.FormKey.ToString();
                formKeys["interiorCell"] = interior.FormKey.ToString();
                formKeys["exteriorRef"] = exteriorRef.FormKey.ToString();
                formKeys["interiorRef"] = interiorRef.FormKey.ToString();
            }, origin: Origin)
            .BuildScattered();

    [Fact]
    public async Task AnEditedInteriorRef_IsBeneathItsCell_ItsGroup_AndItsPlugin()
    {
        var formKeys = new Dictionary<string, string>();
        using var fx = Build(formKeys);
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.DecompileAndCommit(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsCompiledPlugin(Plugin);

        (await Client.Edit(formKeys["interiorRef"], Plugin, Origin, "EditorID", "Renamed")).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);

        var expected = """{"plugin":["Modified"],"recordTypes":{"cell":["Modified"]},"records":{"""
            + $"\"{formKeys["interiorCell"]}\"" + """:["Modified"]}}""";
        await Wire.Eventually(
            async () => await Client.GetStringAsync($"/plugins/{Plugin}/working-tree-states-beneath?origin={Origin}") == expected,
            "the interior ref beneath its cell, its group and its plugin");
    }
}
