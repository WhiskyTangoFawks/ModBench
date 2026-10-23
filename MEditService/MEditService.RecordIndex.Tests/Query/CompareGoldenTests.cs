using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class CompareGoldenTests(CompareGoldenFixture fixture) : IClassFixture<CompareGoldenFixture>
{
    private static readonly JsonSerializerOptions WireOptions = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    private OpenedIndex Index => fixture.Index;

    private static JsonElement Wire<T>(T answered) => JsonSerializer.SerializeToElement(answered, WireOptions);

    private JsonElement Compare(FormKey formKey) => Wire(Index.Queries.GetCompare(formKey.ToString()).Value());

    private static object PluginWithoutItsPerRunTempPath(JsonElement p) => new
    {
        name = p.GetProperty("name"),
        loadOrderIndex = p.GetProperty("loadOrderIndex"),
        isLight = p.GetProperty("isLight"),
        isMaster = p.GetProperty("isMaster"),
        masters = p.GetProperty("masters"),
        recordCount = p.GetProperty("recordCount"),
        isImmutable = p.GetProperty("isImmutable"),
        origin = p.GetProperty("origin"),
        missingMasters = p.GetProperty("missingMasters"),
        inLoadOrder = p.GetProperty("inLoadOrder"),
        hasMatchingRecords = p.GetProperty("hasMatchingRecords"),
    };

    private static object Project(JsonElement compare) => new
    {
        conflictAll = compare.GetProperty("conflictAll"),
        overrides = compare.GetProperty("overrides").EnumerateArray().Select(o => new
        {
            formKey = o.GetProperty("formKey"),
            plugin = o.GetProperty("plugin"),
            origin = o.GetProperty("origin"),
            loadIndex = o.GetProperty("loadIndex"),
            isWinner = o.GetProperty("isWinner"),
            editorId = o.GetProperty("editorId"),
            recordType = o.GetProperty("recordType"),
            conflictThis = o.GetProperty("conflictThis"),
            isPartialForm = o.GetProperty("isPartialForm"),
            fields = o.GetProperty("fields").EnumerateArray()
                .ToDictionary(f => f.GetProperty("metadata").GetProperty("name").GetString().Require(), f => f.GetProperty("value")),
        }).ToList(),
        diffs = DiffsThatDifferSomewhere(compare).ToList(),
        diffFieldCount = compare.GetProperty("diffs").GetArrayLength(),
    };

    private static IEnumerable<JsonElement> DiffsThatDifferSomewhere(JsonElement compare) =>
        compare.GetProperty("diffs").EnumerateArray()
            .Where(d => d.GetProperty("cellStates").EnumerateObject()
                .Any(s => s.Value.GetString() is not ("OnlyOne" or "IdenticalToMaster" or "Master")));

    [Fact]
    public void Compare_AcrossThreePlugins_MatchesGolden()
    {
        var captured = new Dictionary<string, object?>
        {
            ["conflicted-npc"] = Project(Compare(CompareGoldenFixture.ConflictedNpc)),
            ["unchanged-weapon"] = Project(Compare(CompareGoldenFixture.UnchangedWeapon)),
            ["sole-npc"] = Project(Compare(CompareGoldenFixture.SoleNpc)),
            ["injected-npc"] = Project(Compare(CompareGoldenFixture.InjectedNpc)),
            ["conflicted-conditions"] = Project(Compare(CompareGoldenFixture.ConflictedRecipe)),
        };

        Golden.Verify("compare-three-plugins", captured);
    }

    [Fact]
    public void WinnerAndListings_MatchGolden()
    {
        var plugins = Wire(Index.Queries.GetPlugins().Value()).EnumerateArray().ToList();
        var perPluginTypes = new Dictionary<string, JsonElement>();
        foreach (var name in new[] { "Base.esm", "Mid.esp", "Top.esp" })
            perPluginTypes[name] = Wire(Index.Queries.GetPluginRecordTypes(new PluginAddress(name, PluginOrigin.DataDirectory)).Value());

        var winningRecords = new Dictionary<string, object?>();
        foreach (var fk in new[]
        {
            CompareGoldenFixture.ConflictedNpc, CompareGoldenFixture.UnchangedWeapon, CompareGoldenFixture.SoleNpc,
            CompareGoldenFixture.InjectedNpc, CompareGoldenFixture.ConflictedRecipe,
        })
        {
            var d = Wire(Index.Queries.GetRecord(fk.ToString()).Value());
            winningRecords[fk.ToString()] = new
            {
                plugin = d.GetProperty("plugin"),
                origin = d.GetProperty("origin"),
                isWinner = d.GetProperty("isWinner"),
                editorId = d.GetProperty("editorId"),
                recordType = d.GetProperty("recordType"),
            };
        }

        var allNpcs = Wire(Index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 50, offset: 0).Value());
        var references = Wire(Index.Queries.GetReferences(new FormKey(ModKey.FromFileName("Base.esm"), 0x900).ToString()).Value());

        var captured = new
        {
            plugins = plugins.Select(PluginWithoutItsPerRunTempPath).ToList(),
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
