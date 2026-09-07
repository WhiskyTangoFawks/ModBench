using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Source;

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

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Equal([_mod.Npc.ToString()], result.LandedFormKeys);

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
        Assert.Contains("\"HeightMax\": 0.9", File.ReadAllText(_mod.NpcSourceFile), StringComparison.Ordinal);
    }

    [Fact]
    public void Keep_OverAParkedTreeWhereTwoDocumentsClaimOneFormKey_StillLands()
    {
        // A corrupt tree is Compile's refusal to report, not Keep's to crash on: taking the first
        // document keeps every unrelated record landing.
        var impostor = Path.Combine(
            Path.GetDirectoryName(_mod.NpcSourceFile)!, $"AnImpostor - {_mod.Npc.ID:X6}_{TrackedModFixture.PluginName}.json");
        File.WriteAllText(impostor, File.ReadAllText(_mod.NpcSourceFile));
        // Staged, or the parked snapshot would not carry it: git stash create ignores untracked files.
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, "add", "-A");
        SourceRepository.ParkCompileSnapshot(_mod.ModFolder, TrackedModFixture.PluginName, atRef: null, "abc");
        Assert.Equal(
            2,
            SourceRepository.Open(_mod.ModFolder, GameRelease.Fallout4)!
                .ReadAll(_mod.Plugin, SourceRepository.LastCompileRef(TrackedModFixture.PluginName))
                .Count(d => d.FormKey == _mod.Npc.ToString()));
        File.Delete(impostor);
        WriteExternalBinaryChange(0.9f);

        var result = ExternalChangeEditLander.Keep(
            _mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
    }

    [Fact]
    public void Keep_AdvancesTheParkedRef_ToTheAbsorbedBinary()
    {
        WriteExternalBinaryChange(0.9f);

        ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var binarySha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(PluginPath)));
        Assert.Equal(binarySha, SourceRepository.ParkedCompileBinarySha256(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    [Fact]
    public void Keep_ClearsAnyUnansweredDeferral()
    {
        ExternalChangeDeferral.Set(_mod.ModFolder, TrackedModFixture.PluginName, "unanswered");
        WriteExternalBinaryChange(0.9f);

        ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.Null(ExternalChangeDeferral.Unanswered(_mod.ModFolder, TrackedModFixture.PluginName));
    }

    [Fact]
    public void Keep_Refuses_WhenTheSameRecordAlreadyHasUncommittedDirtThatDisagreesWithTheIncomingValue()
    {
        var editService = ProjectingEditService.Over(_mod.Mirror);
        var applyResult = editService.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.5").RootElement);
        Assert.True(applyResult.Applied, applyResult.Message);
        var myOwnEditText = File.ReadAllText(_mod.NpcSourceFile);

        WriteExternalBinaryChange(0.9f);

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.False(result.Applied);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason, StringComparison.Ordinal);
        Assert.Equal(myOwnEditText, File.ReadAllText(_mod.NpcSourceFile));
    }

    // A flat Npc group, not the obvious DialogTopic chain: both container shapes hit Keep's "no flat
    // source path yet" skip before ever reaching the order-index counter.
    [Fact]
    public void Keep_AfterAnExternalMidListDelete_LeavesTheLaterSiblingEntirelyUntouched()
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
            _mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);
        Assert.True(firstLand.Applied, firstLand.RefusalReason);
        var otherNpcPathBeforeDelete = SourceUnitResolver.FlatSourcePath(
            _mod.ModFolder, TrackedModFixture.PluginName, "npc_", _mod.OtherNpc.ToString(),
            TrackedModFixture.OtherNpcEditorId, GameRelease.Fallout4);
        Assert.StartsWith("UntouchedNpc", Path.GetFileNameWithoutExtension(otherNpcPathBeforeDelete), StringComparison.Ordinal);
        var otherNpcTextBeforeDelete = File.ReadAllText(otherNpcPathBeforeDelete);

        // Step 2: MiddleNpc is deleted externally. Nothing about UntouchedNpc moves, so "did the stale
        // file get cleaned up" is answered by there being no stale file to make.
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
            _mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);
        Assert.True(secondLand.Applied, secondLand.RefusalReason);

        // Exactly one file for UntouchedNpc, at the same path it already had, with its content
        // intact — a sibling's external deletion is not an event in this record's life at all.
        var npcsDir = Path.Combine(_mod.ModFolder, SourceRecordPath.RootFor(TrackedModFixture.PluginName), "Npcs");
        var otherNpcFiles = Directory.GetFiles(npcsDir, "*UntouchedNpc*");
        var survivor = Assert.Single(otherNpcFiles);
        Assert.Equal(otherNpcPathBeforeDelete, survivor);
        Assert.Equal(otherNpcTextBeforeDelete, File.ReadAllText(survivor));
    }

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
            mod.ModFolder, mod.Plugin, pluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

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
        var editService = ProjectingEditService.Over(_mod.Mirror);
        editService.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.9").RootElement);

        WriteExternalBinaryChange(0.9f);

        var result = ExternalChangeEditLander.Keep(_mod.ModFolder, _mod.Plugin, PluginPath, GameRelease.Fallout4, SharedSchemaReflector.Instance);

        Assert.True(result.Applied, result.RefusalReason);
    }
}
