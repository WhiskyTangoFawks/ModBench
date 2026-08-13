using System.Net.Http.Json;
using System.Text.Json;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Api;

// #305 / ADR-0036: the wire-level guard rail for the four spatial routes
// (GetWorldspaces/GetWorldspaceBlocks/GetCellReferences/GetInteriorCells), mirroring
// DuplicateFilenameSessionApiTests' real two-copy load path — a session that actually holds two
// physical files of one filename, rather than a hand-built pair below GameSession. Before this
// ticket these routes had zero test coverage of their own at any layer; WorldspaceQueryServiceTests
// covers the origin-threading logic in isolation, this proves it survives the route binding too.
//
// Both copies carry real mod-folder origins (never the reserved PluginOrigin.DataDirectory) —
// ColumnKey.Of elides that reserved value, so a fixture where either copy defaulted to it would
// pass whether or not the routes honoured the `origin` parameter (#300 hit exactly this).
public sealed class SpatialRoutesOriginApiTests(LoadedApiFixture<TestPluginFixture> loaded)
    : IClassFixture<LoadedApiFixture<TestPluginFixture>>
{
    private readonly HttpClient _client = loaded.Client;

    // Each copy gets its own worldspace (one exterior cell, one placed ref) and one interior cell,
    // all EditorID-tagged with the origin that built them so a route answering with the wrong
    // copy's data is visible in the assertion, not just in the row count. Both copies construct
    // their content in the same order from a fresh Fallout4Mod against the same ModKey, so they
    // land on identical FormKeys — same trick DuplicateFilenameSessionApiTests' shared-FormKey NPC
    // pair uses — which is what lets one captured FormKey address both copies' /worldspaces/{fk}
    // and /cells/{fk} routes, distinguished only by the `origin` query param under test.
    private static (string WorldspaceFk, string CellFk) ConfigureCopy(Fallout4Mod mod, string tag)
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

    private static (ScatteredFixtureData Fx, string WorldspaceFk, string CellFk) BuildTwoCopies()
    {
        string? worldspaceFk = null;
        string? cellFk = null;
        var fx = new PluginFixtureBuilder("api-spatial-origin")
            .WithPlugin("Shared.esp", mod =>
            {
                var (wrld, cell) = ConfigureCopy(mod, "ModA");
                worldspaceFk = wrld;
                cellFk = cell;
            }, origin: "ModA")
            .WithPlugin("Shared.esp", mod => ConfigureCopy(mod, "ModB"), origin: "ModB")
            .BuildScattered();
        return (fx, worldspaceFk!, cellFk!);
    }

    // Same real load path as DuplicateFilenameSessionApiTests: the load order names exactly one
    // Shared.esp (ModA), and ModB arrives afterwards, on demand, as the copy the load order does
    // not name.
    private async Task LoadWinningCopyThenShadowedCopy(ScatteredFixtureData fx)
    {
        var shadowed = fx.Plugins.Single(p => p.Origin == "ModB");
        var loadOrder = fx.Plugins.Where(p => p.Origin != "ModB");

        var load = await _client.PostAsJsonAsync("/session/load-explicit", new
        {
            gameDirectory = fx.GameDirectory,
            plugins = loadOrder.Select(p => new { name = p.Name, path = p.Path, origin = p.Origin, participates = true }),
            gameRelease = "Fallout4",
        });
        load.EnsureSuccessStatusCode();

        var onDemand = await _client.PostAsJsonAsync("/plugins/load", new { path = shadowed.Path, origin = shadowed.Origin });
        onDemand.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task GetWorldspaces_ExplicitOrigin_ReturnsThatCopysOwnWorldspaces_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, _, _) = BuildTwoCopies();
        using var _fx = fx;
        await LoadWinningCopyThenShadowedCopy(fx);

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/worldspaces?origin=ModB");
        Assert.Equal(["WorldModB"], modB.EnumerateArray().Select(w => w.GetProperty("editorId").GetString()!).ToArray());

        // AC1: omitted origin still resolves via the load order — the winning copy (ModA) — exactly
        // as it did before this ticket, since that is the path every current caller takes.
        var omitted = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/worldspaces");
        Assert.Equal(["WorldModA"], omitted.EnumerateArray().Select(w => w.GetProperty("editorId").GetString()!).ToArray());
    }

    [Fact]
    public async Task GetWorldspaceBlocks_ExplicitOrigin_ReturnsThatCopysOwnCells_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, worldspaceFk, _) = BuildTwoCopies();
        using var _fx = fx;
        await LoadWinningCopyThenShadowedCopy(fx);
        var encodedFk = Uri.EscapeDataString(worldspaceFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks?origin=ModB");
        var cellB = modB.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        Assert.Equal("CellModB", cellB.GetProperty("editorId").GetString());

        var omitted = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/worldspaces/{encodedFk}/blocks");
        var cellOmitted = omitted.GetProperty("blocks")[0].GetProperty("subBlocks")[0].GetProperty("cells")[0];
        Assert.Equal("CellModA", cellOmitted.GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task GetCellReferences_ExplicitOrigin_ReturnsThatCopysOwnPlacedRefs_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, _, cellFk) = BuildTwoCopies();
        using var _fx = fx;
        await LoadWinningCopyThenShadowedCopy(fx);
        var encodedFk = Uri.EscapeDataString(cellFk);

        var modB = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/cells/{encodedFk}/references?origin=ModB");
        Assert.Equal("RefModB", modB.GetProperty("persistent")[0].GetProperty("editorId").GetString());

        var omitted = await _client.GetFromJsonAsync<JsonElement>($"/plugins/Shared.esp/cells/{encodedFk}/references");
        Assert.Equal("RefModA", omitted.GetProperty("persistent")[0].GetProperty("editorId").GetString());
    }

    [Fact]
    public async Task GetInteriorCells_ExplicitOrigin_ReturnsThatCopysOwnInteriorCells_OmittedOrigin_ReturnsLoadOrderWinners()
    {
        var (fx, _, _) = BuildTwoCopies();
        using var _fx = fx;
        await LoadWinningCopyThenShadowedCopy(fx);

        var modB = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/interior-cells?origin=ModB&limit=50&offset=0");
        Assert.Equal(["InteriorModB"], modB.GetProperty("items").EnumerateArray().Select(c => c.GetProperty("editorId").GetString()!).ToArray());

        var omitted = await _client.GetFromJsonAsync<JsonElement>("/plugins/Shared.esp/interior-cells?limit=50&offset=0");
        Assert.Equal(["InteriorModA"], omitted.GetProperty("items").EnumerateArray().Select(c => c.GetProperty("editorId").GetString()!).ToArray());
    }
}
