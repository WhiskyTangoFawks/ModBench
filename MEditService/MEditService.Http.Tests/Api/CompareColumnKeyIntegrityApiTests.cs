using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.Index;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

// ADR-0012: "every key contains the delimiter" is no safety net, since ColumnKey.Of elides the
// Data-directory origin. Driven at the wire, where GetCompare's own JSON reaches a client.
[Collection(WebHostCollection.Name)]
public sealed class CompareColumnKeyIntegrityApiTests : HostedTests
{
    // The wire's own column-keyed dictionaries on a FieldDiff node, wherever one appears: nothing
    // in the JSON schema names them, so a client hardcodes these four the same way this test does.
    private static readonly HashSet<string> ColumnKeyedProperties = new(StringComparer.Ordinal)
    {
        "values", "cellStates", "resolutions", "checkErrors",
    };

    private ScatteredFixtureData? _fixture;

    protected override void DisposeFixtures() => _fixture?.Dispose();

    [Fact]
    public async Task GetCompare_SameFilenameTwoOrigins_EveryDictionaryKeyIsARealColumnKey()
    {
        // Perk, not Npc: a record type carrying both a script adapter and a top-level Conditions field, so
        // one record reaches every column-keyed dictionary this guards as well as the nested condition
        // subtree.
        Action<Fallout4Mod> configure = mod =>
        {
            var perk = mod.Perks.AddNew("SharedPerk");

            var vmad = new PerkAdapter();
            var script = new ScriptEntry { Name = "S", Flags = ScriptEntry.Flag.Local };
            script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });

            var structProp = new ScriptStructProperty { Name = "Config" };
            var structMember = new ScriptEntry { Name = "SubScript" };
            structMember.Properties.Add(new ScriptFloatProperty { Name = "Factor", Data = 1.5f });
            structProp.Members.Add(structMember);
            script.Properties.Add(structProp);

            // StructList property (kind "structList") — same Raw gap, one level deeper (a list of
            // per-instance member-node lists rather than one).
            var structListProp = new ScriptStructListProperty { Name = "Items" };
            var instance = new ScriptEntryStructs();
            instance.Members.Add(new ScriptIntProperty { Name = "Qty", Data = 7 });
            structListProp.Structs.Add(instance);
            script.Properties.Add(structListProp);

            vmad.Scripts.Add(script);
            perk.VirtualMachineAdapter = vmad;

            // A condition with a Run-On target of Reference gives the nested condition subtree a resolvable
            // formKey leaf, so the walk reaches real per-column content rather than an empty subtree.
            var runOnData = new FunctionConditionData
            {
                Function = Condition.Function.GetIsID,
                RunOnType = Condition.RunOnType.Reference,
            };
            runOnData.Reference.SetTo(perk.FormKey);
            perk.Conditions.Add(new ConditionFloat
            {
                CompareOperator = CompareOperator.EqualTo,
                ComparisonValue = 1.0f,
                Data = runOnData,
            });
        };
        _fixture = new PluginFixtureBuilder("compare-column-keys")
            .WithPlugin("Shared.esp", configure, origin: "ModA")
            .WithPlugin("Shared.esp", configure, origin: "ModB")
            .BuildScattered();
        (await Client.PutLoadOrder(_fixture)).EnsureSuccessStatusCode();
        var perkKey = await Client.FirstFormKey("Shared.esp", "perk");

        var compare = await Client.Compare(perkKey);

        var overrides = compare.GetProperty("overrides");
        var validKeys = overrides.EnumerateArray()
            .Select(o => ColumnKey.Of(o.GetProperty("plugin").GetString().Require(), o.GetProperty("origin").GetString().Require()))
            .ToHashSet();
        // Sanity: the fixture really produced two distinct columns — if this is 1, the override
        // itself isn't carrying its own real origin over the wire.
        Assert.Equal(2, validKeys.Count);

        // The walk below is only meaningful if it reaches non-empty struct/structList and condition
        // subtrees, so a fixture regression fails loudly here rather than passing over empty objects.
        var diffs = compare.GetProperty("diffs");
        var virtualMachineAdapter = diffs.EnumerateArray().Single(d => d.GetProperty("fieldName").GetString() == "VirtualMachineAdapter");
        var scripts = Children(virtualMachineAdapter).Single(c => c.GetProperty("fieldName").GetString() == "Scripts");
        var scriptDiff = Children(scripts).Single();
        var propertiesNode = Children(scriptDiff).Single(c => c.GetProperty("fieldName").GetString() == "Properties");
        var properties = Children(propertiesNode);

        var config = properties.Single(p => p.GetProperty("fieldName").GetString() == "Config");
        var configMembers = Children(config).Single(c => c.GetProperty("fieldName").GetString() == "Members");
        Assert.NotEmpty(Children(configMembers));

        var items = properties.Single(p => p.GetProperty("fieldName").GetString() == "Items");
        var itemsStructs = Children(items).Single(c => c.GetProperty("fieldName").GetString() == "Structs");
        Assert.NotEmpty(Children(itemsStructs));

        // Conditions reach the grid as an ordinary reflected array column, so the walk's condition
        // coverage is a nested diff subtree with per-column values/cellStates.
        var conditions = diffs.EnumerateArray().Single(d => d.GetProperty("fieldName").GetString() == "Conditions");
        var conditionRow = Children(conditions).Single();
        Assert.NotEmpty(conditionRow.GetProperty("cellStates").EnumerateObject());
        var conditionData = Children(conditionRow).Single(c => c.GetProperty("fieldName").GetString() == "Data");
        var runOnReference = Children(conditionData).Single(c => c.GetProperty("fieldName").GetString() == "Reference");
        Assert.NotEmpty(ResolutionsOf(runOnReference));

        AssertEveryColumnDictKeyIsValid(compare, validKeys);

        // PluginStates is keyed by ColumnKey.Of, so a lookup by plugin name alone misses both
        // compound keys and silently defaults every override to OnlyOne.
        var modA = overrides.EnumerateArray().Single(o => o.GetProperty("origin").GetString() == "ModA");
        var modB = overrides.EnumerateArray().Single(o => o.GetProperty("origin").GetString() == "ModB");
        Assert.Equal("Master", modA.GetProperty("conflictThis").GetString());
        Assert.Equal("IdenticalToMaster", modB.GetProperty("conflictThis").GetString());
    }

    private static List<JsonElement> Children(JsonElement diff)
    {
        var children = diff.GetProperty("children");
        return children.ValueKind == JsonValueKind.Array
            ? [.. children.EnumerateArray()]
            : throw new InvalidOperationException($"Expected \"{diff.GetProperty("fieldName").GetString()}\" to have children.");
    }

    // Null-coalesced to empty rather than skipped, so a missing "resolutions" fails the NotEmpty
    // check loudly instead of the walk silently passing it by.
    private static List<JsonProperty> ResolutionsOf(JsonElement diff) =>
        diff.TryGetProperty("resolutions", out var resolutions) && resolutions.ValueKind == JsonValueKind.Object
            ? [.. resolutions.EnumerateObject()]
            : [];

    private static void AssertEveryColumnDictKeyIsValid(JsonElement element, HashSet<string> validKeys)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.Object:
                foreach (var prop in element.EnumerateObject())
                    AssertProperty(prop, validKeys);
                break;
            case JsonValueKind.Array:
                foreach (var item in element.EnumerateArray())
                    AssertEveryColumnDictKeyIsValid(item, validKeys);
                break;
        }
    }

    private static void AssertProperty(JsonProperty prop, HashSet<string> validKeys)
    {
        if (prop.Value.ValueKind == JsonValueKind.Object && ColumnKeyedProperties.Contains(prop.Name))
        {
            foreach (var entry in prop.Value.EnumerateObject())
                Assert.Contains(entry.Name, validKeys);
        }
        AssertEveryColumnDictKeyIsValid(prop.Value, validKeys);
    }
}
