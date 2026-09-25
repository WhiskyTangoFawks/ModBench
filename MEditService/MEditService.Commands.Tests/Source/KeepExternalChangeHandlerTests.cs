using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Source;

public sealed class KeepExternalChangeHandlerTests : IDisposable
{
    private readonly SourceEditFixture _mod = SourceEditFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private string PluginPath => Path.Combine(_mod.ModFolder, SourceEditFixture.PluginName);

    private void WriteExternalBinaryChange(float newHeightMax)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        mod.Keywords.AddNew("FixtureKeyword");
        var npc = mod.Npcs.AddNew("FixtureNpc");
        npc.Race.SetTo(race);
        npc.HeightMax = newHeightMax;
        mod.Npcs.AddNew("UntouchedNpc");
        mod.WriteToBinary(PluginPath);
    }

    [Fact]
    public void Keep_OfAnOriginNoLoadedPluginHas_AnswersNothing()
    {
        Assert.Null(_mod.KeepHandler.Keep("NoSuchMod"));
    }

    [Fact]
    public void Keep_OfAnUntrackedMod_AnswersNothing()
    {
        using var untracked = SourceEditFixture.Untracked();

        Assert.Null(untracked.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin));
    }

    [Fact]
    public void Keep_LandsOnlyTheTouchedRecord_AsWorkingTreeDirt()
    {
        WriteExternalBinaryChange(0.9f);

        var result = _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

        Assert.True(result.Applied, result.RefusalReason);
        Assert.Equal([_mod.Npc.ToString()], result.LandedFormKeys);

        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", SourceEditFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
        Assert.Contains("\"HeightMax\": 0.9", File.ReadAllText(_mod.NpcSourceFile), StringComparison.Ordinal);
    }

    [Fact]
    public void Keep_OverAParkedTreeWhereTwoDocumentsClaimOneFormKey_StillLands()
    {
        // A corrupt tree is Compile's refusal to report, not Keep's to crash on: taking the first
        // document keeps every unrelated record landing.
        var npcSourceFile = _mod.NpcSourceFile;
        var impostor = Path.Combine(
            Path.GetDirectoryName(npcSourceFile) ?? throw new InvalidOperationException($"Expected '{npcSourceFile}' to have a parent directory."),
            $"AnImpostor - {_mod.Npc.ID:X6}_{SourceEditFixture.PluginName}.json");
        File.WriteAllText(impostor, File.ReadAllText(_mod.NpcSourceFile));
        // Staged, or the parked snapshot would not carry it: git stash create ignores untracked files.
        GitProbe.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, "add", "-A");
        SourceRepository.ParkCompileSnapshot(_mod.ModFolder, SourceEditFixture.PluginName, atRef: null, "abc");
        var repository = SourceRepository.Open(_mod.ModFolder, GameRelease.Fallout4)
            ?? throw new InvalidOperationException("Expected a tracked mod folder to open a source repository.");
        Assert.Equal(
            2,
            repository
                .ReadAll(_mod.Plugin, SourceRepository.LastCompileRef(SourceEditFixture.PluginName))
                .Count(d => d.FormKey == _mod.Npc.ToString()));
        File.Delete(impostor);
        WriteExternalBinaryChange(0.9f);

        var result = _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

        Assert.True(result.Applied, result.RefusalReason);
    }

    // The leaf name carries the EditorID, so an external rename moves the file. One file, at the new
    // name: leaving the old one behind would give the FormKey two documents.
    [Fact]
    public void Keep_AfterAnExternalEditorIdChange_MovesTheRecordsLeafAndLeavesNoStaleFile()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = new Race(_mod.Race, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.RaceEditorId };
        mod.Races.Add(race);
        mod.Keywords.Add(new Keyword(_mod.Keyword, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.KeywordEditorId });
        var npc = new Npc(_mod.Npc, Fallout4Release.Fallout4) { EditorID = "RenamedNpc" };
        npc.Race.SetTo(race);
        mod.Npcs.Add(npc);
        mod.Npcs.Add(new Npc(_mod.OtherNpc, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.OtherNpcEditorId });
        mod.WriteToBinary(PluginPath);

        var result = _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

        Assert.True(result.Applied, result.RefusalReason);
        var npcsDirectory = Path.Combine(
            _mod.ModFolder, SourceRepository.RootFor(SourceEditFixture.PluginName), "Npcs");
        var renamed = Assert.Single(Directory.GetFiles(npcsDirectory, $"*{_mod.Npc.ID:X6}_*"));
        Assert.StartsWith("RenamedNpc", Path.GetFileName(renamed), StringComparison.Ordinal);
        Assert.Contains("\"RenamedNpc\"", File.ReadAllText(renamed), StringComparison.Ordinal);
    }

    [Fact]
    public void Keep_AdvancesTheParkedRef_ToTheAbsorbedBinary()
    {
        WriteExternalBinaryChange(0.9f);

        _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

        var gitDir = Path.Combine(_mod.ModFolder, ".git");
        var binarySha = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(File.ReadAllBytes(PluginPath)));
        Assert.Equal(binarySha, SourceRepository.ParkedCompileBinarySha256(_mod.ModFolder, SourceEditFixture.PluginName));
    }

    [Fact]
    public void Keep_ClearsTheModsUnansweredDeferral()
    {
        SourceRepository.RaiseExternalChangeQuestion(_mod.ModFolder, "unanswered");
        WriteExternalBinaryChange(0.9f);

        _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

        Assert.Null(SourceRepository.UnansweredExternalChange(_mod.ModFolder));
    }

    // The answer Keep records is the staged index; a restart's settle reads git afresh, and a file
    // whose working tree already matches what was staged is nothing left to ask about.
    [Fact]
    public void Keep_UnderTheEverythingPreset_LeavesNothingForARestartsSettleToAsk()
    {
        using var mod = SourceEditFixture.TrackedEverything(
            folder => File.WriteAllText(Path.Combine(folder, "texture.dds"), "original"));
        File.WriteAllText(Path.Combine(mod.ModFolder, "texture.dds"), "changed-by-the-release");
        var pluginPath = Path.Combine(mod.ModFolder, SourceEditFixture.PluginName);
        Assert.Equal(
            TrackedModSettledOutcome.QuestionOpened,
            TestEditService.Settled(new InMemoryNotificationPublisher()).Handle(mod.LoadOrder, mod.ModFolder));

        var result = mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();
        Assert.True(result.Applied, result.RefusalReason);

        var afterRestart = new InMemoryNotificationPublisher();
        var outcome = TestEditService.Settled(afterRestart).Handle(mod.LoadOrder, mod.ModFolder);

        Assert.Equal(TrackedModSettledOutcome.NoQuestion, outcome);
        Assert.Empty(afterRestart.Notifications);
        Assert.Null(SourceRepository.UnansweredExternalChange(mod.ModFolder));
    }

    [Fact]
    public void Keep_Refuses_WhenTheSameRecordAlreadyHasUncommittedDirtThatDisagreesWithTheIncomingValue()
    {
        var editService = _mod.EditHandler;
        var applyResult = editService.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.5").RootElement);
        Assert.True(applyResult.Applied, applyResult.Message);
        var myOwnEditText = File.ReadAllText(_mod.NpcSourceFile);

        WriteExternalBinaryChange(0.9f);

        var result = _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

        Assert.False(result.Applied);
        Assert.Contains(_mod.Npc.ToString(), result.RefusalReason, StringComparison.Ordinal);
        Assert.Equal(myOwnEditText, File.ReadAllText(_mod.NpcSourceFile));
    }

    // A flat Npc group, not the obvious DialogTopic chain: both container shapes hit Keep's "no flat
    // source path yet" skip before ever reaching the order-index counter.
    [Fact]
    public void Keep_AfterAnExternalMidListDelete_LeavesTheLaterSiblingEntirelyUntouched()
    {
        var middleFormKey = FormKey.Factory($"{0x900:X6}:{SourceEditFixture.PluginName}");

        // Step 1: a third Npc appears externally, in the middle — landed, establishing an on-disk
        // order of FixtureNpc=[0], MiddleNpc=[1], UntouchedNpc=[2].
        var firstMod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race = new Race(_mod.Race, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.RaceEditorId };
        firstMod.Races.Add(race);
        firstMod.Keywords.Add(new Keyword(_mod.Keyword, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.KeywordEditorId });
        var npc = new Npc(_mod.Npc, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.NpcEditorId };
        npc.Race.SetTo(race);
        firstMod.Npcs.Add(npc);
        var middle = new Npc(middleFormKey, Fallout4Release.Fallout4) { EditorID = "MiddleNpc" };
        middle.Race.SetTo(race);
        firstMod.Npcs.Add(middle);
        firstMod.Npcs.Add(new Npc(_mod.OtherNpc, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.OtherNpcEditorId });
        firstMod.WriteToBinary(PluginPath);

        var firstLand = _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();
        Assert.True(firstLand.Applied, firstLand.RefusalReason);
        var otherNpcPathBeforeDelete = SourceDocumentPath.Of(
            _mod.ModFolder, SourceEditFixture.PluginName, "npc_", _mod.OtherNpc.ToString(),
            SourceEditFixture.OtherNpcEditorId, GameRelease.Fallout4);
        Assert.StartsWith("UntouchedNpc", Path.GetFileNameWithoutExtension(otherNpcPathBeforeDelete), StringComparison.Ordinal);
        var otherNpcTextBeforeDelete = File.ReadAllText(otherNpcPathBeforeDelete);

        // Step 2: MiddleNpc is deleted externally. Nothing about UntouchedNpc moves, so "did the stale
        // file get cleaned up" is answered by there being no stale file to make.
        var secondMod = new Fallout4Mod(ModKey.FromFileName(SourceEditFixture.PluginName), Fallout4Release.Fallout4);
        var race2 = new Race(_mod.Race, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.RaceEditorId };
        secondMod.Races.Add(race2);
        secondMod.Keywords.Add(new Keyword(_mod.Keyword, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.KeywordEditorId });
        var npc2 = new Npc(_mod.Npc, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.NpcEditorId };
        npc2.Race.SetTo(race2);
        secondMod.Npcs.Add(npc2);
        secondMod.Npcs.Add(new Npc(_mod.OtherNpc, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.OtherNpcEditorId });
        secondMod.WriteToBinary(PluginPath);

        var secondLand = _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();
        Assert.True(secondLand.Applied, secondLand.RefusalReason);

        // Exactly one file for UntouchedNpc, at the same path it already had, with its content
        // intact — a sibling's external deletion is not an event in this record's life at all.
        var npcsDir = Path.Combine(_mod.ModFolder, SourceRepository.RootFor(SourceEditFixture.PluginName), "Npcs");
        var otherNpcFiles = Directory.GetFiles(npcsDir, "*UntouchedNpc*");
        var survivor = Assert.Single(otherNpcFiles);
        Assert.Equal(otherNpcPathBeforeDelete, survivor);
        Assert.Equal(otherNpcTextBeforeDelete, File.ReadAllText(survivor));
    }

    [Fact]
    public void Keep_Succeeds_ForASpaceNamedPlugin()
    {
        using var mod = SourceEditFixture.TrackedAs("LitR - Settings Holotapes Sorting.esp");
        var pluginPath = Path.Combine(mod.ModFolder, mod.ActualPluginName);

        var fallout4Mod = new Fallout4Mod(ModKey.FromFileName(mod.ActualPluginName), Fallout4Release.Fallout4);
        var race = new Race(mod.Race, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.RaceEditorId };
        fallout4Mod.Races.Add(race);
        fallout4Mod.Keywords.Add(new Keyword(mod.Keyword, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.KeywordEditorId });
        var npc = new Npc(mod.Npc, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.NpcEditorId };
        npc.Race.SetTo(race);
        npc.HeightMax = 0.9f;
        fallout4Mod.Npcs.Add(npc);
        fallout4Mod.Npcs.Add(new Npc(mod.OtherNpc, Fallout4Release.Fallout4) { EditorID = SourceEditFixture.OtherNpcEditorId });
        fallout4Mod.WriteToBinary(pluginPath);

        var result = mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

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
        var editService = _mod.EditHandler;
        editService.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.9").RootElement);

        WriteExternalBinaryChange(0.9f);

        var result = _mod.KeepHandler.Keep(SourceEditFixture.ModFolderOrigin).Require();

        Assert.True(result.Applied, result.RefusalReason);
    }
}
