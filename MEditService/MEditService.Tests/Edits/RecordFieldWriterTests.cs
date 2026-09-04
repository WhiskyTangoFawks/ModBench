using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// RecordFieldWriter.TryApply's own dispatch guards, exercised directly via
/// InternalsVisibleTo rather than through RecordEditService.EditField's full load order/tracked-mod
/// machinery — these are pure dispatch-routing questions with no working-tree side effects to
/// observe, so the lighter seam is the right one (per /tdd: test at the seam that matches what's
/// being proven).
/// </summary>
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
            cell, "cell", "is_partial_form", J("true"), NoSchemas);

        Assert.Equal(FieldApplyOutcome.Applied, outcome.Outcome);
        Assert.Equal(0x0000_4000, cell.MajorRecordFlagsRaw);
    }

    [Fact]
    public void TryApply_IsPartialForm_OnCell_SetFalse_Applied()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "SomeCell", MajorRecordFlagsRaw = 0x0000_4000 };

        var outcome = RecordFieldWriter.TryApply(
            cell, "cell", "is_partial_form", J("false"), NoSchemas);

        Assert.Equal(FieldApplyOutcome.Applied, outcome.Outcome);
        Assert.Equal(0, cell.MajorRecordFlagsRaw);
    }

    // The rival design gates on Mutagen's own
    // static IsPartialFormable reflection instead of PartialFormFlag's container-type gate. FO4's
    // Cell is not wired up for that static property (PartialFormFlag.cs's own doc) — a reflection
    // gate would wrongly refuse it. Guarded by asserting success on exactly the type the
    // real-world case names (Sim Settlements 2's Partial Form Cell overrides).
    [Fact]
    public void TryApply_IsPartialForm_OnNonPartialFormableType_ReturnsNotFound()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var npc = mod.Npcs.AddNew("SomeNpc");

        var outcome = RecordFieldWriter.TryApply(
            npc, "npc_", "is_partial_form", J("true"), NoSchemas);

        Assert.Equal(FieldApplyOutcome.NotFound, outcome.Outcome);
        Assert.Equal(0, npc.MajorRecordFlagsRaw);
    }

    [Fact]
    public void TryApply_IsPartialForm_NonBoolValue_ReturnsNotFound()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Test.esp"), Fallout4Release.Fallout4);
        var cell = new Cell(mod) { EditorID = "SomeCell" };

        var outcome = RecordFieldWriter.TryApply(
            cell, "cell", "is_partial_form", J("\"yes\""), NoSchemas);

        Assert.Equal(FieldApplyOutcome.NotFound, outcome.Outcome);
        Assert.Equal(0, cell.MajorRecordFlagsRaw);
    }
}
