using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.LoadOrder;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>What a renumber does to the working trees: the record's own file moves, a tracked
/// referencer's document is rewritten, an untracked one refuses. What the Index says afterwards
/// belongs to the Index suite.</summary>
public sealed class RenumberRecordHandlerTests
{
    [Fact]
    public void RenumberRecord_OnTheHeader_RefusesWithoutTouchingTheSourceTree()
    {
        using var mod = SourceEditFixture.Tracked();
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, headerFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.HeaderDeleteOrRenumberNotSupported, result.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile), "an unrelated sibling record's file must survive");
        Assert.NotNull(mod.Document(headerFormKey));
    }

    [Fact]
    public void RenumberRecord_MovesToNewFormKey_OldGoneAtTheWorkingTree_StillAtHead_NewAbsentAtHead()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Document(mod.Npc.ToString()));
        Assert.NotNull(mod.CommittedDocument(mod.Npc.ToString(), "npc_", SourceEditFixture.NpcEditorId));
        Assert.NotNull(result.NewFormKey);
        Assert.NotNull(mod.Document(result.NewFormKey));
        Assert.Null(mod.CommittedDocument(result.NewFormKey, "npc_", SourceEditFixture.NpcEditorId));
    }

    [Fact]
    public void RenumberRecord_OnANeverCommittedAddedRecord_LeavesTheOldFormKeyInNeitherRef()
    {
        using var mod = SourceEditFixture.Tracked();
        const string oldFormKey = "800000:Fixture.esp";
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNew", oldFormKey);
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, oldFormKey);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Document(oldFormKey));
        Assert.Null(mod.CommittedDocument(oldFormKey, "npc_", "BrandNew"));
        Assert.NotNull(result.NewFormKey);
        Assert.NotNull(mod.Document(result.NewFormKey));
    }

    [Fact]
    public void RenumberRecord_WithARequestedTarget_UsesItExactly()
    {
        using var mod = SourceEditFixture.Tracked();
        const string requested = "900000:Fixture.esp";

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString(), requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    // Renumber's typed-target path shares CreateRecord's own ResolveTargetFormKey — a light
    // plugin must refuse a renumber target above its 0xFFF ESL local-FormID range the same way create
    // does.
    [Fact]
    public void RenumberRecord_OnALightPlugin_Refuses_WhenTheTargetExceedsTheEslCap()
    {
        using var mod = SourceEditFixture.TrackedLight();

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString(), "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LightPluginFormIdOutOfRange, result.Refusal);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenTheRequestedTargetBelongsToADifferentPlugin()
    {
        using var mod = SourceEditFixture.Tracked();

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString(), "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    // The auto-allocator's own exhaustion must be a typed refusal here too, not
    // an InvalidOperationException the endpoint's load order-missing catch would misreport.
    [Fact]
    public void RenumberRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = SourceEditFixture.Tracked();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheTop", "FFFFFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    [Fact]
    public void RenumberRecord_Refuses_OnAnOverrideRecord_NamingTheOriginatingPlugin()
    {
        using var two = RenumberTwoModFixture.Create(trackReferencer: true);

        // Npc, native to Base.esm, overridden (unedited copy) in Winner.esp — renumbering it from
        // Winner.esp's side is exactly the override case this gesture refuses.
        var result = two.RenumberHandler.RenumberRecord(two.ReferencerPlugin, two.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
        Assert.Contains("Base.esm", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_RewritesATrackedReferencersFormLink_ToTheNewFormKey()
    {
        using var two = RenumberTwoModFixture.Create(trackReferencer: true);

        var result = two.RenumberHandler.RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.True(result.Applied, result.Message);
        var referencer = two.Document(two.ReferencerPlugin, two.ReferencerNpc);
        Assert.NotNull(referencer);
        Assert.NotNull(result.NewFormKey);
        Assert.Contains(result.NewFormKey, referencer.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(two.TargetRace.ToString(), referencer.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenAReferencerIsUntracked_NamingIt_AndWritesNothing()
    {
        using var two = RenumberTwoModFixture.Create(trackReferencer: false);
        var oldRaceSourceFile = two.SourceFileFor(
            two.TargetPlugin, two.TargetRace, "race", RenumberTwoModFixture.TargetRaceEditorId);

        var result = two.RenumberHandler.RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UntrackedReferencer, result.Refusal);
        Assert.Contains(RenumberTwoModFixture.ReferencerPluginName, result.Message, StringComparison.Ordinal);

        // "No half-applied state": refused before any write, on either side of the cascade.
        Assert.True(File.Exists(oldRaceSourceFile));
        Assert.NotNull(two.Document(two.TargetPlugin, two.TargetRace));
    }

    // MO2 removes a copy's file whenever it likes, and a snapshot names copies that were there when
    // it was taken. A copy gone since is one no cascade could rewrite, not a 500.
    [Fact]
    public void RenumberRecord_WhenAnUntrackedCopysFileHasGoneSinceTheSnapshot_SkipsItRatherThanFaulting()
    {
        using var two = RenumberTwoModFixture.Create(trackReferencer: false);
        File.Delete(Path.Combine(two.ReferencerModFolder, RenumberTwoModFixture.ReferencerPluginName));

        var result = two.RenumberHandler.RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.NotNull(two.Document(two.TargetPlugin, result.NewFormKey));
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = SourceEditFixture.Untracked();

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = SourceEditFixture.Tracked();
        mod.RaiseExternalChange();

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
    }

    [Fact]
    public void PeekNextFreeFormKey_MatchesWhatRenumberWouldActuallyAllocate()
    {
        using var mod = SourceEditFixture.Tracked();

        var suggested = mod.PeekHandler.PeekNextFreeFormKey(mod.Plugin);
        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(suggested.Applied, suggested.Message);
        Assert.Equal(suggested.NewFormKey, result.NewFormKey);
    }

    [Fact]
    public void PeekNextFreeFormKey_Refuses_WhenNoLoadOrderIsLoaded()
    {
        using var mod = SourceEditFixture.Tracked();

        var suggested = TestEditService.PeekHandler(new LoadOrderHolder()).PeekNextFreeFormKey(mod.Plugin);

        Assert.False(suggested.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, suggested.Refusal);
    }

    // The same typed-refusal standard as Create/Renumber.
    [Fact]
    public void PeekNextFreeFormKey_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = SourceEditFixture.Tracked();
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "AtTheTop", "FFFFFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.PeekHandler.PeekNextFreeFormKey(mod.Plugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }
}
