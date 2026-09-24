using MEditService.Codec.Schema;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>What a renumber does to the working trees: the record's own file moves and nothing else
/// changes, the records referencing it included. What the Index says afterwards belongs to the Index
/// suite.</summary>
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

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void RenumberRecord_LeavesAReferencerInAnotherMod_AsItWas_TrackedOrNot(bool trackReferencer)
    {
        using var two = RenumberTwoModFixture.Create(trackReferencer);
        var before = TreeSnapshot.Of(two.ReferencerModFolder);

        var result = two.RenumberHandler.RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(two.Document(two.TargetPlugin, result.NewFormKey.Require()));
        Assert.Equal(before, TreeSnapshot.Of(two.ReferencerModFolder));
    }

    [Fact]
    public void RenumberRecord_ChangesOnlyTheFormKey_LeavingItsOwnLinksAndItsPluginsOtherRecordsAsTheyWere()
    {
        const string pluginName = "SelfLinked.esp";
        var race = FormKey.Null;
        using var mod = SourceModFixture.Tracked(pluginName, "SelfLinkedMod", m =>
        {
            var morphing = m.Races.AddNew("MorphingRace");
            morphing.MorphRace.SetTo(morphing);
            m.Npcs.AddNew("SamePluginNpc").Race.SetTo(morphing);
            race = morphing.FormKey;
        });
        var oldFormKey = race.ToString();
        var before = mod.Body(race);
        var referencer = Directory
            .EnumerateFiles(Path.Combine(mod.ModFolder, SourceRepository.RootFor(pluginName)), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains("SamePluginNpc", StringComparison.Ordinal));
        var referencerBefore = File.ReadAllText(referencer);

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, oldFormKey);

        Assert.True(result.Applied, result.Message);
        var newFormKey = result.NewFormKey.Require();
        var formKeyLine = $"\"FormKey\": \"{oldFormKey}\"";
        Assert.Contains(formKeyLine, before, StringComparison.Ordinal);
        Assert.Equal(
            before.Replace(formKeyLine, $"\"FormKey\": \"{newFormKey}\"", StringComparison.Ordinal),
            mod.Body(FormKey.Factory(newFormKey)));
        Assert.Equal(referencerBefore, File.ReadAllText(referencer));
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
