using System.Text.Json;
using MEditService.Codec.Schema;
using MEditService.Index;
using MEditService.Queries;
using MEditService.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Queries.Tests.Query;

/// <summary>An absent member is the default the schema declares, not the CLR zero, so the
/// classifier reads the metadata's default rather than assuming nothing (ADR-0005).</summary>
public sealed class DeclaredDefaultConflictTests
{
    private static FieldMetadata Vmad =>
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4)["npc_"]
            .RecordColumns.Single(c => c.Name == "VirtualMachineAdapter").ToFieldMetadata();

    // The pin: with the real schema, an npc_ omitting ObjectFormat is the same as one spelling 2,
    // and one spelling 0 is a conflict.
    [Theory]
    [InlineData("""{"ObjectFormat":2}""", ConflictThis.IdenticalToMaster)]
    [InlineData("""{"ObjectFormat":0}""", ConflictThis.Override)]
    public void Classify_AbsentObjectFormat_IsTheDeclaredTwo(string overrideJson, ConflictThis expected)
    {
        var meta = Vmad;
        var master = new RecordDetail("000001:Test.esp", "A.esp", 0, false, null, [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>("{}"))], "Data");
        var spelled = new RecordDetail("000001:Test.esp", "B.esp", 1, true, null, [new FieldValue(meta, JsonSerializer.Deserialize<JsonElement>(overrideJson))], "Data");

        var result = new ConflictClassifier().Classify([master, spelled], new Dictionary<string, IReadOnlyList<string>>(), GameRelease.Fallout4);
        var objectFormat = (Assert.Single(result.Diffs).Children
            ?? throw new InvalidOperationException("Expected the ObjectFormat diff to have children."))
            .Single(c => c.FieldName == "ObjectFormat");

        Assert.Equal(expected, objectFormat.CellStates["B.esp"]);
    }
}
