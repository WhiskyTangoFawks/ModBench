using System.Text.Json;
using MEditService.LoadOrder;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Binary.Parameters;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Api;

// Plugin header reachable through the existing generic FormKey lookup/compare path, with no new
// endpoint — a red result here signals a gap in the schema/indexer design, not a missing endpoint.
[Collection(WebHostCollection.Name)]
public sealed class PluginHeaderRecordApiTests
{
    [Fact]
    public async Task GetRecord_PluginHeaderFormKey_ReturnsAuthorFlagsMasters()
    {
        using var fixture = new PluginFixtureBuilder("rqs-header-record")
            .WithPlugin("HeaderQuery.esp", mod =>
            {
                mod.ModHeader.Author = "Test Author";
                mod.ModHeader.Flags = Fallout4ModHeader.HeaderFlag.Small;
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Fallout4.esm") });
            },
                // WriteToBinary normally recomputes the master list from actual FormLink usage,
                // stripping a manually-added master reference with no corresponding FormLink —
                // NoCheck preserves it so this test can assert on it after the disk round-trip.
                writeParams: new BinaryWriteParameters { MastersListContent = MastersListContentOption.NoCheck })
            .Build();
        using var app = new MEditHost();
        using var client = app.CreateClient();
        (await client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fixture.DataFolder,
            instanceRoot = fixture.InstanceRoot,
            plugins = fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        })).EnsureSuccessStatusCode();

        var detail = await client.Record("000000:HeaderQuery.esp");

        var author = Field(detail, "Author");
        Assert.Equal("Test Author", author.GetProperty("value").GetString());

        var flags = Field(detail, "Flags");
        Assert.Equal(["Small"], flags.GetProperty("value").EnumerateArray().Select(e => e.GetString()));

        var masters = Field(detail, "MasterReferences");
        Assert.Contains("Fallout4.esm", masters.GetProperty("value").ToString());
    }

    [Fact]
    public async Task GetCompare_PluginHeaderFormKey_ReturnsSingleOverride()
    {
        using var fixture = new PluginFixtureBuilder("rqs-header-compare")
            .WithPlugin("CompareA.esp")
            .WithPlugin("CompareB.esp")
            .Build();
        using var app = new MEditHost();
        using var client = app.CreateClient();
        (await client.PutLoadOrderAndAwaitReady(new
        {
            gameDirectory = fixture.DataFolder,
            instanceRoot = fixture.InstanceRoot,
            plugins = fixture.Plugins.Select(p => new { p.Name, p.Path, p.Origin, p.Slot, p.Enabled, p.Winning }),
            gameRelease = "Fallout4",
        })).EnsureSuccessStatusCode();

        var compare = await client.Compare("000000:CompareA.esp");

        var overrides = compare.GetProperty("overrides");
        Assert.Equal(1, overrides.GetArrayLength());
        Assert.Equal("CompareA.esp", overrides[0].GetProperty("plugin").GetString());
    }

    private static JsonElement Field(JsonElement detail, string name) =>
        detail.GetProperty("fields").EnumerateArray().Single(f => f.GetProperty("metadata").GetProperty("name").GetString() == name);
}
