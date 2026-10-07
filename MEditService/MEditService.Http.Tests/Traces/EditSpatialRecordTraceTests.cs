using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Http.Tests.Traces;

public sealed class EditSpatialRecordTraceTests : HostedTests
{
    private const string Plugin = "Spatial.esp";
    private const string Origin = "SpatialMod";

    private static readonly string[] Kinds = ["worldspace", "exteriorCell", "interiorCell", "exteriorRef", "interiorRef"];

    public static TheoryData<string> EveryKind => [.. Kinds];

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

    private async Task<Dictionary<string, string>> States(Dictionary<string, string> formKeys)
    {
        var query = $"?origin={Origin}";
        var worldspaces = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{Plugin}/worldspaces{query}");
        var blocks = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{Plugin}/worldspaces/{formKeys["worldspace"]}/blocks{query}");
        var interior = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{Plugin}/interior-cells{query}");
        var exteriorRefs = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{Plugin}/cells/{formKeys["exteriorCell"]}/children{query}");
        var interiorRefs = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{Plugin}/cells/{formKeys["interiorCell"]}/children{query}");

        static string StateOf(IEnumerable<JsonElement> rows, string formKey) =>
            rows.Single(r => r.GetProperty("formKey").GetString() == formKey).GetProperty("workingTreeState").GetString().Require();
        static IEnumerable<JsonElement> CellsOf(IEnumerable<JsonElement> blocks) =>
            blocks.SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
                .SelectMany(s => s.GetProperty("cells").EnumerateArray());
        static IEnumerable<JsonElement> Refs(JsonElement children) => children.GetProperty("persistent").EnumerateArray();

        return new Dictionary<string, string>
        {
            ["worldspace"] = StateOf(worldspaces.EnumerateArray(), formKeys["worldspace"]),
            ["exteriorCell"] = StateOf(CellsOf(blocks.GetProperty("blocks").EnumerateArray()), formKeys["exteriorCell"]),
            ["interiorCell"] = StateOf(CellsOf(interior.EnumerateArray()), formKeys["interiorCell"]),
            ["exteriorRef"] = StateOf(Refs(exteriorRefs), formKeys["exteriorRef"]),
            ["interiorRef"] = StateOf(Refs(interiorRefs), formKeys["interiorRef"]),
        };
    }

    [Theory]
    [MemberData(nameof(EveryKind))]
    public async Task AnEditedSpatialRecord_IsListedAsModified_AndNothingElseIs(string edited)
    {
        var formKeys = new Dictionary<string, string>();
        using var fx = Build(formKeys);
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(Origin)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(Plugin);

        (await Client.Edit(formKeys[edited], Plugin, Origin, "EditorID", "Renamed")).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);

        var expected = Kinds.ToDictionary(kind => kind, kind => kind == edited ? "Modified" : "None");
        await Wire.Eventually(async () => (await States(formKeys)).SequenceEqual(expected), $"only the {edited} listed as Modified");
    }
}
