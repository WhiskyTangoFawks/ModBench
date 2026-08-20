using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Cache;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Query;

// #272 / ADR-0036: replaces the old "every dictionary key contains the delimiter" assertion,
// which stopped being a valid safety net once ColumnKey.Of started eliding the Data-directory
// origin — a bare filename is now a *legitimate* key, so "contains '|'" would false-fail on every
// ordinary single-origin fixture and, worse, would not catch a key that's silently missing its
// origin (indistinguishable in shape from a legitimate Data-origin key). This asserts by content
// instead: every dictionary key anywhere in a serialized CompareResult must equal
// ColumnKey.Of(o.Plugin, o.Origin) for some override o actually present in that same result.
//
// Exercises RecordQueryService.GetCompare directly (not the classifiers in isolation) because the
// regressions this test caught on arrival lived one layer above the classifiers, in GetCompare's
// own annotation step (see the two Asserts at the bottom of the test) — a classifier-only test
// would not have caught either.
//
// #272 review: the set of "which dictionaries are column-keyed" is derived by reflecting over the
// [ColumnKeyed] attribute on the DTOs themselves (Queries/Models.cs), not hand-typed here — a
// hand-typed allowlist is exactly the mechanism that let three column-keyed dictionaries
// (VmadPropertyDiff.Raw, ConditionDiff.FieldCellStates, ConditionDiff.FieldResolutions) go
// unchecked, plus one dead entry (ClassifyResult.PluginStates, never itself serialized) linger.
// See ColumnKeyedAttribute's own doc comment (Queries/ColumnKey.cs).
public sealed class CompareResultColumnKeyIntegrityTests
{
    private static readonly JsonSerializerOptions WireOptions = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() },
    };

    // Reflection-derived, not hand-typed — walked once from CompareResult's own DTO graph
    // (Queries/Models.cs), the same graph GetCompare actually serializes. "Direct" = the
    // dictionary's own JSON keys are columns (Values/CellStates/Types/Flags/PerPlugin/
    // Resolutions/Raw). "Nested" = the dictionary's own keys are something else (a field id, e.g.
    // FieldCellStates/FieldResolutions), but each of *its* values is itself a column-keyed
    // dictionary — detected structurally (is the [ColumnKeyed] property's value type itself a
    // string-keyed dictionary?), not via a second attribute flavor.
    // A single field (not a static constructor — SonarS3963) whose initializer runs the reflection
    // walk once.
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

    // ---- minimal ISessionManager/IGameSession fakes ----
    //
    // The repository is hand-indexed twice directly, matching the established pattern from #272's
    // other AC5 tests (DuckDbRecordIndexTests/PlacementIndexingTests). session.Plugins gets
    // exactly one entry, which is all this test needs: it asserts the *shape* of the response's
    // column keys, not classification. Since #34 made pluginMasters/pluginParticipates
    // ColumnKey-keyed, that lone entry resolves masters/participation only for its own origin and
    // the other column falls back to the fail-open defaults — neither of which this test reads.
    // A real two-copy session is exercised end-to-end in DuplicateFilenameSessionApiTests.
    private sealed class FakeGameSession(IReadOnlyList<PluginMetadata> plugins) : IGameSession
    {
        public string DataFolderPath => throw new NotSupportedException();
        public GameRelease GameRelease => GameRelease.Fallout4;
        public IReadOnlyList<PluginMetadata> Plugins { get; } = plugins;
        public IReadOnlyList<PluginLoadFailure> LoadFailures => [];
        public string? FilterSql { get; set; }
        public IModGetter? GetMod(string pluginName, string origin) => throw new NotSupportedException();
        public PluginMetadata AddPlugin(string filePath) => throw new NotSupportedException();
        public PluginMetadata AddUnlistedPlugin(string filePath, string origin, int loadOrderIndex) => throw new NotSupportedException();
        public bool RemoveUnlistedPlugin(string pluginName, string origin) => throw new NotSupportedException();
        public void Dispose() { }
    }

    private sealed class FakeSessionManager(IGameSession session, IRecordReads repository) : ISessionManager
    {
        public IGameSession? Session => session;
        public IRecordReads? Repository => repository;
        // #415: this double exists for read-model shape assertions only — nothing here writes.
        public IRecordIndex? Index => null;
        // #274: these stubs never load, so they are always in the no-session state.
        public SessionStatus Status => SessionStatus.None;
        public void Load(string dataFolderPath, string pluginsTxtPath, GameRelease gameRelease) => throw new NotSupportedException();
        public void LoadExplicit(string gameDirectory, IReadOnlyList<ExplicitPluginInput> plugins, GameRelease gameRelease) => throw new NotSupportedException();
        public void Unload() => throw new NotSupportedException();
        public PluginResponse CreatePlugin(string name, string path, string origin) => throw new NotSupportedException();
        public PluginResponse LoadUnlistedPlugin(string path, string origin) => throw new NotSupportedException();
        public void UnloadUnlistedPlugin(string plugin, string origin) => throw new NotSupportedException();
        public PluginResponse RereadPlugin(string plugin, string newPath, string newOrigin) => throw new NotSupportedException();
        public Task ReindexPlugin(string plugin) => throw new NotSupportedException();
        public Task ReindexPlugins(IReadOnlyList<string> plugins) => throw new NotSupportedException();
        public void SetFilter(string sql) => throw new NotSupportedException();
        public void ClearFilter() => throw new NotSupportedException();
        public void ReapplyFilter() => throw new NotSupportedException();
    }

    [Fact]
    public void GetCompare_SameFilenameTwoOrigins_EveryDictionaryKeyIsARealColumnKey()
    {
        // Perk (not Npc): the one Fallout4 record type this fixture needs to carry both VMAD *and*
        // a top-level Conditions field at once, so a single record reaches every column-keyed
        // dictionary this test guards. VmadPropertyDiff.Raw is populated only for struct/structList
        // VMAD properties, and ConditionDiff.FieldCellStates/FieldResolutions are populated only
        // when the record has a condition at all — the two the old hand-typed allowlist missed
        // entirely. The old Npc-based fixture had neither: Npc has no top-level Conditions-bearing
        // field, and its one VMAD property was a plain scalar bool.
        var mod = new Fallout4Mod(ModKey.FromFileName("Shared.esp"), Fallout4Release.Fallout4);
        var perk = mod.Perks.AddNew("SharedPerk");

        var vmad = new PerkAdapter();
        var script = new ScriptEntry { Name = "S", Flags = ScriptEntry.Flag.Local };
        script.Properties.Add(new ScriptBoolProperty { Name = "IsActive", Data = true });

        // Struct property (kind "struct") — VmadPropertyDiff.Raw is populated only for struct/
        // structList, the exact gap the old allowlist ("raw" absent from ColumnDictProperties) left
        // unchecked.
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

        // A condition with a Run-On target of Reference (pointing at the Perk's own FormKey, which
        // is resolvable since the Perk itself is indexed) — populates ConditionDiff.FieldResolutions
        // for the "runOn" field id, not just FieldCellStates, so both nested dictionaries this test
        // guards actually carry real per-column content rather than being reached only vacuously
        // empty.
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
        repo.Index((IModGetter)mod, 0, participates: true, key: new PluginKey(mod.ModKey.FileName.ToString(), "ModA"));
        repo.Index((IModGetter)mod, 1, participates: true, key: new PluginKey(mod.ModKey.FileName.ToString(), "ModB"));
        repo.UpdateWinners();

        var plugins = new[] { new PluginMetadata("Shared.esp", "", 0, false, false, [], 1, false, Origin: "Data") };
        var session = new FakeSessionManager(new FakeGameSession(plugins), repo);
        var svc = new RecordQueryService(session, reflector, new ConflictClassifier());

        var compare = svc.GetCompare(perk.FormKey.ToString());

        Assert.NotNull(compare);
        var validKeys = compare.Overrides.Select(o => ColumnKey.Of(o.Plugin, o.Origin)).ToHashSet();
        // Sanity: the fixture really produced two distinct columns — if this is 1, CompareOverride
        // itself isn't carrying its own real Origin through GetCompare's annotation step.
        Assert.Equal(2, validKeys.Count);

        // Sanity: the walk below is only meaningful if it actually reaches non-empty struct/
        // structList Raw and non-empty condition dictionaries — assert that directly first, so a
        // future fixture regression that accidentally stops exercising these paths fails loudly
        // here rather than the JSON walk silently passing over empty objects.
        Assert.NotNull(compare.Vmad);
        var configProp = compare.Vmad.Scripts.Single().Properties.Single(p => p.Name == "Config");
        Assert.Equal("struct", configProp.Kind);
        Assert.NotEmpty(configProp.Raw ?? []);
        var itemsProp = compare.Vmad.Scripts.Single().Properties.Single(p => p.Name == "Items");
        Assert.Equal("structList", itemsProp.Kind);
        Assert.NotEmpty(itemsProp.Raw ?? []);

        Assert.NotNull(compare.Conditions);
        var condition = compare.Conditions.Groups.Single().Conditions.Single();
        Assert.True(condition.FieldCellStates.TryGetValue("runOn", out var runOnCellStates) && runOnCellStates.Count > 0);
        Assert.True(condition.FieldResolutions?.TryGetValue("runOn", out var runOnResolutions) == true && runOnResolutions.Count > 0);

        var json = JsonSerializer.SerializeToElement(compare, WireOptions);
        AssertEveryColumnDictKeyIsValid(json, validKeys);

        // The regression this test caught on arrival (#272, RecordQueryService.GetCompare): with
        // two identical, non-Data-origin columns, ModA (load order 0) is the master and ModB
        // (load order 1, identical fields) is IdenticalToMaster —
        // classification.PluginStates.GetValueOrDefault(o.Plugin, OnlyOne) missed both compound
        // keys (PluginStates is keyed by ColumnKey.Of since B3) and silently defaulted both
        // overrides to OnlyOne instead. Not a two-origin-only bug: elision only spares Data-origin
        // plugins, and almost no plugin in a real MO2 session is Data-origin (#269), so this was
        // live for essentially every conflicted record.
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
