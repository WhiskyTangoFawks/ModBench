using System.Reflection;
using System.Text.Json;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
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
            .Single(c => c.Name == "VirtualMachineAdapter");

    [Fact]
    public void VirtualMachineAdapterColumn_IsAStructColumn_WithAScriptsSubfield()
    {
        var column = NpcAdapterColumn(SharedSchemaReflector.Instance);

        Assert.Equal("struct", column.ApiType);
        Assert.Contains(column.SubFields!, f => f.Name == "Scripts");
    }

    private static FieldMetadata ScriptPropertyElement(ColumnSpec adapter) =>
        adapter.SubFields!.Single(f => f.Name == "Scripts").ElementType!
            .Fields!.Single(f => f.Name == "Properties").ElementType!;

    [Fact]
    public void ScriptProperty_ConcreteType_ListsFourteenLeavesAndTheBaseItself()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(SharedSchemaReflector.Instance));

        var discriminator = element.Fields!.Single(f => f.Name == "MutagenObjectType");
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
    public void ScriptProperty_ObjectLeafAndStructLeaf_ExposeTheirOwnMembers()
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(SharedSchemaReflector.Instance));
        var byName = element.Fields!.ToDictionary(f => f.Name);

        Assert.Equal("formKey", byName["Object"].Type);
        Assert.Equal("int", byName["Alias"].Type);
        Assert.True(byName["Members"].IsArray);
        var member = byName["Members"].ElementType!.Fields!.ToDictionary(f => f.Name);
        Assert.Equal("string", member["Name"].Type);
        Assert.True(member["Properties"].IsArray);
    }

    [Theory]
    [InlineData("Members")]
    [InlineData("Structs")]
    public void InsideAStructLeaf_NeitherStructLeafIsOfferedAgain(string structLeafList)
    {
        var element = ScriptPropertyElement(NpcAdapterColumn(SharedSchemaReflector.Instance));
        var nestedElement = element.Fields!.Single(f => f.Name == structLeafList).ElementType!;
        var nestedProperty = nestedElement.Fields!.Single(f => f.Name == (structLeafList == "Members" ? "Properties" : "Members")).ElementType!;

        var kinds = nestedProperty.Fields!.Single(f => f.Name == "MutagenObjectType")
            .EnumMembers.Select(m => m.Value).ToList();
        Assert.Equal(13, kinds.Count);
        Assert.DoesNotContain("ScriptStructProperty", kinds);
        Assert.DoesNotContain("ScriptStructListProperty", kinds);
        Assert.DoesNotContain(nestedProperty.Fields!, f => f.Name is "Members" or "Structs");
    }

    [Fact]
    public async Task LandscapeLayers_AnAlphaLayerElement_ReadsAsAlphaLayerNotAsItsBase()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Layers701.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod.GetNextFormKey("Cell701"), Fallout4Release.Fallout4)
        {
            Landscape = new Landscape(mod.GetNextFormKey("Land701"), Fallout4Release.Fallout4)
            {
                Layers = [new BaseLayer(), new AlphaLayer { AlphaLayerData = new byte[] { 1, 2 } }],
            },
        };

        var body = await new RecordTextCodec(NullLogger<RecordTextCodec>.Instance)
            .SerializeToBytesAsync(cell, GameRelease.Fallout4);
        using var document = JsonDocument.Parse(body);
        var layers = document.RootElement.GetProperty("Landscape").GetProperty("Layers");

        Assert.Equal("BaseLayer", layers[0].GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString());
        Assert.Equal("AlphaLayer", layers[1].GetProperty(LoquiUnions.UnionTypeDiscriminator).GetString());
        Assert.Equal("0x0102", layers[1].GetProperty("AlphaLayerData").GetString());
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
