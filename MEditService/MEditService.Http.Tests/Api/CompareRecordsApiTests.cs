using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

public sealed class CompareRecordsApiTests : HostedTests
{
    private const string WithNpc = "WithNpc.esp";
    private const string WithNpcMod = "WithNpcMod";
    private const string WithWeapon = "WithWeapon.esp";
    private const string WithWeaponMod = "WithWeaponMod";

    private async Task<(string Npc, string Weapon)> Loaded()
    {
        var fx = Owned(new PluginFixtureBuilder("compare-records")
            .WithPlugin(WithNpc, mod => mod.Npcs.AddNew("Npc"), origin: WithNpcMod)
            .WithPlugin(WithWeapon, mod => mod.Weapons.AddNew("Weapon"), origin: WithWeaponMod)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        return (await Client.FirstFormKey(WithNpc, WithNpcMod), await Client.FirstFormKey(WithWeapon, WithWeaponMod, "weap"));
    }

    private static object Copy(string formKey, string plugin, string origin, string? documentText = null) =>
        new { formKey, plugin = new { name = plugin, origin }, documentText };

    [Fact]
    public async Task SeveralRecords_AreOneColumnEach_InTheOrderGiven_WithNoConflictState()
    {
        var (npc, weapon) = await Loaded();

        var response = await Client.PostAsJsonAsync("/records/compare", new
        {
            copies = new[] { Copy(weapon, WithWeapon, WithWeaponMod), Copy(npc, WithNpc, WithNpcMod) },
        });

        response.EnsureSuccessStatusCode();
        var answer = await response.Body();
        var columns = answer.GetProperty("overrides").EnumerateArray().ToList();
        Assert.Equal([weapon, npc], columns.Select(c => c.GetProperty("formKey").GetString()));
        Assert.All(columns, c => Assert.False(c.TryGetProperty("conflictThis", out var state) && state.ValueKind != System.Text.Json.JsonValueKind.Null));
        Assert.All(answer.GetProperty("diffs").EnumerateArray(), d => Assert.Empty(d.GetProperty("cellStates").EnumerateObject()));
    }

    [Fact]
    public async Task ACopyNoPluginHolds_Is404_NamingEachRecordAndPlugin()
    {
        var (npc, weapon) = await Loaded();

        var response = await Client.PostAsJsonAsync("/records/compare", new
        {
            copies = new[] { Copy(npc, WithWeapon, WithWeaponMod), Copy(weapon, WithNpc, WithNpcMod) },
        });

        var detail = (await response.AssertIsProblem(HttpStatusCode.NotFound)).GetProperty("detail").GetString();
        Assert.Contains(npc, detail);
        Assert.Contains(WithWeapon, detail);
        Assert.Contains(WithWeaponMod, detail);
        Assert.Contains(weapon, detail);
        Assert.Contains(WithNpc, detail);
        Assert.Contains(WithNpcMod, detail);
    }

    [Fact]
    public async Task NoCopies_Is400()
    {
        await Loaded();

        var response = await Client.PostAsJsonAsync("/records/compare", new { copies = Array.Empty<object>() });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task ACopyMissingItsOrigin_Is400()
    {
        var (npc, _) = await Loaded();

        var response = await Client.PostAsJsonAsync("/records/compare", new { copies = new[] { Copy(npc, WithNpc, "") } });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Theory]
    [InlineData("{ not json")]
    [InlineData("[]")]
    public async Task ADocumentTextThatIsNoRecordDocument_IsAColumnThatCouldNotBeParsed(string text)
    {
        var (npc, _) = await Loaded();

        var response = await Client.PostAsJsonAsync("/records/compare", new { copies = new[] { Copy(npc, WithNpc, WithNpcMod, text) } });

        response.EnsureSuccessStatusCode();
        var column = (await response.Body()).GetProperty("overrides").EnumerateArray().Single();
        Assert.False(string.IsNullOrWhiteSpace(column.GetProperty("parseDiagnosis").GetString()));
    }

    [Fact]
    public async Task OneRecordWithAPluginsText_IsThatPluginsColumnReadFromIt()
    {
        var (npc, _) = await Loaded();

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(npc)}/compare",
            new { plugin = new { name = WithNpc, origin = WithNpcMod }, documentText = "{ not json" });

        response.EnsureSuccessStatusCode();
        var column = (await response.Body()).GetProperty("overrides").EnumerateArray().Single();
        Assert.Equal((WithNpc, WithNpcMod), (column.GetProperty("plugin").GetString(), column.GetProperty("origin").GetString()));
        Assert.False(string.IsNullOrWhiteSpace(column.GetProperty("parseDiagnosis").GetString()));
    }

    private async Task<(string PlacedRef, string CellText)> TrackedACell()
    {
        var fx = Owned(new PluginFixtureBuilder("compare-child")
            .WithPlugin(WithNpc, mod =>
            {
                var room = new Cell(mod) { EditorID = "Room" };
                room.Temporary.Add(new PlacedObject(mod) { EditorID = "PlacedRef" });
                var subBlock = new CellSubBlock { BlockNumber = 0 };
                subBlock.Cells.Add(room);
                var block = new CellBlock { BlockNumber = 0 };
                block.SubBlocks.Add(subBlock);
                mod.Cells.Records.Add(block);
            }, origin: WithNpcMod)
            .BuildScattered());
        (await Client.PutLoadOrder(fx)).EnsureSuccessStatusCode();
        (await Client.Track(WithNpcMod)).EnsureSuccessStatusCode();
        await Client.NextSnapshot(fx);
        await Client.PluginReportsTracked(WithNpc);
        var cell = await Client.FormKeyNamed(WithNpc, WithNpcMod, "cell", "Room");
        var rendered = await Client.GetAsync(new Uri(
            $"/plugins/{WithNpc}/records/{Uri.EscapeDataString(cell)}/rendered-document?origin={WithNpcMod}", UriKind.Relative));
        rendered.EnsureSuccessStatusCode();
        return (await Client.FormKeyNamed(WithNpc, WithNpcMod, "refr", "PlacedRef"),
            (await rendered.Body()).GetProperty("text").GetString().Require());
    }

    private async Task<JsonElement> ColumnReadFrom(string formKey, string text)
    {
        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(formKey)}/compare",
            new { plugin = new { name = WithNpc, origin = WithNpcMod }, documentText = text });
        response.EnsureSuccessStatusCode();
        return (await response.Body()).GetProperty("overrides").EnumerateArray().Single();
    }

    [Fact]
    public async Task AChildWithItsContainersText_IsTheChildReadFromIt()
    {
        var (placedRef, cellText) = await TrackedACell();

        var column = await ColumnReadFrom(placedRef, cellText.Replace("\"PlacedRef\"", "\"EditedRef\"", StringComparison.Ordinal));

        Assert.Equal(placedRef, column.GetProperty("formKey").GetString());
        Assert.Equal("EditedRef", column.GetProperty("editorId").GetString());
        Assert.Null(column.GetProperty("parseDiagnosis").GetString());
    }

    [Fact]
    public async Task AChildWithAContainersTextThatDoesNotCarryIt_IsAColumnSayingSo()
    {
        var (placedRef, cellText) = await TrackedACell();

        var column = await ColumnReadFrom(placedRef, cellText.Replace(placedRef, "000FFF:WithNpc.esp", StringComparison.Ordinal));

        Assert.Contains($"does not carry {placedRef}", column.GetProperty("parseDiagnosis").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task OneRecordWithATextButNoOrigin_Is400()
    {
        var (npc, _) = await Loaded();

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString(npc)}/compare",
            new { plugin = new { name = WithNpc, origin = "" }, documentText = "{}" });

        await response.AssertIsProblem(HttpStatusCode.BadRequest);
    }

    [Fact]
    public async Task OneRecordNoPluginIndexes_WithAText_Is404()
    {
        await Loaded();

        var response = await Client.PostAsJsonAsync(
            $"/records/{Uri.EscapeDataString("00DEAD:Nowhere.esp")}/compare",
            new { plugin = new { name = WithNpc, origin = WithNpcMod }, documentText = "{}" });

        await response.AssertIsProblem(HttpStatusCode.NotFound);
    }

    [Fact]
    public async Task WithNoLoadOrder_Is503()
    {
        var response = await Client.PostAsJsonAsync("/records/compare", new { copies = new[] { Copy("000800:WithNpc.esp", WithNpc, WithNpcMod) } });

        await response.AssertIsProblem(HttpStatusCode.ServiceUnavailable);
    }
}
