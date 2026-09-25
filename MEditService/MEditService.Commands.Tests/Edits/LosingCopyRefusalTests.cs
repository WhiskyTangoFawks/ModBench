using System.Text.Json;
using MEditService.Commands;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A losing copy is read-only (ADR-0012 invariant 5), refused before any source write.
/// The same write against the winning copy of the same name lands.</summary>
public sealed class LosingCopyRefusalTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditingALosingCopy_IsRefused_NamingThePluginItsOriginAndThatTheGameDoesNotLoadIt()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.EditHandler.Set(mod.LosingPlugin, mod.LosingNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LosingCopy, result.Refusal);
        Assert.Contains(LosingCopyFixture.PluginName, result.Message, StringComparison.Ordinal);
        Assert.Contains(LosingCopyFixture.LosingOrigin, result.Message, StringComparison.Ordinal);
        Assert.Contains("does not load", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void EditingALosingCopy_WritesNothing()
    {
        using var mod = LosingCopyFixture.Create();

        mod.EditHandler.Set(mod.LosingPlugin, mod.LosingNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.Empty(mod.GitStatus(mod.LosingPlugin));
        var document = mod.Document(mod.LosingPlugin, mod.LosingNpc.ToString());
        Assert.NotNull(document);
        Assert.Equal(LosingCopyFixture.LosingNpcEditorId, document.EditorId);
    }

    // The positive control: a name-keyed gate would refuse (or allow) both copies together, so this
    // proves the gate reads this copy's own Winning flag.
    [Fact]
    public void EditingTheWinningCopy_OfTheSameName_Lands()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.EditHandler.Set(mod.WinningPlugin, mod.WinningNpc.ToString(), "HeightMax", Json("0.75"));

        Assert.True(result.Applied, result.Message);
    }

    [Fact]
    public void CreatingARecord_InALosingCopy_IsRefused()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.CreateHandler.CreateRecord(mod.LosingPlugin, "npc_", "NewNpc");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LosingCopy, result.Refusal);
    }

    [Fact]
    public void DeletingARecord_InALosingCopy_IsRefused()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.DeleteHandler.DeleteRecords(
            [new RecordAt(mod.LosingPlugin, mod.LosingNpc.ToString())]);

        Assert.Empty(result.Applied);
        var refusal = Assert.Single(result.Refused);
        Assert.Equal(RecordEditRefusal.LosingCopy, refusal.Refusal);
        Assert.NotNull(mod.Document(mod.LosingPlugin, mod.LosingNpc.ToString()));
    }

    [Fact]
    public void RenumberingARecord_InALosingCopy_IsRefused()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.RenumberHandler.RenumberRecord(mod.LosingPlugin, mod.LosingNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LosingCopy, result.Refusal);
    }

    [Fact]
    public void CopyingAsOverride_IntoALosingCopy_IsRefused()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.LosingPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LosingCopy, result.Refusal);
    }

    [Fact]
    public void CopyingAsNewRecord_IntoALosingCopy_IsRefused()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.CopyAsNewHandler.CopyRecordAsNewRecord(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.LosingPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LosingCopy, result.Refusal);
    }

    // The positive control for the copy routes: the same gesture into the winning copy lands.
    [Fact]
    public void CopyingAsOverride_IntoTheWinningCopy_Lands()
    {
        using var mod = LosingCopyFixture.Create();

        var result = mod.CopyAsOverrideHandler.CopyRecordAsOverride(
            mod.CopySourcePlugin, mod.CopySourceNpc.ToString(), mod.WinningPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(mod.Document(mod.WinningPlugin, mod.CopySourceNpc.ToString()));
    }
}
