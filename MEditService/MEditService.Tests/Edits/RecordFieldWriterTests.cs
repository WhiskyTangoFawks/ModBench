using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #401: RecordFieldWriter.TryApply's own dispatch guards, exercised directly via
/// InternalsVisibleTo rather than through RecordEditService.EditField's full session/tracked-mod
/// machinery — these are pure dispatch-routing questions with no working-tree side effects to
/// observe, so the lighter seam is the right one (per /tdd: test at the seam that matches what's
/// being proven).
/// </summary>
public sealed class RecordFieldWriterTests
{
    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement;

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> NoSchemas =
        new Dictionary<string, RecordTableSchema>();

    // ConditionCodecRegistry only registers Fallout4 (ADR-0032) — any other game's condition-field
    // and whole-list writes must answer NotFound rather than null-reference on a missing codec.
    // GameRelease.SkyrimSE is used only for its GameCategory; the record itself can stay a
    // Fallout4-typed instance, since ApplyConditionField resolves the codec before ever touching it.
    [Fact]
    public void TryApply_ConditionScalarField_NoCodecForGame_ReturnsNotFound()
    {
        var cobj = new ConstructibleObject(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);
        cobj.Conditions.Add(new ConditionFloat { Data = new FunctionConditionData { Function = Condition.Function.GetIsID } });

        var outcome = RecordFieldWriter.TryApply(
            cobj, "ConstructibleObject", @"CTDA\Conditions\0\Operator", J("\"GreaterThan\""),
            NoSchemas, GameRelease.SkyrimSE);

        Assert.Equal(FieldApplyOutcome.NotFound, outcome);
    }

    // The whole-list dispatch (TryApply's own `codec != null && codec.IsConditionListField(...)`
    // checks, both short-circuiting past ApplyConditionListField entirely when codec is null) never
    // calls IsConditionListField on a missing codec — it falls through to the ordinary reflected-
    // column lookup instead, which also finds nothing for "Conditions" and answers NotFound the same
    // safe way, never a NullReferenceException from either guard.
    [Fact]
    public void TryApply_ConditionWholeListField_NoCodecForGame_ReturnsNotFound()
    {
        var cobj = new ConstructibleObject(FormKey.Factory("001234:Test.esp"), Fallout4Release.Fallout4);

        var outcome = RecordFieldWriter.TryApply(
            cobj, "ConstructibleObject", "Conditions", J("[]"), NoSchemas, GameRelease.SkyrimSE);

        Assert.Equal(FieldApplyOutcome.NotFound, outcome);
    }
}
