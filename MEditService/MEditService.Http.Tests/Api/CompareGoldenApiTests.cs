using System.Net.Http.Json;
using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.TestSupport.TestSupport;

namespace MEditService.Http.Tests.Api;

/// <summary>Pins what the classifier makes of several plugins disagreeing, at the wire, including
/// the two easy to get wrong: an override identical to its master (not a conflict) and one
/// out-competed by a later override.</summary>
[Collection(WebHostCollection.Name)]
public sealed class CompareGoldenApiTests(CompareGoldenApiFixture fixture) : IClassFixture<CompareGoldenApiFixture>
{
    private HttpClient Client => fixture.Client;

    private static object Project(JsonElement compare) => new
    {
        conflictAll = compare.GetProperty("conflictAll"),
        overrides = compare.GetProperty("overrides").EnumerateArray().Select(o => new
        {
            formKey = o.GetProperty("formKey"),
            plugin = o.GetProperty("plugin"),
            origin = o.GetProperty("origin"),
            loadOrderIndex = o.GetProperty("loadOrderIndex"),
            isWinner = o.GetProperty("isWinner"),
            editorId = o.GetProperty("editorId"),
            recordType = o.GetProperty("recordType"),
            conflictThis = o.GetProperty("conflictThis"),
            isPartialForm = o.GetProperty("isPartialForm"),
            fields = o.GetProperty("fields").EnumerateArray()
                .ToDictionary(f => f.GetProperty("metadata").GetProperty("name").GetString().Require(), f => f.GetProperty("value")),
        }).ToList(),
        // Only fields that actually differ somewhere: an aligned diff tree over every reflected
        // column of an NPC is ~200 entries of "everyone agrees", which would bury the four that
        // carry the answer.
        diffs = compare.GetProperty("diffs").EnumerateArray()
            .Where(d => d.GetProperty("cellStates").EnumerateObject()
                .Any(s => s.Value.GetString() is not ("OnlyOne" or "IdenticalToMaster" or "Master")))
            .ToList(),
        diffFieldCount = compare.GetProperty("diffs").GetArrayLength(),
    };

    [Fact]
    public async Task Compare_AcrossThreePlugins_MatchesGolden()
    {
        var conflictedNpc = await Client.Compare(CompareGoldenApiFixture.ConflictedNpc.ToString());
        var unchangedWeapon = await Client.Compare(CompareGoldenApiFixture.UnchangedWeapon.ToString());
        var soleNpc = await Client.Compare(CompareGoldenApiFixture.SoleNpc.ToString());
        var injectedNpc = await Client.Compare(CompareGoldenApiFixture.InjectedNpc.ToString());
        var conflictedRecipe = await Client.Compare(CompareGoldenApiFixture.ConflictedRecipe.ToString());

        var captured = new Dictionary<string, object?>
        {
            ["conflicted-npc"] = Project(conflictedNpc),
            ["unchanged-weapon"] = Project(unchangedWeapon),
            ["sole-npc"] = Project(soleNpc),
            ["injected-npc"] = Project(injectedNpc),
            ["conflicted-conditions"] = Project(conflictedRecipe),
        };

        Golden.Verify("compare-three-plugins", captured);
    }

    [Fact]
    public async Task WinnerAndListings_MatchGolden()
    {
        var plugins = await Client.Plugins();
        var perPluginTypes = new Dictionary<string, JsonElement>();
        foreach (var name in new[] { "Base.esm", "Mid.esp", "Top.esp" })
            perPluginTypes[name] = await Client.GetFromJsonAsync<JsonElement>($"/plugins/{name}/record-types");

        var winningRecords = new Dictionary<string, object?>();
        foreach (var fk in new[]
        {
            CompareGoldenApiFixture.ConflictedNpc, CompareGoldenApiFixture.UnchangedWeapon, CompareGoldenApiFixture.SoleNpc,
            CompareGoldenApiFixture.InjectedNpc, CompareGoldenApiFixture.ConflictedRecipe,
        })
        {
            var d = await Client.Record(fk.ToString());
            winningRecords[fk.ToString()] = new
            {
                plugin = d.GetProperty("plugin"),
                origin = d.GetProperty("origin"),
                isWinner = d.GetProperty("isWinner"),
                editorId = d.GetProperty("editorId"),
                recordType = d.GetProperty("recordType"),
                loadOrderIndex = d.GetProperty("loadOrderIndex"),
            };
        }

        var allNpcs = await Client.GetFromJsonAsync<JsonElement>("/records?type=npc_&limit=50&offset=0");
        var references = await Client.GetFromJsonAsync<JsonElement>(
            $"/records/{Uri.EscapeDataString(new Mutagen.Bethesda.Plugins.FormKey(Mutagen.Bethesda.Plugins.ModKey.FromFileName("Base.esm"), 0x900).ToString())}/references");

        var captured = new
        {
            // Path is deliberately absent: it is a per-run temp directory.
            plugins = plugins.Select(p => new
            {
                name = p.GetProperty("name"),
                loadOrderIndex = p.GetProperty("loadOrderIndex"),
                isLight = p.GetProperty("isLight"),
                isMaster = p.GetProperty("isMaster"),
                masters = p.GetProperty("masters"),
                recordCount = p.GetProperty("recordCount"),
                isImmutable = p.GetProperty("isImmutable"),
                participates = p.GetProperty("participates"),
                origin = p.GetProperty("origin"),
                masterIssues = p.GetProperty("masterIssues"),
                inLoadOrder = p.GetProperty("inLoadOrder"),
                hasMatchingRecords = p.GetProperty("hasMatchingRecords"),
            }).ToList(),
            perPluginTypes,
            winningRecords,
            allNpcs = allNpcs.GetProperty("items").EnumerateArray()
                .OrderBy(r => r.GetProperty("formKey").GetString(), StringComparer.Ordinal)
                .ThenBy(r => r.GetProperty("plugin").GetString(), StringComparer.Ordinal).ToList(),
            references = references.EnumerateArray()
                .OrderBy(r => r.GetProperty("formKey").GetString(), StringComparer.Ordinal).ToList(),
        };

        Golden.Verify("compare-load-order-listings", captured);
    }
}
