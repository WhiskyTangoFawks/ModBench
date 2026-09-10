using System.Globalization;
using System.Text.Json;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

public sealed class CreateRecordHandlerTests
{
    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    [Fact]
    public void EditField_OnANeverCommittedRecord_LandsInTheTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");
        Assert.True(created.Applied, created.Message);

        var result = mod.EditHandler.Set(mod.Plugin, created.NewFormKey!, "EditorID", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        var document = mod.Document(created.NewFormKey!)!;
        Assert.Equal("RenamedNpc", document.EditorId);
        Assert.Contains("RenamedNpc", document.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_AllocatesAFormKey_WritesAMinimalSourceFile_RecordBecomesReadable()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.EndsWith(":" + SourceEditFixture.PluginName, result.NewFormKey, StringComparison.Ordinal);

        var sourceFile = Path.Combine(mod.ModFolder, mod.RelativeSourcePath(
            FormKey.Factory(result.NewFormKey!), "npc_", "BrandNewNpc"));
        Assert.True(File.Exists(sourceFile));
        Assert.Equal("BrandNewNpc", mod.Document(result.NewFormKey!)!.EditorId);
    }

    [Fact]
    public void CreateRecord_AfterAnEarlierSiblingWasDeleted_LandsContiguously_NoGapSurvivesToLandPast()
    {
        using var mod = SourceEditFixture.Tracked();

        var deleted = mod.DeleteHandler.DeleteRecord(mod.Plugin, mod.Npc.ToString());
        Assert.True(deleted.Applied, deleted.Message);

        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AfterTheGap");
        Assert.True(created.Applied, created.Message);

        var npcsDir = Path.Combine(mod.ModFolder, SourceRepository.RootFor(SourceEditFixture.PluginName), "Npcs");
        var names = Directory.GetFiles(npcsDir)
            .Select(Path.GetFileName)
            .Where(n => !string.Equals(n, "GroupRecordData.json", StringComparison.Ordinal))
            .Select(n => n!)
            .Order(StringComparer.Ordinal)
            .ToList();

        // Neither file is renamed by the other's arrival or departure, and the create did not renumber
        // past a gap, because there are no numbers in these names to leave a gap in.
        Assert.Equal(2, names.Count);
        Assert.Contains(names, n => n.StartsWith("UntouchedNpc", StringComparison.Ordinal));
        Assert.Contains(names, n => n.StartsWith("AfterTheGap", StringComparison.Ordinal));
    }

    [Fact]
    public void CreateRecord_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNewNpc");

        Assert.Null(mod.CommittedDocument(result.NewFormKey!, "npc_", "BrandNewNpc"));
    }

    // A native record committed once and then deleted in the working tree: the shape an allocator
    // scanning only the working tree would miss, and whose ID the game would then see twice.
    [Fact]
    public void CreateRecord_AllocatesAboveAnIdOnlyTheCommittedTreeStillHolds()
    {
        using var mod = SourceEditFixture.Tracked();
        var headOnly = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "HeadOnlySeed", "F00000:Fixture.esp");
        Assert.True(headOnly.Applied, headOnly.Message);
        Commit(mod);
        Assert.True(mod.DeleteHandler.DeleteRecord(mod.Plugin, headOnly.NewFormKey!).Applied);
        Assert.Null(mod.Document(headOnly.NewFormKey!));

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AllocatedAfter");

        Assert.True(result.Applied, result.Message);
        Assert.True(LocalId(result.NewFormKey!) > LocalId(headOnly.NewFormKey!),
            $"expected an ID above {headOnly.NewFormKey}, got {result.NewFormKey} — the allocator must " +
            "consult the committed tree, not just the working one.");
    }

    private static void Commit(SourceEditFixture mod)
    {
        var git = Path.Combine(mod.ModFolder, ".git");
        GitCli.Run(git, mod.ModFolder, "add", "-A");
        GitCli.Run(git, mod.ModFolder, "commit", "-q", "-m", "seed");
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':', StringComparison.Ordinal)], NumberStyles.HexNumber, CultureInfo.InvariantCulture);

    // Peek is a read, so tracking is not its business: an untracked copy has no source tree and the
    // Plugin adapter answers from its own bytes instead.
    [Fact]
    public void PeekNextFreeFormKey_OnAnUntrackedPlugin_AnswersFromThePluginsOwnBinary()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.PeekHandler.PeekNextFreeFormKey(mod.Plugin);

        Assert.True(result.Applied, result.Message);
        // The fixture's plugin holds four records from 000800; the next free local ID is the fifth.
        Assert.Equal("000804:Fixture.esp", result.NewFormKey);
    }

    // Not registered at all, so neither a tree nor a file answers for it — and "not tracked" would
    // be a claim about a plugin the load order has never heard of.
    [Fact]
    public void PeekNextFreeFormKey_ForAPluginTheLoadOrderDoesNotRegister_RefusesAsRecordNotFound()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.PeekHandler.PeekNextFreeFormKey(new PluginKey("NotRegistered.esp", "NoSuchMod"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }

    // Registered, untracked, and its file replaced by something that is not a plugin: peek reads it
    // now, so an unreadable copy has to be a refusal rather than a fault.
    [Fact]
    public void PeekNextFreeFormKey_WhenTheCopysFileCannotBeRead_RefusesRatherThanThrowing()
    {
        using var mod = SourceEditFixture.Untracked();
        File.WriteAllText(Path.Combine(mod.ModFolder, mod.ActualPluginName), "not a plugin");

        var result = mod.PeekHandler.PeekNextFreeFormKey(mod.Plugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
    }

    [Fact]
    public void PeekNextFreeFormKey_OnATrackedPlugin_MatchesWhatCreateAllocates()
    {
        using var mod = SourceEditFixture.Tracked();

        var suggested = mod.PeekHandler.PeekNextFreeFormKey(mod.Plugin);
        var created = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AfterThePeek");

        Assert.True(suggested.Applied, suggested.Message);
        Assert.Equal(suggested.NewFormKey, created.NewFormKey);
    }

    [Fact]
    public void CreateRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CreateRecord_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = SourceEditFixture.Tracked();
        mod.RaiseExternalChange();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForAnUnknownRecordType()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "not-a-real-type", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_Refuses_ForTheHeaderPseudoType()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "header", "New");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordTypeNotFound, result.Refusal);
    }

    [Fact]
    public void CreateRecord_WithARequestedFormKey_Refuses_WhenItBelongsToADifferentPlugin()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void CreateRecord_WithARequestedFormKey_Refuses_WhenItCollides()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    // The auto-allocator's own exhaustion (every local ID up to 0xFFFFFF taken)
    // must be a typed refusal, not an InvalidOperationException an endpoint's generic load order-missing
    // catch would misreport as "no usable load order".
    [Fact]
    public void CreateRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = SourceEditFixture.Tracked();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheTop", "FFFFFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
        // This plugin is not light at all, so un-flagging ESL is not a way out of a full 0xFFFFFF native
        // space and the marker must never claim it is.
        Assert.False(result.EslContradiction);
    }

    // An ESL-flagged plugin's local FormID range is 12 bits: the game engine cannot address a higher
    // local ID from a light plugin's slot, so the allocator must refuse rather than continue.
    [Fact]
    public void CreateRecord_OnALightEspPlugin_Refuses_WhenTheEslRangeIsExhausted()
    {
        using var mod = SourceEditFixture.TrackedLight();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    // The same exhaustion, but light-ness is the removable header flag and native space above 0xFFF is
    // free, so the frontend can offer remove-the-flag-and-retry instead of a dead end.
    [Fact]
    public void CreateRecord_OnALightEspPlugin_WhenEslRangeExhausted_MarksEslContradiction()
    {
        using var mod = SourceEditFixture.TrackedLight();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.True(result.EslContradiction);
    }

    [Fact]
    public void CreateRecord_OnALightEspPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneBelowTheEslCap", "000FFE:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esp", result.NewFormKey);
    }

    // Same two directions, plain-.esl-extension shape (PluginFlagPredicates.IsLight's
    // extension-fallback branch) rather than the header-flagged-.esp shape above.
    [Fact]
    public void CreateRecord_OnAPlainEslPlugin_Refuses_WhenTheEslRangeIsExhausted()
    {
        using var mod = SourceEditFixture.TrackedLight("Fixture.esl");
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap", "000FFF:Fixture.esl");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneTooMany");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    [Fact]
    public void CreateRecord_OnAPlainEslPlugin_AllocatesUpToTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight("Fixture.esl");
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "OneBelowTheEslCap", "000FFE:Fixture.esl");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheEslCap");

        Assert.True(result.Applied, result.Message);
        Assert.Equal("000FFF:Fixture.esl", result.NewFormKey);
    }

    // The typed-FormID path must refuse the same range a light plugin's auto-allocator does. The
    // record would exist in ordinary FormKey space, so this is its own refusal, not
    // FormKeySpaceExhausted.
    [Fact]
    public void CreateRecord_TypedTarget_OnALightPlugin_Refuses_AboveTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight();

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LightPluginFormIdOutOfRange, result.Refusal);
    }

    [Fact]
    public void CreateRecord_TypedTarget_OnAnUnflaggedPlugin_AtTheSameId_Succeeds()
    {
        using var mod = SourceEditFixture.Tracked();
        const string requested = "001000:Fixture.esp";

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    [Fact]
    public void CreateRecord_WithAFreeRequestedFormKey_UsesItExactly()
    {
        using var mod = SourceEditFixture.Tracked();
        const string requested = "900000:Fixture.esp";

        var result = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "New", requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }
}
