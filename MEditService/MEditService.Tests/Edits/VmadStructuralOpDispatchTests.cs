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
