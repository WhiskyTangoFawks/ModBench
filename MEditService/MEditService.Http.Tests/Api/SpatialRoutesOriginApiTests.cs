using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Noggog;

namespace MEditService.Http.Tests.Api;

public sealed class SpatialRoutesOriginApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    private static (string WorldspaceFk, string CellFk) ConfigurePluginWithFormKeysIdenticalAcrossPlugins(Fallout4Mod mod, string tag)
    {
        var wrld = mod.Worldspaces.AddNew($"World{tag}");
        var extCell = new Cell(mod) { EditorID = $"Cell{tag}", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var placed = new PlacedObject(mod) { EditorID = $"Ref{tag}" };
        extCell.Persistent.Add(placed);

        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        subBlock.Items.Add(extCell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(subBlock);
        wrld.SubCells.Add(block);

        var intCell = new Cell(mod) { EditorID = $"Interior{tag}" };
        var intSub = new CellSubBlock { BlockNumber = 0 };
        intSub.Cells.Add(intCell);
        var intBlock = new CellBlock { BlockNumber = 0 };
        intBlock.SubBlocks.Add(intSub);
        mod.Cells.Records.Add(intBlock);

        return (wrld.FormKey.ToString(), extCell.FormKey.ToString());
    }

    private static (ScatteredFixtureData Fx, string WorldspaceFk, string CellFk) BuildTwoPluginsUnderRealModFolderOrigins()
    {
        string? worldspaceFk = null;
        string? cellFk = null;
        var fx = new PluginFixtureBuilder("api-spatial-origin")
            .WithPlugin("Shared.esp", mod => ConfigurePluginWithFormKeysIdenticalAcrossPlugins(mod, "ModB"), origin: "ModB")
            .WithPlugin("Shared.esp", mod =>
            {
                var (wrld, cell) = ConfigurePluginWithFormKeysIdenticalAcrossPlugins(mod, "ModA");
                worldspaceFk = wrld;
                cellFk = cell;
            }, origin: "ModA")
            .BuildScattered();
        return (
            fx,
            worldspaceFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have set the worldspace FormKey."),
            cellFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have set the cell FormKey."));
    }

    private async Task PutBothPlugins(ScatteredFixtureData fx, string winner = "ModA")
    {
        var plugins = fx.Plugins.Select(p => p.Name == "Shared.esp" ? p with { Winning = p.Origin == winner } : p).ToList();

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(plugins),
            loadedWithNoLine = SnapshotPlugins.LoadedWithNoLine(plugins),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetWorldspaces_ExplicitOrigin_ReturnsThatPluginsOwnWorldspaces()
    {
        var (fx, _, _) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx, winner: "ModB");

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/worldspaces?origin=ModB");
        Assert.Equal(["WorldModB"], modB.EnumerateArray().Select(w => DocumentNodes.StringValueOf(w.GetProperty("editorId"))).ToArray());
        Assert.Empty((await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/worldspaces?origin=ModA")).EnumerateArray());
    }

    [Fact]
    public async Task GetWorldspaces_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, _, _) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var omitted = await _client.GetAsync("/plugins/Shared.esp/worldspaces");
        await AssertOriginRequiredProblem(omitted);
    }

    [Fact]
    public async Task GetWorldspaceBlocks_ExplicitOrigin_ReturnsThatPluginsOwnCells()
    {
        var (fx, worldspaceFk, _) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx, winner: "ModB");
        var encodedFk = Uri.EscapeDataString(worldspaceFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks?origin=ModB");
        var cellB = modB.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        Assert.Equal("CellModB", cellB.GetProperty("editorId").GetString());
        var modA = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks?origin=ModA");
        Assert.Empty(modA.GetProperty("blocks").EnumerateArray());
    }

    [Fact]
    public async Task GetWorldspaceBlocks_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, worldspaceFk, _) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(worldspaceFk);

        var omitted = await _client.GetAsync($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks");
        await AssertOriginRequiredProblem(omitted);
    }

    [Fact]
    public async Task GetCellChildRecords_ExplicitOrigin_ReturnsThatPluginsOwnPlacedRefs()
    {
        var (fx, _, cellFk) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx, winner: "ModB");
        var encodedFk = Uri.EscapeDataString(cellFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/cells/{encodedFk}/children?origin=ModB");
        Assert.Equal("RefModB", modB.GetProperty("persistent")[0].GetProperty("editorId").GetString());
        var modA = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/cells/{encodedFk}/children?origin=ModA");
        Assert.Empty(modA.GetProperty("persistent").EnumerateArray());
    }

    [Fact]
    public async Task GetCellChildRecords_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, _, cellFk) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(cellFk);

        var omitted = await _client.GetAsync($"/plugins/Shared.esp/cells/{encodedFk}/children");
        await AssertOriginRequiredProblem(omitted);
    }

    [Fact]
    public async Task GetInteriorCells_ExplicitOrigin_ReturnsThatPluginsOwnInteriorCells()
    {
        var (fx, _, _) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx, winner: "ModB");

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/interior-cells?origin=ModB");
        Assert.Equal(["InteriorModB"], InteriorEditorIds(modB));
        Assert.Empty(InteriorEditorIds(await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/interior-cells?origin=ModA")));
    }

    [Fact]
    public async Task GetInteriorCells_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, _, _) = BuildTwoPluginsUnderRealModFolderOrigins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var omitted = await _client.GetAsync("/plugins/Shared.esp/interior-cells");
        await AssertOriginRequiredProblem(omitted);
    }

    private static async Task AssertOriginRequiredProblem(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var body = await response.Body();
        Assert.Equal("Origin is required.", body.GetProperty("detail").GetString());
    }

    private static IEnumerable<string?> InteriorEditorIds(JsonElement blocks) =>
        blocks.EnumerateArray()
            .SelectMany(b => b.GetProperty("subBlocks").EnumerateArray())
            .SelectMany(s => s.GetProperty("cells").EnumerateArray())
            .Select(c => DocumentNodes.StringValueOf(c.GetProperty("editorId")));
}
