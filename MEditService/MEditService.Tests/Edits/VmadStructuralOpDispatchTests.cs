using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #426 Track 0: VMAD's structural ops (<see cref="Core.Schema.VmadCodec.ApplyScriptOp"/>/
/// <see cref="Core.Schema.VmadCodec.ApplyPropertyOp"/>) survived #410 fully implemented and unit-
/// tested (<c>VmadCodecTests</c>) but orphaned — nothing on the write path reached them. This class
/// proves the dispatch wiring only: that <see cref="RecordEditService.EditField"/>, through
/// <c>RecordFieldWriter</c>, now reaches them and produces real working-tree dirt. The codec's own
/// behavior (which op does what) is not re-proven here.
///
/// <para>Wire contract: <c>fieldPath</c> addresses the script (or script+property) exactly as a
/// scalar VMAD edit does; <c>value</c> is either a plain scalar (unchanged #415 behavior) or an op
/// envelope — a JSON object carrying a string <c>"op"</c> member, reusing VmadCodec's own opName
/// vocabulary and doubling as its <c>op</c> parameter. See RecordFieldWriter.ApplyVmadField's own
/// doc comment for the one accepted ambiguity.</para>
/// </summary>
public sealed class VmadStructuralOpDispatchTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_AddScript_op_AttachesANewScriptAndWritesWorkingTreeDirt()
    {
        Assert.Empty(_mod.GitStatus());

        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\NewScript", Json("""{"op":"add_script","flags":"Local"}"""));

        Assert.True(result.Applied, result.Message);
        var relative = TrackedModFixture.RelativeSourcePath(_mod.Npc, "npc_").Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());

        var body = _mod.Sessions.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;
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
        var body = _mod.Sessions.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;
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
        var body = _mod.Sessions.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!;
        Assert.Contains("42", body, StringComparison.Ordinal);
    }

    // ── Guard inheritance (#417's carried requirement) ─────────────────────────────────────────
    // The new op-envelope dispatch above still enters through the one guarded door
    // (RecordEditService.EditField), never IRecordIndex.ApplyWorkingTreeChanges directly, so both
    // refusals below are green on arrival — proving that requires a rival, not just a passing
    // assertion (standing rule: a guard test is vacuous until watched fail). See this file's
    // companion rival run in the implementation report for the observed failure when the checks are
    // removed.

    [Fact]
    public void EditField_AddScriptOp_Refuses_WhileAnExternalChangeQuestionIsPendingForThePlugin()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "Fixture.esp changed outside Modbench.");

        var result = Service().EditField(
            _mod.Plugin, _mod.Npc.ToString(), @"VMAD\NewScript", Json("""{"op":"add_script"}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangePending, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_AddScriptOp_OnAnUntrackedModFolder_IsRefused_NamingTheTrackCommand()
    {
        using var untracked = TrackedModFixture.Untracked();
        var service = new RecordEditService(untracked.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.EditField(
            untracked.Plugin, untracked.Npc.ToString(), @"VMAD\NewScript", Json("""{"op":"add_script"}"""));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }
}
