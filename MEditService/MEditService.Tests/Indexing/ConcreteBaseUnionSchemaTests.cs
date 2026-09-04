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

/// <summary>
/// #701: a concrete Loqui base with subclasses in the same assembly (ScriptProperty and its
/// fourteen leaves) is a union like an abstract one, with the base itself as one more leaf. VMAD
/// is the one such union that matters and it is excluded from the shipped schema by design, so
/// every test here lifts that exclusion through the annotation seam.
/// </summary>
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

    /// <summary>
    /// The chain is real: a script's entry holds properties, a struct property's members are
    /// entries again. Fallout 4's own table names the struct leaves as the point its Papyrus
    /// cannot nest past; with that ruling withdrawn the re-entry is a true cycle, and generation
    /// fails naming it rather than walking until the stack gives out.
    /// </summary>
    [Fact]
    public void ReEntryWithNoDocumentedTruncation_FailsSchemaGenerationNamingTheChain()
    {
        var reflector = AmendedSchemaReflector.Fallout4With(a => a with { CycleTruncations = [] });

        var ex = Assert.Throws<InvalidOperationException>(() => reflector.GetSchemas(GameRelease.Fallout4));

        const string chain = "IScriptEntryGetter -> IScriptPropertyGetter -> IScriptStructPropertyGetter -> IScriptEntryGetter";
        Assert.True(ex.Message.Contains(chain, StringComparison.Ordinal), ex.Message);
    }

    /// <summary>
    /// Eight leaves declare <c>Data</c> and disagree on its shape — int, float, bool, string and a
    /// list of each — so one shared field cannot carry it. The name is split by shape instead,
    /// each split field reading off exactly the leaves of that shape.
    /// </summary>
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

    /// <summary>
    /// A Fallout 4 Papyrus struct member is never a struct or a struct array, so inside either
    /// struct leaf the walk offers neither again: the nested property's choice of kind is the
    /// thirteen non-struct leaves, and the chain ends there.
    /// </summary>
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

    /// <summary>
    /// The one concrete-base union the shipped schema reaches: Landscape.Layers, BaseLayer with
    /// AlphaLayer under it. An AlphaLayer is a BaseLayer too, so the base must not claim it.
    /// </summary>
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

    /// <summary>
    /// The scan the ticket asked for, pinned against the compiled assembly rather than the source
    /// clone: every concrete Loqui class with a concrete subclass. Each has a ruling — ScriptProperty
    /// and BaseLayer are expanded, ASceneActionType is excluded by annotation, and the other three
    /// sit behind shapes the walk never enters (a dictionary, a gendered item, VMAD fragments). A
    /// Mutagen bump that changes this set fails here, where the rulings can be revisited.
    /// </summary>
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
