using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// VMAD's structural ops (<see cref="Core.Schema.VmadCodec.ApplyScriptOp"/>/
/// <see cref="Core.Schema.VmadCodec.ApplyPropertyOp"/>) are unit-tested at the codec
/// (<c>VmadCodecTests</c>); this class
/// proves the dispatch wiring only: that <see cref="RecordEditService.EditField"/>, through
/// <c>RecordFieldWriter</c>, reaches them and produces real working-tree dirt. The codec's own
/// behavior (which op does what) is not re-proven here.
///
/// <para>Wire contract: <c>fieldPath</c> addresses the script (or script+property) exactly as a
/// scalar VMAD edit does; <c>value</c> is either a plain scalar or an op
/// envelope — a JSON object carrying a string <c>"op"</c> member, reusing VmadCodec's own opName
/// vocabulary and doubling as its <c>op</c> parameter. See RecordFieldWriter.ApplyVmadField's own
/// doc comment for the one accepted ambiguity.</para>
/// </summary>
public sealed class VmadStructuralOpDispatchTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_AddScript_op_AttachesANewScriptAndWritesWorkingTreeDirt()
    {
        Assert.Empty(_mod.GitStatus());

        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\NewScript", Json("""{"op":"add_script","flags":"Local"}"""));

        Assert.True(result.Applied, result.Message);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());

        var body = _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;
        Assert.Contains("NewScript", body, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_RemovePropertyOp_RemovesTheNamedPropertyFromTheScript()
    {
        var service = Service();
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr", Json("""{"op":"add_script"}"""));
        service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Counter",
            Json("""{"op":"add_property","name":"Counter","type":"Int","value":1}"""));

        var result = service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Counter", Json("""{"op":"remove_property"}"""));

        Assert.True(result.Applied, result.Message);
        var body = _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;
        Assert.DoesNotContain("Counter", body, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_UnknownOpName_RefusesAsFieldNotFound_NeverThrows()
    {
        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\NewScript", Json("""{"op":"not_a_real_op"}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }

    // A Struct property's own scalar write is a plain JSON object with no "op" member — this pins
    // that the op-envelope heuristic never swallows an ordinary struct-shaped scalar write.
    [Fact]
    public void EditField_PlainScalarVmadWrite_IsUnaffectedByTheOpEnvelopeCheck()
    {
        var service = Service();
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr", Json("""{"op":"add_script"}"""));
        service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Counter",
            Json("""{"op":"add_property","name":"Counter","type":"Int","value":1}"""));

        var result = service.EditField(_mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Counter", Json("42"));

        Assert.True(result.Applied, result.Message);
        var body = _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;
        Assert.Contains("42", body, StringComparison.Ordinal);
    }

    // Malformed struct-op payloads never crash, they fall back to NotFound like any other
    // shape RecordFieldWriter.ApplyVmadField doesn't recognize.

    // No "op" member at all, targeting a script-level path — TryGetOpName answers false (not an op
    // envelope), and a script-level path has no scalar "whole script" value to fall back to, so the
    // scalar branch's own VmadPath.TryParse also fails. Distinct from
    // EditField_PlainScalarVmadWrite_IsUnaffectedByTheOpEnvelopeCheck above, which targets a
    // script+property path where the same non-envelope object *is* a legal scalar Struct write.
    [Fact]
    public void EditField_ObjectValueMissingOpMember_OnScriptLevelPath_RefusesAsFieldNotFound_NeverThrows()
    {
        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\NewScript", Json("""{"flags":"Local"}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }

    // A well-formed op envelope (valid "op" string) whose path is neither a script+property path nor
    // a bare script path — here, the bare "VMAD\" prefix with nothing after it, which fails both
    // VmadPath.TryParse and VmadPath.TryParseScript.
    [Fact]
    public void EditField_OpEnvelope_OnUnparseableVmadPath_RefusesAsFieldNotFound_NeverThrows()
    {
        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\", Json("""{"op":"add_script"}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
    }

    // ── Scalar-array element ops (#658) ───────────────────────────────────────────────────────────
    // Relocated from RecordPanel.tsx's client-side computation into VmadCodec's own
    // add_element/remove_element/move_element_up/move_element_down — same dispatch-only posture as
    // the rest of this class (VmadCodecTests pins the codec's own arithmetic).

    private RecordEditService SeedIntListProperty(string values)
    {
        var service = Service();
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr", Json("""{"op":"add_script"}"""));
        var seed = service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Levels",
            Json($$"""{"op":"add_property","name":"Levels","type":"ArrayOfInt","value":{{values}}}"""));
        Assert.True(seed.Applied, seed.Message);
        return service;
    }

    [Fact]
    public void EditField_AddElementOp_AppendsAndWritesWorkingTreeDirt()
    {
        var service = SeedIntListProperty("[1,2,3]");

        var result = service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Levels", Json("""{"op":"add_element"}"""));

        Assert.True(result.Applied, result.Message);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
    }

    [Fact]
    public void EditField_RemoveElementOp_RemovesAndWritesWorkingTreeDirt()
    {
        var service = SeedIntListProperty("[1,2,3]");

        var result = service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Levels",
            Json("""{"op":"remove_element","index":1}"""));

        Assert.True(result.Applied, result.Message);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
    }

    /// <summary>
    /// The boundary case that matters most: #630 established the codec's own reserialization is not
    /// byte-stable, so a no-op that fell through to an ordinary write would leave real,
    /// <c>git status --porcelain</c>-visible dirt for an operation that changed nothing — the same
    /// reasoning <see cref="ArrayOpEditTests.ArrayRemove_IndexPastTheEnd_IsANoOpThatCommitsNothing"/>
    /// pins for the generic path. Unlike that test, this one cannot start from a pristine
    /// <c>git status --porcelain</c> baseline: a VMAD property has to be added before it can be
    /// addressed at all (add_script + add_property), and that seed is itself a real edit that
    /// already dirties the one source file this fixture's NPC lives in — a second, further change to
    /// that <i>same</i> file would still porcelain-report as a single unchanged "M path" line, so
    /// comparing <c>git status --porcelain</c> before/after the op under test cannot tell "nothing
    /// further changed" apart from "something further changed" (both look identical at file
    /// granularity). Comparing the record's own serialized body before/after is the content-level
    /// equivalent of the same check <see cref="TrackedModFixture.GitStatus"/> makes at file
    /// granularity elsewhere in this class — precise where file-level status cannot be: asserting
    /// <c>Applied</c> alone would pass even for a rival that clamps the index and removes some other
    /// element, or one that re-serializes the array back byte-for-byte anyway.
    /// </summary>
    [Fact]
    public void EditField_RemoveElementOp_OutOfRangeIndexIsANoOpThatCommitsNothing()
    {
        var service = SeedIntListProperty("[1,2,3]");
        var bodyBeforeOp = _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

        var result = service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Levels",
            Json("""{"op":"remove_element","index":5}"""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(bodyBeforeOp, _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!);
    }

    [Fact]
    public void EditField_MoveElementUpOp_TheFirstElementIsANoOpThatCommitsNothing()
    {
        var service = SeedIntListProperty("[1,2,3]");
        var bodyBeforeOp = _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

        var result = service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Levels",
            Json("""{"op":"move_element_up","index":0}"""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(bodyBeforeOp, _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!);
    }

    [Fact]
    public void EditField_MoveElementDownOp_TheLastElementIsANoOpThatCommitsNothing()
    {
        var service = SeedIntListProperty("[1,2,3]");
        var bodyBeforeOp = _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;

        var result = service.EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\Scr\Levels",
            Json("""{"op":"move_element_down","index":2}"""));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(bodyBeforeOp, _mod.Mirror.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!);
    }

    // ── Guard inheritance ──────────────────────────────────────────────────────────────────────
    // The op-envelope dispatch above still enters through the one guarded door
    // (RecordEditService.EditField), never IRecordIndex.ApplyWorkingTreeChanges directly. Proving
    // that requires a rival, not just a passing assertion (standing rule: a guard test is vacuous
    // until watched fail) — the rival, with the checks removed, was observed to fail both.

    [Fact]
    public void EditField_AddScriptOp_Refuses_WhileAnExternalChangeQuestionIsUnansweredForThePlugin()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "Fixture.esp changed outside Modbench.");

        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\NewScript", Json("""{"op":"add_script"}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_AddScriptOp_OnAnUntrackedModFolder_IsRefused_NamingTheTrackCommand()
    {
        using var untracked = TrackedModFixture.Untracked();
        var service = new RecordEditService(untracked.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.EditField(
            untracked.Plugin, untracked.Npc.ToString(), @"VMAD\NewScript", Json("""{"op":"add_script"}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }
}
