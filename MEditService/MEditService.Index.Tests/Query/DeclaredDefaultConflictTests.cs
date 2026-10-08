using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.LoadOrder;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Index.Tests.Query;

public sealed class DeclaredDefaultConflictTests
{
    private static FieldMetadata Vmad =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"]
            .RecordColumns.Single(c => c.Name == "VirtualMachineAdapter").ToFieldMetadata();

    [Theory]
    [InlineData("""{"ObjectFormat":2}""", ConflictThis.IdenticalToMaster)]
    [InlineData("""{"ObjectFormat":0}""", ConflictThis.Override)]
    public void AbsentObjectFormatIsTheDeclaredTwo(string overrideJson, ConflictThis expected)
    {
        var meta = Vmad;
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null, [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>("{}"))], PluginOrigin.DataDirectory, RecordType: "Npc");
        var spelled = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null, [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>(overrideJson))], PluginOrigin.DataDirectory, RecordType: "Npc");

        var result = CompareQuery.Classify([master, spelled]);
        var objectFormat = (Assert.Single(result.Diffs).Children
            ?? throw new InvalidOperationException("Expected the ObjectFormat diff to have children."))
            .Single(c => c.FieldName == "ObjectFormat");

        Assert.Equal(expected, objectFormat.CellStates["B.esp"]);
    }
}
