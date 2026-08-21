using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

/// <summary>
/// #417 B8 (Keep as My Edit): AC1 (lands on the right records) and AC5 (refuses over a collision
/// with existing uncommitted dirt on the same record).
/// </summary>
public sealed class ExternalChangeEditLanderTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string PluginPath => Path.Combine(_mod.ModFolder, TrackedModFixture.PluginName);

    private void WriteExternalBinaryChange(float newHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(PluginPath);
    }

    [Fact]
    public void Keep_LandsOnlyTheTouchedRecord_AsWorkingTreeDirt()
    {
        WriteExternalBinaryChange(0.9f);

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, TrackedModFixture.PluginName, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Equal([_mod.Npc.ToString()], result.LandedFormKeys);

        var relative = TrackedModFixture.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
        Assert.Contains("\"HeightMax\": 0.9", File.ReadAllText(_mod.NpcSourceFile), StringComparison.Ordinal);
    }

    [Fact]
    public void Keep_AdvancesTheParkedRef_ToTheAbsorbedBinary()
    {
        WriteExternalBinaryChange(0.9f);

        ExternalChangeEditLander.Keep(_mod.ModFolder, TrackedModFixture.PluginName, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var binarySha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(PluginPath)));
        Assert.Equal(binarySha, SourceRepository.ParkedCompileBinarySha256(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    [Fact]
    public void Keep_ClearsAnyPendingDeferral()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "pending");
        WriteExternalBinaryChange(0.9f);

        ExternalChangeEditLander.Keep(_mod.ModFolder, TrackedModFixture.PluginName, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.Null(ExternalChangeDeferral.Pending(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    /// <summary>AC5: an external change colliding with uncommitted dirt on the same record refuses
    /// with a clear message, and — git's checkout-over-dirt rule — the user's own edit survives
    /// byte-for-byte.</summary>
    [Fact]
    public void Keep_Refuses_WhenTheSameRecordAlreadyHasUncommittedDirtThatDisagreesWithTheIncomingValue()
    {
        var editService = new RecordEditService(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
        var applyResult = editService.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", JsonDocument.Parse("0.5").RootElement);
        Assert.True(applyResult.Applied, applyResult.Message);
        var myOwnEditText = File.ReadAllText(_mod.NpcSourceFile);

        WriteExternalBinaryChange(0.9f);

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, TrackedModFixture.PluginName, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.False(result.Applied);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason, StringComparison.Ordinal);
        Assert.Equal(myOwnEditText, File.ReadAllText(_mod.NpcSourceFile));
    }

    [Fact]
    public void Keep_DoesNotRefuse_WhenExistingDirtAlreadyAgreesWithTheIncomingValue()
    {
        // Not a real collision: the user happened to make the exact same edit the external tool made
        // — nothing to lose by landing it.
        var editService = new RecordEditService(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
        editService.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", JsonDocument.Parse("0.9").RootElement);

        WriteExternalBinaryChange(0.9f);

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, TrackedModFixture.PluginName, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
    }
}
