using MEditService.Core.Queries;
using MEditService.Core.Schema;
using Mutagen.Bethesda;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #701: a concrete Loqui base with subclasses in the same assembly (ScriptProperty and its
/// fourteen leaves) is a union like an abstract one, with the base itself as one more leaf. VMAD
/// is the one such union that matters and it is excluded from the shipped schema by design, so
/// every test here lifts that exclusion through the annotation seam.
/// </summary>
public sealed class ConcreteBaseUnionSchemaTests
{
    private static SchemaReflector Fallout4With(Func<SchemaAnnotations, SchemaAnnotations> amend) =>
        new(category => amend(SchemaAnnotations.For(category)));

    private static SchemaAnnotations WithVmadReflected(SchemaAnnotations a) =>
        a with { ExcludedUnions = [.. a.ExcludedUnions.Where(u => u != "AVirtualMachineAdapter")] };

    private static SchemaReflector Fallout4WithVmadReflected() => Fallout4With(WithVmadReflected);

    private static ColumnSpec NpcAdapterColumn(SchemaReflector reflector) =>
        reflector.GetSchemas(GameRelease.Fallout4)["npc_"].RecordColumns
            .Single(c => c.Name == "virtual_machine_adapter");

    [Fact]
    public void VmadExclusionLifted_AdapterIsAnOrdinaryStructColumn()
    {
        var column = NpcAdapterColumn(Fallout4WithVmadReflected());

        Assert.Equal("struct", column.ApiType);
        Assert.Contains(column.SubFields!, f => f.Name == "scripts");
    }

    private static FieldMetadata ScriptPropertyElement(ColumnSpec adapter) =>
        adapter.SubFields!.Single(f => f.Name == "scripts").ElementType!
            .Fields!.Single(f => f.Name == "properties").ElementType!;

    [Fact]
    public void ScriptProperty_ConcreteType_ListsFourteenLeavesAndTheBaseItself()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(Fallout4WithVmadReflected()));

        var discriminator = element.Fields!.Single(f => f.Name == "concrete_type");
        Assert.Equal("enum", discriminator.Type);
        Assert.Equal(
            [
                "ScriptBoolListProperty", "ScriptBoolProperty", "ScriptFloatListProperty", "ScriptFloatProperty",
                "ScriptIntListProperty", "ScriptIntProperty", "ScriptObjectListProperty", "ScriptObjectProperty",
                "ScriptProperty", "ScriptStringListProperty", "ScriptStringProperty", "ScriptStructListProperty",
                "ScriptStructProperty", "ScriptVariableListProperty", "ScriptVariableProperty",
            ],
            discriminator.EnumValues.Order(StringComparer.Ordinal));
    }

    /// <summary>
    /// The chain is real: a script's entry holds properties, a struct property's members are
    /// entries again. Fallout 4's own table names the struct leaves as the point its Papyrus
    /// cannot nest past; with that ruling withdrawn the re-entry is a true cycle, and generation
    /// fails naming it rather than walking until the stack gives out.
    /// </summary>
    [Fact]
    public void ReEntryWithNoDocumentedTruncation_FailsSchemaGenerationNamingTheChain()
    {
        var reflector = Fallout4With(a => WithVmadReflected(a) with { CycleTruncations = [] });

        var ex = Assert.Throws<InvalidOperationException>(() => reflector.GetSchemas(GameRelease.Fallout4));

        Assert.Contains(
            "IScriptEntryGetter -> IScriptStructPropertyGetter -> IScriptEntryGetter",
            ex.Message, StringComparison.Ordinal);
    }

    /// <summary>
    /// Eight leaves declare <c>Data</c> and disagree on its shape — int, float, bool, string and a
    /// list of each — so one shared field cannot carry it. The name is split by shape instead,
    /// each split field reading off exactly the leaves of that shape.
    /// </summary>
    [Fact]
    public void ScriptProperty_DataMember_IsOneFieldPerShape()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(Fallout4WithVmadReflected()));

        var data = element.Fields!.Where(f => f.Name.StartsWith("data", StringComparison.Ordinal))
            .ToDictionary(f => f.Name, f => f.IsArray ? f.ElementType!.Type + "[]" : f.Type);
        Assert.Equal(new Dictionary<string, string>
        {
            ["data_int"] = "int", ["data_float"] = "float", ["data_bool"] = "bool", ["data_string"] = "string",
            ["data_int_array"] = "int[]", ["data_float_array"] = "float[]",
            ["data_bool_array"] = "bool[]", ["data_string_array"] = "string[]",
        }, data);
    }

    [Fact]
    public void ScriptProperty_ObjectLeafAndStructLeaf_ExposeTheirOwnMembers()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(Fallout4WithVmadReflected()));
        var byName = element.Fields!.ToDictionary(f => f.Name);

        Assert.Equal("formKey", byName["object"].Type);
        Assert.Equal("int", byName["alias"].Type);
        Assert.True(byName["members"].IsArray);
        var member = byName["members"].ElementType!.Fields!.ToDictionary(f => f.Name);
        Assert.Equal("string", member["name"].Type);
        Assert.True(member["properties"].IsArray);
    }
}
