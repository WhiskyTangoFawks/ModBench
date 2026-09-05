using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>Exercised directly via InternalsVisibleTo: these are pure dispatch-routing questions
/// with no working-tree side effects, so the lighter seam is the right one.</summary>
public sealed class RecordFieldWriterTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement;

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> NoSchemas =
        new Dictionary<string, RecordTableSchema>();

    // is_partial_form dispatches ahead of the reflected columns, same tier as editor_id —
    // MajorRecordHeaderMembers excludes MajorRecordFlagsRaw from the reflected schema entirely, so NoSchemas here
    // proves the dispatch never needs a schema lookup to reach it.
    [Fact]
    public void TryApply_IsPartialForm_OnCell_SetTrue_Applied()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "SomeCell" };

        var outcome = RecordFieldWriter.TryApply(
            cell, "Cell", "is_partial_form", J("true"), NoSchemas, "{}");

        Assert.Equal(FieldApplyOutcome.Applied, outcome.Outcome);
        Assert.Equal(0x0000_4000, cell.MajorRecordFlagsRaw);
    }

    [Fact]
    public void TryApply_IsPartialForm_OnCell_SetFalse_Applied()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "SomeCell", MajorRecordFlagsRaw = 0x0000_4000 };

        var outcome = RecordFieldWriter.TryApply(
            cell, "Cell", "is_partial_form", J("false"), NoSchemas, "{}");

        Assert.Equal(FieldApplyOutcome.Applied, outcome.Outcome);
        Assert.Equal(0, cell.MajorRecordFlagsRaw);
    }

    // The rival gates on Mutagen's static IsPartialFormable reflection instead of PartialFormFlag's
    // container-type gate.
    [Fact]
    public void TryApply_IsPartialForm_OnNonPartialFormableType_ReturnsNotFound()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("SomeNpc");

        var outcome = RecordFieldWriter.TryApply(
            npc, "npc_", "is_partial_form", J("true"), NoSchemas, "{}");

        Assert.Equal(FieldApplyOutcome.NotFound, outcome.Outcome);
        Assert.Equal(0, npc.MajorRecordFlagsRaw);
    }

    [Fact]
    public void TryApply_IsPartialForm_NonBoolValue_ReturnsNotFound()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "SomeCell" };

        var outcome = RecordFieldWriter.TryApply(
            cell, "Cell", "is_partial_form", J("\"yes\""), NoSchemas, "{}");

        Assert.Equal(FieldApplyOutcome.NotFound, outcome.Outcome);
        Assert.Equal(0, cell.MajorRecordFlagsRaw);
    }
}
