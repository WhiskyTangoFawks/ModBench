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
            .WithPlugin("Shared.esp", mod =>
            {
                var (wrld, cell) = ConfigurePlugin(mod, "ModA");
                worldspaceFk = wrld;
                cellFk = cell;
            }, origin: "ModA")
            .WithPlugin("Shared.esp", mod => ConfigurePlugin(mod, "ModB"), origin: "ModB")
            .BuildScattered();
        return (
            fx,
            worldspaceFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have set the worldspace FormKey."),
            cellFk ?? throw new InvalidOperationException("Expected ConfigurePlugin to have set the cell FormKey."));
    }

    private async Task PutBothPlugins(ScatteredFixtureData fx)
    {
        // ADR-0013: both plugins travel in the one snapshot, ModB as the overridden plugin at the
        // same slot; only the winning, enabled, listed one participates.
        var winner = fx.Plugins.Single(p => p.Origin == "ModA");
        var plugins = fx.Plugins.Select(p => p.Origin == "ModB"
            ? p with { Slot = winner.Slot, Winning = false }
            : p);

        var put = await _client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fx.GameDirectory,
            instanceRoot = fx.InstanceRoot,
            plugins = plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        });
        put.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetWorldspaces_ExplicitOrigin_ReturnsThatPluginsOwnWorldspaces_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, _, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/worldspaces?origin=ModB");
        Assert.Equal(["WorldModB"], modB.EnumerateArray().Select(w => DocumentNodes.StringValueOf(w.GetProperty("editorId"))).ToArray());

        // Omitted origin still resolves via the load order — the winning plugin (ModA) — since
        // that is the path every current caller takes.
        var omitted = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/worldspaces");
        Assert.Equal(["WorldModA"], omitted.EnumerateArray().Select(w => DocumentNodes.StringValueOf(w.GetProperty("editorId"))).ToArray());
    }

    [Fact]
    public async Task GetWorldspaceBlocks_ExplicitOrigin_ReturnsThatPluginsOwnCells_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, worldspaceFk, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(worldspaceFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks?origin=ModB");
        var cellB = modB.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        Assert.Equal("CellModB", cellB.GetProperty("editorId").GetString());

        var omitted = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks");
        var cellOmitted = omitted.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        Assert.Equal("CellModA", cellOmitted.GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task GetCellReferences_ExplicitOrigin_ReturnsThatPluginsOwnPlacedRefs_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, _, cellFk) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);
        var encodedFk = Uri.EscapeDataString(cellFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/cells/{encodedFk}/references?origin=ModB");
        Assert.Equal("RefModB", modB.GetProperty("persistent")[0].GetProperty("editorId").GetString());

        var omitted = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/cells/{encodedFk}/references");
        Assert.Equal("RefModA", omitted.GetProperty("persistent")[0].GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task GetInteriorCells_ExplicitOrigin_ReturnsThatPluginsOwnInteriorCells_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, _, _) = BuildTwoPlugins();
        using var _fx = fx;
        await PutBothPlugins(fx);

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/interior-cells?origin=ModB&limit=50&offset=0");
        Assert.Equal(["InteriorModB"], modB.GetProperty("items").EnumerateArray().Select(c => DocumentNodes.StringValueOf(c.GetProperty("editorId"))).ToArray());

        var omitted = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/interior-cells?limit=50&offset=0");
        Assert.Equal(["InteriorModA"], omitted.GetProperty("items").EnumerateArray().Select(c => DocumentNodes.StringValueOf(c.GetProperty("editorId"))).ToArray());
    }
}
