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

// ADR-0012 for the spatial routes, over a load order really holding two files of one filename.
// Real mod-folder origins: ColumnKey.Of elides PluginOrigin.DataDirectory, so a default-origin
// fixture passes whether or not the routes honour origin.
[Collection(WebHostCollection.Name)]
public sealed class SpatialRoutesOriginApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Both plugins build in the same order from a fresh Fallout4Mod against the same ModKey, so
    // they land on identical FormKeys: one captured FormKey addresses both plugins' routes,
    // distinguished only by `origin`.
    private static (string WorldspaceFk, string CellFk) ConfigurePlugin(Fallout4Mod mod, string tag)
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

    private static (ScatteredFixtureData Fx, string WorldspaceFk, string CellFk) BuildTwoPlugins()
    {
        string? worldspaceFk = null;
        string? cellFk = null;
        var fx = new PluginFixtureBuilder("api-spatial-origin")
            .WithPlugin("Shared.esp", mod => ConfigurePlugin(mod, "ModB"), origin: "ModB")
            .WithPlugin("Shared.esp", mod =>
            {
                var (wrld, cell) = ConfigurePlugin(mod, "ModA");
                worldspaceFk = wrld;
                cellFk = cell;
            }, origin: "ModA")
            .BuildScattered();
        return (
            fx,
            worldspaceFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have set the worldspace FormKey."),
            cellFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have set the cell FormKey."));
    }

    private async Task PutBothPlugins(ScatteredFixtureData fx)
    {
        // ADR-0013: both plugins travel in the one snapshot, ModB as the overridden plugin at the
        // same slot; only the winning, enabled, listed one is active.
        var plugins = fx.Plugins;

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin }),
            active = SnapshotPlugins.Active(plugins),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetWorldspaces_ExplicitOrigin_ReturnsThatPluginsOwnWorldspaces()
    {
        var (fx, _, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/worldspaces?origin=ModB");
        Assert.Equal(["WorldModB"], modB.EnumerateArray().Select(w => DocumentNodes.StringValueOf(w.GetProperty("editorId"))).ToArray());
    }

    // ADR-0012 invariant 1: a plugin filter with no origin would match every plugin sharing that
    // filename, so the route refuses rather than picking the load order's winner for it.
    [Fact]
    public async Task GetWorldspaces_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, _, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var omitted = await _client.GetAsync("/plugins/Shared.esp/worldspaces");
        await AssertOriginRequiredProblem(omitted);
    }

    [Fact]
    public async Task GetWorldspaceBlocks_ExplicitOrigin_ReturnsThatPluginsOwnCells()
    {
        var (fx, worldspaceFk, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(worldspaceFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks?origin=ModB");
        var cellB = modB.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        Assert.Equal("CellModB", cellB.GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task GetWorldspaceBlocks_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, worldspaceFk, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(worldspaceFk);

        var omitted = await _client.GetAsync($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks");
        await AssertOriginRequiredProblem(omitted);
    }

    [Fact]
    public async Task GetCellReferences_ExplicitOrigin_ReturnsThatPluginsOwnPlacedRefs()
    {
        var (fx, _, cellFk) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(cellFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/cells/{encodedFk}/references?origin=ModB");
        Assert.Equal("RefModB", modB.GetProperty("persistent")[0].GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task GetCellReferences_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, _, cellFk) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(cellFk);

        var omitted = await _client.GetAsync($"/plugins/Shared.esp/cells/{encodedFk}/references");
        await AssertOriginRequiredProblem(omitted);
    }

    [Fact]
    public async Task GetInteriorCells_ExplicitOrigin_ReturnsThatPluginsOwnInteriorCells()
    {
        var (fx, _, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/interior-cells?origin=ModB");
        Assert.Equal(["InteriorModB"], InteriorEditorIds(modB));
    }

    [Fact]
    public async Task GetInteriorCells_OmittedOrigin_ReturnsBadRequest()
    {
        var (fx, _, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var omitted = await _client.GetAsync("/plugins/Shared.esp/interior-cells");
        await AssertOriginRequiredProblem(omitted);
    }

    // A 400 alone doesn't say why: some other cause could return the same status, so the problem
    // detail itself is the assertion that this is the origin guard and not a stray 400 elsewhere.
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
