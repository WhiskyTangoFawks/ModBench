using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

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
        var answer = (await response.Body()).GetProperty("compare");
        var columns = answer.GetProperty("overrides").EnumerateArray().ToList();
        Assert.Equal([weapon, npc], columns.Select(c => c.GetProperty("formKey").GetString()));
        Assert.All(columns, c => Assert.False(c.TryGetProperty("conflictThis", out var state) && state.ValueKind != System.Text.Json.JsonValueKind.Null));
        Assert.All(answer.GetProperty("diffs").EnumerateArray(), d => Assert.Empty(d.GetProperty("cellStates").EnumerateObject()));
    }

    [Fact]
    public async Task ACopyNoPluginGives_IsAnAnswerWithNoComparison_NamingEachCopyAndWhyItIsMissing()
    {
        var (npc, weapon) = await Loaded();
        const string nowhere = "00DEAD:Nowhere.esp";

        var response = await Client.PostAsJsonAsync("/records/compare", new
        {
            copies = new[] { Copy(npc, WithNpc, WithNpcMod), Copy(weapon, WithNpc, WithNpcMod), Copy(nowhere, WithWeapon, WithWeaponMod) },
        });

        response.EnsureSuccessStatusCode();
        var answer = await response.Body();
        Assert.False(answer.TryGetProperty("compare", out var compare) && compare.ValueKind != JsonValueKind.Null);
        var missing = answer.GetProperty("missing").EnumerateArray().ToList();
        Assert.Equal(
            [(weapon, WithNpc, WithNpcMod, "NotInPlugin"), (nowhere, WithWeapon, WithWeaponMod, "RecordGone")],
            missing.Select(m => (m.GetProperty("formKey").GetString(), m.GetProperty("plugin").GetProperty("name").GetString(),
                m.GetProperty("plugin").GetProperty("origin").GetString(), m.GetProperty("reason").GetString())));
        Assert.All(missing, m => Assert.False(string.IsNullOrWhiteSpace(m.GetProperty("message").GetString())));
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

    public static TheoryData<string, string, string> NotAComparison => new()
    {
        { "/records/compare", "no copies", """{"copies": []}""" },
        { "/records/compare", "a copy missing its origin", """{"copies": [{"formKey": "000800:WithNpc.esp", "plugin": {"name": "WithNpc.esp", "origin": ""}}]}""" },
        {
            "/records/000800%3AWithNpc.esp/compare", "a text with no origin",
            """{"plugin": {"name": "WithNpc.esp", "origin": ""}, "documentText": "{}"}"""
        },
    };

    [Theory]
    [MemberData(nameof(NotAComparison))]
    public async Task ARequestThatDoesNotSayWhatToCompare_Is400(string route, string lacking, string body)
    {
        await Loaded();

        var response = await Client.PostJson(route, body);

        Assert.Equal((lacking, HttpStatusCode.BadRequest), (lacking, response.StatusCode));
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
}
