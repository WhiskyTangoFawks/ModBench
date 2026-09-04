using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

/// <summary>A concrete Loqui base with subclasses in the same assembly (ScriptProperty and its
/// fourteen leaves) is a union like an abstract one, with the base itself as one more leaf.</summary>
public sealed class ConcreteBaseUnionSchemaTests
{
    private static ColumnSpec NpcAdapterColumn(SchemaReflector reflector) =>
        reflector.GetSchemas(GameRelease.Fallout4)["npc_"].RecordColumns
            .Single(c => c.Name == "virtual_machine_adapter");

    [Fact]
    public void VmadExclusionLifted_AdapterIsAnOrdinaryStructColumn()
    {
        var column = NpcAdapterColumn(SharedSchemaReflector.Instance);

        Assert.Equal("struct", column.ApiType);
        Assert.Contains(column.SubFields!, f => f.Name == "scripts");
    }

    private static FieldMetadata ScriptPropertyElement(ColumnSpec adapter) =>
        adapter.SubFields!.Single(f => f.Name == "scripts").ElementType!
            .Fields!.Single(f => f.Name == "properties").ElementType!;

    [Fact]
    public void ScriptProperty_ConcreteType_ListsFourteenLeavesAndTheBaseItself()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(SharedSchemaReflector.Instance));

        var discriminator = element.Fields!.Single(f => f.Name == "concrete_type");
        Assert.Equal("enum", discriminator.Type);
        Assert.Equal(
            [
                "ScriptBoolListProperty", "ScriptBoolProperty", "ScriptFloatListProperty", "ScriptFloatProperty",
                "ScriptIntListProperty", "ScriptIntProperty", "ScriptObjectListProperty", "ScriptObjectProperty",
                "ScriptProperty", "ScriptStringListProperty", "ScriptStringProperty", "ScriptStructListProperty",
                "ScriptStructProperty", "ScriptVariableListProperty", "ScriptVariableProperty",
            ],
            discriminator.EnumMembers.Select(m => m.Value).Order(StringComparer.Ordinal));
    }

    [Fact]
    public void ReEntryWithNoDocumentedTruncation_FailsSchemaGenerationNamingTheChain()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { CycleTruncations = [] });

        var ex = Assert.Throws<InvalidOperationException>(() => reflector.GetSchemas(GameRelease.Fallout4));

        const string chain = "IScriptEntryGetter -> IScriptPropertyGetter -> IScriptStructPropertyGetter -> IScriptEntryGetter";
        Assert.True(ex.Message.Contains(chain, StringComparison.Ordinal), ex.Message);
    }

    [Fact]
    public void ScriptProperty_DataMember_IsOneFieldPerShape()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(SharedSchemaReflector.Instance));

        var data = element.Fields!.Where(f => f.Name.StartsWith("data", StringComparison.Ordinal))
            .ToDictionary(f => f.Name, f => f.IsArray ? f.ElementType!.Type + "[]" : f.Type);
        Assert.Equal(new Dictionary<string, string>
        {
            ["data_int"] = "int",
            ["data_float"] = "float",
            ["data_bool"] = "bool",
            ["data_string"] = "string",
            ["data_int_array"] = "int[]",
            ["data_float_array"] = "float[]",
            ["data_bool_array"] = "bool[]",
            ["data_string_array"] = "string[]",
        }, data);
    }

    [Fact]
    public void ScriptProperty_ObjectLeafAndStructLeaf_ExposeTheirOwnMembers()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(SharedSchemaReflector.Instance));
        var byName = element.Fields!.ToDictionary(f => f.Name);

        Assert.Equal("formKey", byName["object"].Type);
        Assert.Equal("int", byName["alias"].Type);
        Assert.True(byName["members"].IsArray);
        var member = byName["members"].ElementType!.Fields!.ToDictionary(f => f.Name);
        Assert.Equal("string", member["name"].Type);
        Assert.True(member["properties"].IsArray);
    }

    [Theory]
    [InlineData("members")]
    [InlineData("structs")]
    public void InsideAStructLeaf_NeitherStructLeafIsOfferedAgain(string structLeafList)
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(SharedSchemaReflector.Instance));
        var nestedElement = element.Fields!.Single(f => f.Name == structLeafList).ElementType!;
        var nestedProperty = nestedElement.Fields!.Single(f => f.Name == (structLeafList == "members" ? "properties" : "members")).ElementType!;

        var kinds = nestedProperty.Fields!.Single(f => f.Name == "concrete_type")
            .EnumMembers.Select(m => m.Value).ToList();
        Assert.Equal(13, kinds.Count);
        Assert.DoesNotContain("ScriptStructProperty", kinds);
        Assert.DoesNotContain("ScriptStructListProperty", kinds);
        Assert.DoesNotContain(nestedProperty.Fields!, f => f.Name is "members" or "structs");
    }

    [Fact]
    public void LandscapeLayers_AnAlphaLayerElement_ReadsAsAlphaLayerNotAsItsBase()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Layers701.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod.GetNextFormKey("Cell701"), Fallout4Release.Fallout4)
        {
            Landscape = new Landscape(mod.GetNextFormKey("Land701"), Fallout4Release.Fallout4)
            {
                Layers = [new BaseLayer(), new AlphaLayer { AlphaLayerData = new byte[] { 1, 2 } }],
            },
        };

        var column = SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["cell"]
            .RecordColumns.Single(c => c.Name == "landscape");
        var layers = JsonDocument.Parse((string)column.Extract((IMajorRecordGetter)cell)!)
            .RootElement.GetProperty("layers");

        Assert.Equal("BaseLayer", layers[0].GetProperty("concrete_type").GetString());
        Assert.Equal("AlphaLayer", layers[1].GetProperty("concrete_type").GetString());
        Assert.Equal("0x0102", layers[1].GetProperty("alpha_layer_data").GetString());
    }

    // The pin is asserted so a Mutagen bump that changes the concrete-base census fails here, where
    // each ruling can be revisited, rather than silently widening the schema.
    [Fact]
    public void ConcreteBasesWithSubclasses_InThePinnedFallout4Assembly_AreExactlyTheRuledOnSix()
    {
        var assembly = typeof(Fallout4Mod).Assembly;
        Assert.Equal("0.53.1.0", assembly.GetName().Version!.ToString());

        static bool IsLoquiClass(Type t) =>
            t.IsClass && !t.IsAbstract && !t.ContainsGenericParameters && !t.Name.EndsWith("BinaryOverlay", StringComparison.Ordinal)
            && t.GetProperty("StaticRegistration", BindingFlags.Public | BindingFlags.Static) != null;
        var classes = assembly.GetTypes().Where(IsLoquiClass).ToList();
        var concreteBases = classes
            .Where(b => classes.Any(t => t != b && b.IsAssignableFrom(t)))
            .Select(b => b.Name)
            .Order(StringComparer.Ordinal);

        Assert.Equal(
            ["APackageData", "ASceneActionType", "BaseLayer", "ScriptFragments", "ScriptProperty", "SimpleModel"],
            concreteBases);
    }
}
