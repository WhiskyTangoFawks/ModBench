using System.Reflection;
using System.Text.Json;
using MEditService.Index;
using MEditService.Queries;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Traces;

// ADR-0012: "every key contains the delimiter" is no safety net, since ColumnKey.Of elides the
// Data-directory origin. Driven at the wire, where GetCompare's own JSON reaches a client.
[Collection(WebHostCollection.Name)]
public sealed class CompareColumnKeyIntegrityTraceTests : HostedTests
{
    // Reflection-derived from CompareResult's own DTO graph, so a hand-typed allowlist cannot let a
    // column-keyed dictionary go unchecked. The attribute is matched by name, not by type, because
    // ColumnKeyedAttribute is Queries' own internal.
    private static readonly (HashSet<string> Direct, HashSet<string> Nested) ColumnDictProperties = BuildColumnDictProperties();

    private ScatteredFixtureData? _fixture;

    protected override void DisposeFixtures() => _fixture?.Dispose();

    private static (HashSet<string> Direct, HashSet<string> Nested) BuildColumnDictProperties()
    {
        var direct = new HashSet<string>(StringComparer.Ordinal);
        var nested = new HashSet<string>(StringComparer.Ordinal);
        CollectColumnKeyedProperties(typeof(CompareResult), direct, nested, []);
        return (direct, nested);
    }

    private static void CollectColumnKeyedProperties(
        Type type, HashSet<string> direct, HashSet<string> nested, HashSet<Type> visited)
    {
        if (!IsOwnDtoType(type) || !visited.Add(type)) return;

        foreach (var prop in type.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            VisitProperty(prop, direct, nested, visited);
    }

    private static void VisitProperty(
        PropertyInfo prop, HashSet<string> direct, HashSet<string> nested, HashSet<Type> visited)
    {
        if (TryGetStringDictValueType(prop.PropertyType, out var dictValueType))
        {
            VisitDictionaryProperty(prop, dictValueType, direct, nested, visited);
            return;
        }

        var nextType = TryGetEnumerableElementType(prop.PropertyType, out var elementType) ? elementType : prop.PropertyType;
        CollectColumnKeyedProperties(nextType, direct, nested, visited);
    }

    private static bool IsColumnKeyed(PropertyInfo prop) =>
        prop.GetCustomAttributes(inherit: false).Any(a => a.GetType().Name == "ColumnKeyedAttribute");

    // A [ColumnKeyed] dictionary whose own *value* type is itself a string-keyed dictionary is the
    // double-nested case (FieldCellStates/FieldResolutions) — detected structurally here, not via a
    // second attribute flavor, and recorded in `nested` instead of `direct`.
    private static void VisitDictionaryProperty(
        PropertyInfo prop, Type dictValueType, HashSet<string> direct, HashSet<string> nested, HashSet<Type> visited)
    {
        if (!IsColumnKeyed(prop))
        {
            CollectColumnKeyedProperties(dictValueType, direct, nested, visited);
            return;
        }

        var jsonName = JsonNamingPolicy.CamelCase.ConvertName(prop.Name);
        if (TryGetStringDictValueType(dictValueType, out var innerValueType))
        {
            nested.Add(jsonName);
            CollectColumnKeyedProperties(innerValueType, direct, nested, visited);
        }
        else
        {
            direct.Add(jsonName);
            CollectColumnKeyedProperties(dictValueType, direct, nested, visited);
        }
    }

    // Only walk our own DTOs (MEditService.*) — never BCL/Mutagen types (string, object,
    // enums, ConflictThis, etc.), which is what stops the recursion at every leaf.
    private static bool IsOwnDtoType(Type type) =>
        !type.IsEnum && !type.IsPrimitive
        && type.Namespace is { } ns && ns.StartsWith("MEditService.", StringComparison.Ordinal);

    private static bool TryGetStringDictValueType(Type type, out Type valueType)
    {
        var dictInterface = CandidateInterfaces(type).FirstOrDefault(i =>
            i.IsGenericType
            && (i.GetGenericTypeDefinition() == typeof(IDictionary<,>) || i.GetGenericTypeDefinition() == typeof(IReadOnlyDictionary<,>))
            && i.GetGenericArguments()[0] == typeof(string));
        valueType = dictInterface?.GetGenericArguments()[1] ?? typeof(object);
        return dictInterface != null;
    }

    private static bool TryGetEnumerableElementType(Type type, out Type elementType)
    {
        elementType = typeof(object);
        if (type == typeof(string)) return false;
        var ienum = CandidateInterfaces(type)
            .FirstOrDefault(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IEnumerable<>));
        if (ienum == null) return false;
        elementType = ienum.GetGenericArguments()[0];
        return true;
    }

    private static IEnumerable<Type> CandidateInterfaces(Type type) =>
        type.IsInterface ? [type, .. type.GetInterfaces()] : type.GetInterfaces();

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

        AssertEveryColumnDictKeyIsValid(compare, validKeys);

        // PluginStates is keyed by ColumnKey.Of, so a lookup by plugin name alone misses both
        // compound keys and silently defaults every override to OnlyOne.
        var modA = overrides.EnumerateArray().Single(o => o.GetProperty("origin").GetString() == "ModA");
        var modB = overrides.EnumerateArray().Single(o => o.GetProperty("origin").GetString() == "ModB");
        Assert.Equal("Master", modA.GetProperty("conflictThis").GetString());
        Assert.Equal("IdenticalToMaster", modB.GetProperty("conflictThis").GetString());
    }

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
        if (prop.Value.ValueKind == JsonValueKind.Object)
        {
            if (ColumnDictProperties.Direct.Contains(prop.Name))
                AssertColumnKeyedEntries(prop.Value, validKeys);
            else if (ColumnDictProperties.Nested.Contains(prop.Name))
                AssertNestedColumnKeyedEntries(prop.Value, validKeys);
        }
        AssertEveryColumnDictKeyIsValid(prop.Value, validKeys);
    }

    private static void AssertColumnKeyedEntries(JsonElement dict, HashSet<string> validKeys)
    {
        foreach (var entry in dict.EnumerateObject())
            Assert.Contains(entry.Name, validKeys);
    }

    // The outer key here is a field id ("function", "runOn", "param:0", …), not a column — only
    // each field id's own value (the inner dictionary) is column-keyed.
    private static void AssertNestedColumnKeyedEntries(JsonElement dict, HashSet<string> validKeys)
    {
        foreach (var fieldEntry in dict.EnumerateObject())
        {
            if (fieldEntry.Value.ValueKind == JsonValueKind.Object)
                AssertColumnKeyedEntries(fieldEntry.Value, validKeys);
        }
    }
}
