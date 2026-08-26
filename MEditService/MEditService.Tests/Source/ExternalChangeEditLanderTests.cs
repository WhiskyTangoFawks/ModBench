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

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, _mod.Sessions.Index!, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Equal([_mod.Npc.ToString()], result.LandedFormKeys);

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
        Assert.Contains("\"HeightMax\": 0.9", File.ReadAllText(_mod.NpcSourceFile), StringComparison.Ordinal);
    }

    [Fact]
    public void Keep_AdvancesTheParkedRef_ToTheAbsorbedBinary()
    {
        WriteExternalBinaryChange(0.9f);

        ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, _mod.Sessions.Index!, SharedSchemaReflector.Instance);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var binarySha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(PluginPath)));
        Assert.Equal(binarySha, SourceRepository.ParkedCompileBinarySha256(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    [Fact]
    public void Keep_ClearsAnyPendingDeferral()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "pending");
        WriteExternalBinaryChange(0.9f);

        ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, _mod.Sessions.Index!, SharedSchemaReflector.Instance);

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

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, _mod.Sessions.Index!, SharedSchemaReflector.Instance);

        Assert.False(result.Applied);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason, StringComparison.Ordinal);
        Assert.Equal(myOwnEditText, File.ReadAllText(_mod.NpcSourceFile));
    }

    /// <summary>
    /// #459 review finding: <c>Keep</c>'s per-group order-index counter is recomputed from scratch on
    /// every land, over whatever the incoming binary actually holds. An external add or delete
    /// <i>anywhere earlier</i> in a flat group therefore shifts every later sibling's own <c>"[N] "</c>
    /// order index — and with it, its own file name — even though that sibling's fields never changed.
    /// Landing must move that sibling's file rather than write a second one at the new name and leave
    /// the old one behind (two files claiming one FormKey is exactly the corrupt-tree state
    /// <see cref="AmbiguousSourceUnitException"/> exists to catch elsewhere).
    ///
    /// <para><b>Not the DialogTopic.Responses scenario literally asked for</b> — traced, not assumed:
    /// <c>RecordTypeDispatch.FolderNameFor</c>'s own doc comment names "a dialog topic" and (on
    /// <c>GroupFolderNameFor</c>) "dialog responses" among the types with no top-level group at all, so
    /// both hit <c>Keep</c>'s "container records have no flat source path yet" skip <i>before</i> ever
    /// reaching the order-index counter — landing an external change anywhere inside a
    /// Quest/DialogTopic/Response chain is already-documented #453 territory this method cannot
    /// represent at all, order-shift or not, regardless of #459. The reachable analogue is a flat
    /// group (Npcs here), which is what this test exercises — the shape of damage is the same one the
    /// review named, just on a record kind this method can actually land.</para>
    ///
    /// <para><b>What this does not claim to fix</b>: a genuinely <i>deleted</i> record's own stale file
    /// (here, <c>MiddleNpc</c>'s) is not cleaned up — <c>Keep</c> only ever iterates records the
    /// incoming binary still holds, so it has no way to notice one dropped out entirely. That gap
    /// predates #459 (this method has no external-deletion detection of any kind, order-shifted or
    /// not) and is not what this fix addresses.</para>
    /// </summary>
    [Fact]
    public void Keep_AfterAnExternalMidListDelete_MovesTheLaterSiblingWithoutLeavingADuplicateFile()
    {
        var middleFormKey = FormKey.Factory($"{0x900:X6}:{TrackedModFixture.PluginName}");

        // Step 1: a third Npc appears externally, in the middle — landed, establishing an on-disk
        // order of FixtureNpc=[0], MiddleNpc=[1], UntouchedNpc=[2].
        var firstMod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race = new Race(_mod.Race, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.RaceEditorId };
        firstMod.Races.Add(race);
        firstMod.Keywords.Add(new Keyword(_mod.Keyword, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.KeywordEditorId });
        var npc = new Npc(_mod.Npc, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.NpcEditorId };
        npc.Race.SetTo(race);
        firstMod.Npcs.Add(npc);
        var middle = new Npc(middleFormKey, Fallout4Release.Fallout4) { EditorID = "MiddleNpc" };
        middle.Race.SetTo(race);
        firstMod.Npcs.Add(middle);
        firstMod.Npcs.Add(new Npc(_mod.OtherNpc, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.OtherNpcEditorId });
        firstMod.WriteToBinary(PluginPath);

        var firstLand = ExternalChangeEditLander.Keep(
            _mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, _mod.Sessions.Index!, SharedSchemaReflector.Instance);
        Assert.True(firstLand.Applied, firstLand.RefusalReason);
        var otherNpcPathBeforeDelete = SourceUnitResolver.FlatSourcePath(
            _mod.ModFolder, TrackedModFixture.PluginName, "npc_", _mod.OtherNpc.ToString(),
            TrackedModFixture.OtherNpcEditorId, GameRelease.Fallout4);
        Assert.StartsWith("[2] UntouchedNpc", Path.GetFileNameWithoutExtension(otherNpcPathBeforeDelete), StringComparison.Ordinal);
        var otherNpcTextBeforeDelete = File.ReadAllText(otherNpcPathBeforeDelete);

        // Step 2: MiddleNpc is deleted externally — UntouchedNpc's own index shifts from 2 to 1, with
        // no change to its own fields at all.
        var secondMod = new Fallout4Mod(ModKey.FromFileName(TrackedModFixture.PluginName), Fallout4Release.Fallout4);
        var race2 = new Race(_mod.Race, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.RaceEditorId };
        secondMod.Races.Add(race2);
        secondMod.Keywords.Add(new Keyword(_mod.Keyword, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.KeywordEditorId });
        var npc2 = new Npc(_mod.Npc, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.NpcEditorId };
        npc2.Race.SetTo(race2);
        secondMod.Npcs.Add(npc2);
        secondMod.Npcs.Add(new Npc(_mod.OtherNpc, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.OtherNpcEditorId });
        secondMod.WriteToBinary(PluginPath);

        var secondLand = ExternalChangeEditLander.Keep(
            _mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, _mod.Sessions.Index!, SharedSchemaReflector.Instance);
        Assert.True(secondLand.Applied, secondLand.RefusalReason);

        // The old [2] file is gone — not left behind as a duplicate claiming the same FormKey.
        Assert.False(File.Exists(otherNpcPathBeforeDelete), $"expected the stale file at {otherNpcPathBeforeDelete} to be cleaned up");

        // Exactly one file for UntouchedNpc remains, at its new index, with its content intact.
        var npcsDir = Path.Combine(_mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs");
        var otherNpcFiles = Directory.GetFiles(npcsDir, "*UntouchedNpc*");
        var survivor = Assert.Single(otherNpcFiles);
        Assert.StartsWith("[1] UntouchedNpc", Path.GetFileNameWithoutExtension(survivor), StringComparison.Ordinal);
        Assert.Equal(otherNpcTextBeforeDelete, File.ReadAllText(survivor));
    }

    /// <summary>#433: <c>Keep</c> reads the parked baseline through
    /// <c>refs/medit/last-compile/&lt;plugin&gt;</c> (<see cref="SourceRepository.EnumerateSourceAtRef"/>)
    /// and re-parks through <see cref="SourceRepository.ParkCompileSnapshot"/> after landing — both
    /// must survive a real-world-shaped, ref-unsafe plugin name, not just the fixture's own
    /// <see cref="TrackedModFixture.PluginName"/>.</summary>
    [Fact]
    public void Keep_Succeeds_ForASpaceNamedPlugin()
    {
        using var mod = TrackedModFixture.TrackedAs("LitR - Settings Holotapes Sorting.esp");
        var pluginPath = Path.Combine(mod.ModFolder, mod.ActualPluginName);

        var fallout4Mod = new Fallout4Mod(ModKey.FromFileName(mod.ActualPluginName), Fallout4Release.Fallout4);
        var race = new Race(mod.Race, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.RaceEditorId };
        fallout4Mod.Races.Add(race);
        fallout4Mod.Keywords.Add(new Keyword(mod.Keyword, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.KeywordEditorId });
        var npc = new Npc(mod.Npc, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.NpcEditorId };
        npc.Race.SetTo(race);
        npc.HeightMax = 0.9f;
        fallout4Mod.Npcs.Add(npc);
        fallout4Mod.Npcs.Add(new Npc(mod.OtherNpc, Fallout4Release.Fallout4) { EditorID = TrackedModFixture.OtherNpcEditorId });
        fallout4Mod.WriteToBinary(pluginPath);

        var result = ExternalChangeEditLander.Keep(
            mod.ModFolder, mod.Plugin, pluginPath, GameRelease.Fallout4, mod.Sessions.Index!, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Equal([mod.Npc.ToString()], result.LandedFormKeys);

        var binarySha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(pluginPath)));
        Assert.Equal(binarySha, SourceRepository.ParkedCompileBinarySha256(mod.ModFolder, mod.ActualPluginName));
    }

    [Fact]
    public void Keep_DoesNotRefuse_WhenExistingDirtAlreadyAgreesWithTheIncomingValue()
    {
        // Not a real collision: the user happened to make the exact same edit the external tool made
        // — nothing to lose by landing it.
        var editService = new RecordEditService(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
        editService.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", JsonDocument.Parse("0.9").RootElement);

        WriteExternalBinaryChange(0.9f);

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, _mod.Sessions.Index!, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
    }
}
