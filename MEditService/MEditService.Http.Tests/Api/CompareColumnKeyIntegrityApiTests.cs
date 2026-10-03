using System.Text.Json;
using MEditService.Http.Tests.TestSupport;
using MEditService.Index;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Http.Tests.Api;

public sealed class CompareColumnKeyIntegrityApiTests : HostedTests
{
    private static readonly HashSet<string> ColumnKeyedPropertiesNoSchemaNames = new(StringComparer.Ordinal)
    {
        "values", "cellStates", "resolutions", "checkErrors", "indexes",
    };

    private ScatteredFixtureData? _fixture;

    protected override void DisposeFixtures() => _fixture?.Dispose();

    [Fact]
    public async Task GetCompare_TwoModOrigins_EveryDictionaryKeyIsARealColumnKey()
    {
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

            var structListProp = new ScriptStructListProperty { Name = "Items" };
            var instance = new ScriptEntryStructs();
            instance.Members.Add(new ScriptIntProperty { Name = "Qty", Data = 7 });
            structListProp.Structs.Add(instance);
            script.Properties.Add(structListProp);

            vmad.Scripts.Add(script);
            perk.VirtualMachineAdapter = vmad;

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
            .WithPlugin("Patch.esp", (mod, masters) => mod.Perks.GetOrAddAsOverride(masters[0].Perks.Single()), origin: "ModB")
            .BuildScattered();
        (await Client.PutLoadOrder(_fixture)).EnsureSuccessStatusCode();
        var perkKey = await Client.FirstFormKey("Shared.esp", "ModA", "perk");

        var compare = await Client.Compare(perkKey);

        var overrides = compare.GetProperty("overrides");
        var validKeys = overrides.EnumerateArray()
            .Select(o => ColumnKey.Of(o.GetProperty("plugin").GetString().Require(), o.GetProperty("origin").GetString().Require()))
            .ToHashSet();
        Assert.Equal(2, validKeys.Count);

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

        var conditions = diffs.EnumerateArray().Single(d => d.GetProperty("fieldName").GetString() == "Conditions");
        var conditionRow = Children(conditions).Single();
        Assert.NotEmpty(conditionRow.GetProperty("cellStates").EnumerateObject());
        var conditionData = Children(conditionRow).Single(c => c.GetProperty("fieldName").GetString() == "Data");
        var runOnReference = Children(conditionData).Single(c => c.GetProperty("fieldName").GetString() == "Reference");
        Assert.NotEmpty(ResolutionsOf(runOnReference));

        AssertEveryColumnDictKeyIsValid(compare, validKeys);

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
        if (prop.Value.ValueKind == JsonValueKind.Object && ColumnKeyedPropertiesNoSchemaNames.Contains(prop.Name))
        {
            foreach (var entry in prop.Value.EnumerateObject())
                Assert.Contains(entry.Name, validKeys);
        }
        AssertEveryColumnDictKeyIsValid(prop.Value, validKeys);
    }
}
