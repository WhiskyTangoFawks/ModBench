using System.Text.Json.Nodes;
using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using Mutagen.Bethesda.Fallout4;

namespace MEditService.Index.Tests.Query;

public sealed class DeclaredDefaultConflictTests
{
    private static void Scripted(Npc npc) => npc.VirtualMachineAdapter = new VirtualMachineAdapter();

    [Theory]
    [InlineData("""{"ObjectFormat":2}""", ConflictThis.IdenticalToMaster)]
    [InlineData("""{"ObjectFormat":2.0}""", ConflictThis.IdenticalToMaster)]
    [InlineData("""{"ObjectFormat":0}""", ConflictThis.Override)]
    public void AbsentObjectFormatIsTheDeclaredTwo_NotZero(string spelled, ConflictThis expected)
    {
        var result = ComparedCopies.Spelled<Npc>(
            "B.esp", document => document["VirtualMachineAdapter"] = JsonNode.Parse(spelled), Scripted, Scripted);

        var objectFormat = (result.Diffs.Single(d => d.FieldName == "VirtualMachineAdapter").Children
            ?? throw new InvalidOperationException("Expected the adapter's diff to have children."))
            .Single(c => c.FieldName == "ObjectFormat");
        Assert.Equal(expected, objectFormat.CellStates["B.esp"]);
    }
}
