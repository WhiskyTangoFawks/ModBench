using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Commands.Edits;
using MEditService.Ports;
using MEditService.LoadOrder;
using MEditService.Queries;
using MEditService.Index;
using MEditService.Codec.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

// ADR-0012: "every key contains the delimiter" is no safety net, since ColumnKey.Of elides the
// Data-directory origin. Driven through GetCompare, where the step that builds column keys lives.
public sealed class CompareResultColumnKeyIntegrityTests
{
    private static readonly JsonSerializerOptions WireOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    // Reflection-derived from CompareResult's own DTO graph, the graph GetCompare serializes, so a
    // hand-typed allowlist cannot let a column-keyed dictionary go unchecked. "Nested" is detected
    // structurally rather than through a second attribute flavour.
    private static readonly (HashSet<string> Direct, HashSet<string> Nested) ColumnDictProperties = BuildColumnDictProperties();

    // ---- reflection: derive ColumnDictProperties.Direct / .Nested ----

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

    // A [ColumnKeyed] dictionary whose own *value* type is itself a string-keyed dictionary is the
    // double-nested case (FieldCellStates/FieldResolutions) — detected structurally here, not via a
    // second attribute flavor, and recorded in `nested` instead of `direct`.
    private static void VisitDictionaryProperty(
        PropertyInfo prop, Type dictValueType, HashSet<string> direct, HashSet<string> nested, HashSet<Type> visited)
    {
        if (prop.GetCustomAttribute<ColumnKeyedAttribute>() == null)
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

    // Only walk our own DTOs (MEditService.Core.*) — never BCL/Mutagen types (string, object,
    // enums, ConflictThis, etc.), which is what stops the recursion at every leaf.
    private static bool IsOwnDtoType(Type type) =>
        !type.IsEnum && !type.IsPrimitive
        && type.Namespace is { } ns && ns.StartsWith("MEditService.Core", StringComparison.Ordinal);

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

    // One copy in the load order is all this needs: it asserts the shape of the response's column
    // keys, not classification, and the other column falls back to fail-open defaults it never reads.
    private sealed class FakeIndex(IRecordReads reads) : IQueryIndex
    {
        // This double exists for read-model shape assertions only: nothing here projects or filters.
        public LoadOrderStatus Status => LoadOrderStatus.None;
        public string? FilterSql => null;
        public IRecordReads RequireReads() => reads;
    }

    [Fact]
    public void GetCompare_SameFilenameTwoOrigins_EveryDictionaryKeyIsARealColumnKey()
    {
        var holder = new LoadOrderHolder();
        // Perk, not Npc: a record type carrying both a script adapter and a top-level Conditions field, so
        // one record reaches every column-keyed dictionary this guards as well as the nested condition
        // subtree.
        var mod = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
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

        var reflector = SharedSchemaReflector.Instance;
        var ddl = new TableDdlBuilder(reflector);
        using var repo = new DuckDbRecordIndex(reflector, ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.IndexMod((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "ModA"));
        repo.IndexMod((IModGetter)mod, Registration.Participating(1), new PluginKey(mod.ModKey.FileName.ToString(), "ModB"));
        repo.UpdateWinners();

        var index = new FakeIndex(repo.At(RecordRef.Effective));
        holder.Apply(new LoadOrderSnapshot(
            @"C:\Games\Fallout4\Data", null, GameRelease.Fallout4,
            [new RegisteredCopy("Shared.esp", "Data", "", Slot: 0, Enabled: true, Winning: true)]));
        var svc = new RecordQueryService(index, holder, reflector, new ConflictClassifier());

        var compare = svc.GetCompare(perk.FormKey.ToString());

        Assert.NotNull(compare);
        var validKeys = compare.Overrides.Select(o => ColumnKey.Of(o.Plugin, o.Origin)).ToHashSet();
        // Sanity: the fixture really produced two distinct columns — if this is 1, CompareOverride
        // itself isn't carrying its own real Origin through GetCompare's annotation step.
        Assert.Equal(2, validKeys.Count);

        // The walk below is only meaningful if it reaches non-empty struct/structList Raw and condition
        // subtrees, so a fixture regression fails loudly here rather than passing over empty objects.
        var properties = Assert.Single(compare.Diffs, d => d.FieldName == "VirtualMachineAdapter")
            .Children!.Single(c => c.FieldName == "Scripts")
            .Children!.Single()
            .Children!.Single(c => c.FieldName == "Properties")
            .Children!;
        Assert.NotEmpty(properties.Single(p => p.FieldName == "Config").Children!.Single(c => c.FieldName == "Members").Children!);
        Assert.NotEmpty(properties.Single(p => p.FieldName == "Items").Children!.Single(c => c.FieldName == "Structs").Children!);

        // Conditions reach the grid as an ordinary reflected array column, so the walk's condition coverage
        // is a nested FieldDiff subtree with per-column Values/CellStates.
        var conditions = Assert.Single(compare.Diffs, d => d.FieldName == "Conditions");
        var conditionRow = Assert.Single(conditions.Children!);
        Assert.NotEmpty(conditionRow.CellStates);
        var conditionData = Assert.Single(conditionRow.Children!, c => c.FieldName == "Data");
        var runOnReference = Assert.Single(conditionData.Children!, c => c.FieldName == "Reference");
        Assert.NotEmpty(runOnReference.Resolutions ?? new Dictionary<string, FormKeyResolution>());

        var json = JsonSerializer.SerializeToElement(compare, WireOptions);
        AssertEveryColumnDictKeyIsValid(json, validKeys);

        // PluginStates is keyed by ColumnKey.Of, so a lookup by plugin name alone misses both
        // compound keys and silently defaults every override to OnlyOne.
        var modA = compare.Overrides.Single(o => o.Origin == "ModA");
        var modB = compare.Overrides.Single(o => o.Origin == "ModB");
        Assert.Equal(ConflictThis.Master, modA.ConflictThis);
        Assert.Equal(ConflictThis.IdenticalToMaster, modB.ConflictThis);
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
