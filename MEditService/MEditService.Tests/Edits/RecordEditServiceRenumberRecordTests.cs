using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>Two-mod fixture because the interesting question, does a renumber rewrite a FormLink in
/// a different mod folder's own repo, cannot be asked of one.</summary>
public sealed class RecordEditServiceRenumberRecordTests
{
    private static ProjectingEditService ServiceFor(ILoadOrderMirror mirror) =>
        ProjectingEditService.Over(mirror);

    [Fact]
    public void RenumberRecord_OnTheHeader_RefusesWithoutTouchingTheSourceTree()
    {
        using var mod = TrackedModFixture.Tracked();
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(mod.ActualPluginName));

        var result = ServiceFor(mod.Mirror).RenumberRecord(mod.Plugin, headerFormKey);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.HeaderDeleteOrRenumberNotSupported, result.Refusal);
        Assert.True(File.Exists(mod.NpcSourceFile), "an unrelated sibling record's file must survive");
        Assert.NotNull(mod.Mirror.Projected().GetDocument(headerFormKey, mod.Plugin));
    }

    [Fact]
    public void RenumberRecord_MovesToNewFormKey_OldGoneAtEffective_StillAtHead_NewAbsentAtHead()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror).RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        mod.Mirror.Settle();
        var index = mod.Mirror.Index!;
        Assert.Null(index.At(RecordRef.Effective).GetDocument(mod.Npc.ToString(), mod.Plugin));
        Assert.NotNull(index.At(RecordRef.Head).GetDocument(mod.Npc.ToString(), mod.Plugin));
        Assert.NotNull(index.At(RecordRef.Effective).GetDocument(result.NewFormKey!, mod.Plugin));
        Assert.Null(index.At(RecordRef.Head).GetDocument(result.NewFormKey!, mod.Plugin));
    }

    [Fact]
    public void RenumberRecord_OnANeverCommittedAddedRecord_DropsOldFormKeyAtTheQueryLayer()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);
        const string oldFormKey = "800000:Fixture.esp";
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "BrandNew", oldFormKey);
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.RenumberRecord(mod.Plugin, oldFormKey);

        Assert.True(result.Applied, result.Message);
        var repository = mod.Mirror.SettledReads();
        Assert.Null(repository.GetDocument(oldFormKey));
        Assert.NotNull(repository.GetDocument(result.NewFormKey!));
        var listing = repository.Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: mod.Plugin, Limit: 50, Offset: 0));
        Assert.DoesNotContain(listing.Items, r => r.FormKey == oldFormKey);
        Assert.Contains(listing.Items, r => r.FormKey == result.NewFormKey);
    }

    [Fact]
    public void RenumberRecord_WithARequestedTarget_UsesItExactly()
    {
        using var mod = TrackedModFixture.Tracked();
        const string requested = "900000:Fixture.esp";

        var result = ServiceFor(mod.Mirror).RenumberRecord(mod.Plugin, mod.Npc.ToString(), requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    // Renumber's typed-target path shares CreateRecord's own ResolveTargetFormKey — a light
    // plugin must refuse a renumber target above its 0xFFF ESL local-FormID range the same way create
    // does.
    [Fact]
    public void RenumberRecord_OnALightPlugin_Refuses_WhenTheTargetExceedsTheEslCap()
    {
        using var mod = TrackedModFixture.TrackedLight();

        var result = ServiceFor(mod.Mirror).RenumberRecord(mod.Plugin, mod.Npc.ToString(), "001000:Fixture.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.LightPluginFormIdOutOfRange, result.Refusal);
    }

    // The renumbered record lands under a brand-new FormKey that _filter's snapshot never evaluated,
    // and the old one is gone, so without re-materializing it vanishes from a filtered listing.
    [Fact]
    public void RenumberRecord_MakesTheRecordUnderItsNewFormKeyAppearInAnActiveFilteredListing()
    {
        using var mod = TrackedModFixture.Tracked();
        mod.Mirror.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'FixtureNpc'");
        Assert.Equal(1, mod.Mirror.SettledReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        var result = ServiceFor(mod.Mirror).RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(result.Applied, result.Message);
        var after = mod.Mirror.SettledReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
        Assert.Equal(1, after.Total);
        Assert.Equal(result.NewFormKey, after.Items[0].FormKey);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenTheRequestedTargetBelongsToADifferentPlugin()
    {
        using var mod = TrackedModFixture.Tracked();

        var result = ServiceFor(mod.Mirror)
            .RenumberRecord(mod.Plugin, mod.Npc.ToString(), "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    // The auto-allocator's own exhaustion must be a typed refusal here too, not
    // an InvalidOperationException the endpoint's load order-missing catch would misreport.
    [Fact]
    public void RenumberRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "AtTheTop", "FFFFFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    [Fact]
    public void RenumberRecord_Refuses_OnAnOverrideRecord_NamingTheOriginatingPlugin()
    {
        using var two = TwoModFixture.Create(trackReferencer: true);

        // Npc, native to Base.esm, overridden (unedited copy) in Winner.esp — renumbering it from
        // Winner.esp's side is exactly the override case this gesture refuses.
        var result = ServiceFor(two.Mirror).RenumberRecord(two.WinnerPlugin, two.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
        Assert.Contains("Base.esm", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_RewritesATrackedReferencersFormLink_ToTheNewFormKey()
    {
        using var two = TwoModFixture.Create(trackReferencer: true);

        var result = ServiceFor(two.Mirror).RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.True(result.Applied, result.Message);
        two.Mirror.Settle();
        var index = two.Mirror.Index!;
        var referencer = index.At(RecordRef.Effective).GetDocument(two.ReferencerNpc.ToString(), two.ReferencerPlugin)!;
        Assert.Contains(result.NewFormKey!, referencer.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(two.TargetRace.ToString(), referencer.Body, StringComparison.Ordinal);
        Assert.Contains(index.At(RecordRef.Effective).GetReferencedBy(result.NewFormKey!), r => r.FormKey == two.ReferencerNpc.ToString());
    }

    // ADR-0045: the referencer's rewrite is rolled back with everything else, so the filter, still
    // re-applied on the failure path, shows the restored tree.
    [Fact]
    public void RenumberRecord_WhenTheTargetsOwnWriteFails_TheFilterReflectsTheRestoredTree()
    {
        using var two = TwoModFixture.Create(trackReferencer: true);
        const string requestedTarget = "900000:Base.esm";

        // Matches nothing yet: form_references still points every source at TargetRace's *old*
        // FormKey, not the one this renumber is about to move it to.
        two.Mirror.SetFilter(
            $"SELECT source_form_key AS form_key FROM form_references " +
            $"WHERE target_form_key = '{requestedTarget}' AND field_path = 'race'");
        Assert.Equal(0, two.Mirror.SettledReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        Chmod(two.TargetModFolder, "500"); // read+execute only — the new race source file can't be created
        try
        {
            var ex = Assert.Throws<IOException>(() =>
                ServiceFor(two.Mirror).RenumberRecord(two.TargetPlugin, two.TargetRace.ToString(), requestedTarget));
            // No repository is named as holding partial damage, because none does.
            Assert.Contains("back as it was", ex.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(TwoModFixture.ReferencerPluginName, ex.Message, StringComparison.Ordinal);

            // ADR-0045's path rule, asked of the one fault here that is a genuine OS error: the message names
            // the path it failed on, and no absolute path reaches the author. The relative remainder does.
            Assert.DoesNotContain(two.TargetModFolder, ex.Message, StringComparison.Ordinal);
            Assert.Contains(SourceRecordPath.RootFor(TwoModFixture.TargetPluginName), ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            Chmod(two.TargetModFolder, "700"); // restored before TwoModFixture.Dispose() needs to clean up
        }

        // The referencer's rewrite came back off disk and its rows were re-derived from the restored
        // file, so the filter — re-materialized even though the overall gesture threw — still matches
        // nothing, exactly as it did before the gesture ran.
        Assert.Equal(
            0, two.Mirror.SettledReads().Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);
        var referencer = two.Mirror.Projected()
            .GetDocument(two.ReferencerNpc.ToString(), two.ReferencerPlugin)!;
        Assert.Contains(two.TargetRace.ToString(), referencer.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(requestedTarget, referencer.Body, StringComparison.Ordinal);
    }

    // Process-shelled because File.SetUnixFileMode is flagged platform-unsafe even on a Linux-only
    // runtime. Recursive: the write this blocks lands several directories under the mod folder root.
    private static void Chmod(string path, string mode)
    {
        using var process = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "chmod", ["-R", mode, path])
        { RedirectStandardError = true })!;
        process.WaitForExit();
        if (process.ExitCode != 0)
            throw new InvalidOperationException($"chmod {mode} {path} failed: {process.StandardError.ReadToEnd()}");
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenAReferencerIsUntracked_NamingIt_AndWritesNothing()
    {
        using var two = TwoModFixture.Create(trackReferencer: false);
        var oldRaceSourceFile = two.SourceFileFor(two.TargetPlugin, two.TargetRace, "race", "TargetRace");

        var result = ServiceFor(two.Mirror).RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.UntrackedReferencer, result.Refusal);
        Assert.Contains(TwoModFixture.ReferencerPluginName, result.Message, StringComparison.Ordinal);

        // "No half-applied state": refused before any write, on either side of the cascade.
        Assert.True(File.Exists(oldRaceSourceFile));
        Assert.NotNull(two.Mirror.Projected().GetDocument(two.TargetRace.ToString(), two.TargetPlugin));
        var referencerBody = two.Mirror.Projected().GetDocument(two.ReferencerNpc.ToString(), two.ReferencerPlugin)!.Body!;
        Assert.Contains(two.TargetRace.ToString(), referencerBody, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenPluginIsUntracked_NamingTheTrackCommand()
    {
        using var mod = TrackedModFixture.Untracked();

        var result = ServiceFor(mod.Mirror).RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void RenumberRecord_Refuses_WhileAnExternalChangeQuestionIsUnanswered()
    {
        using var mod = TrackedModFixture.Tracked();
        ExternalChangeDeferral.Set(mod.ModFolder, TrackedModFixture.PluginName, "unanswered");

        var result = ServiceFor(mod.Mirror).RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ExternalChangeUnanswered, result.Refusal);
    }

    [Fact]
    public void PeekNextFreeFormKey_MatchesWhatRenumberWouldActuallyAllocate()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);

        var suggested = service.PeekNextFreeFormKey(mod.Plugin);
        var result = service.RenumberRecord(mod.Plugin, mod.Npc.ToString());

        Assert.True(suggested.Applied, suggested.Message);
        Assert.Equal(suggested.NewFormKey, result.NewFormKey);
    }

    [Fact]
    public void PeekNextFreeFormKey_Refuses_WhenNoLoadOrderIsLoaded()
    {
        using var mod = TrackedModFixture.Tracked();
        mod.Mirror.Dispose();

        var suggested = ProjectingEditService.Over(mod.Mirror)
            .PeekNextFreeFormKey(mod.Plugin);

        Assert.False(suggested.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, suggested.Refusal);
    }

    // The same typed-refusal standard as Create/Renumber.
    [Fact]
    public void PeekNextFreeFormKey_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = TrackedModFixture.Tracked();
        var service = ServiceFor(mod.Mirror);
        var seeded = service.CreateRecord(mod.Plugin, "npc_", "AtTheTop", "FFFFFF:Fixture.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = service.PeekNextFreeFormKey(mod.Plugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    private sealed class TwoModFixture : IDisposable
    {
        public const string ReferencerPluginName = "Winner.esp";
        public const string TargetPluginName = "Base.esm";
        private const string TargetOrigin = "TargetMod";
        private const string ReferencerOrigin = "ReferencerMod";

        public string TargetModFolder { get; }
        public string ReferencerModFolder { get; }
        public string GameDirectory { get; }
        public LoadOrderMirror Mirror { get; }
        public PluginKey TargetPlugin { get; } = new(TargetPluginName, TargetOrigin);
        public PluginKey WinnerPlugin { get; } = new(ReferencerPluginName, ReferencerOrigin);
        public PluginKey ReferencerPlugin => WinnerPlugin;
        public FormKey TargetRace { get; }
        public FormKey Npc { get; }
        public FormKey ReferencerNpc { get; }

        private TwoModFixture(bool trackReferencer)
        {
            TargetModFolder = Directory.CreateTempSubdirectory("medit-renumber-target-").FullName;
            ReferencerModFolder = Directory.CreateTempSubdirectory("medit-renumber-ref-").FullName;
            GameDirectory = Directory.CreateTempSubdirectory("medit-renumber-game-").FullName;

            var targetPath = Path.Combine(TargetModFolder, TargetPluginName);
            var targetMod = new Fallout4Mod(ModKey.FromFileName(TargetPluginName), Fallout4Release.Fallout4);
            var race = targetMod.Races.AddNew("TargetRace");
            var npc = targetMod.Npcs.AddNew("BaseNpc");
            targetMod.WriteToBinary(targetPath);
            (TargetRace, Npc) = (race.FormKey, npc.FormKey);

            var referencerPath = Path.Combine(ReferencerModFolder, ReferencerPluginName);
            var referencerMod = new Fallout4Mod(ModKey.FromFileName(ReferencerPluginName), Fallout4Release.Fallout4);
            referencerMod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName(TargetPluginName) });
            referencerMod.Npcs.Set(targetMod.Npcs.First(n => n.FormKey == npc.FormKey).DeepCopy()); // override, for the NotNativeRecord test
            var referencerNpc = referencerMod.Npcs.AddNew("ReferencerNpc");
            referencerNpc.Race.SetTo(race);
            referencerMod.WriteToBinary(referencerPath);
            ReferencerNpc = referencerNpc.FormKey;

            Mirror = new LoadOrderMirror(
                new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
            ((ILoadOrderMirror)Mirror).Reconcile(
                GameDirectory,
                [
                    new LoadOrderEntry(TargetPluginName, targetPath, TargetOrigin, Slot: 0, Enabled: true, Winning: true),
                    new LoadOrderEntry(ReferencerPluginName, referencerPath, ReferencerOrigin, Slot: 1, Enabled: true, Winning: true),
                ],
                GameRelease.Fallout4);

            new TrackService(NullLogger<TrackService>.Instance)
                .TrackAsync(Mirror.LoadOrder!, TargetOrigin, SourcePreset.Edits).GetAwaiter().GetResult();
            if (trackReferencer)
            {
                new TrackService(NullLogger<TrackService>.Instance)
                    .TrackAsync(Mirror.LoadOrder!, ReferencerOrigin, SourcePreset.Edits).GetAwaiter().GetResult();
            }
        }

        public static TwoModFixture Create(bool trackReferencer) => new(trackReferencer);

        // Resolved through SourceUnitResolver rather than SourceRecordPath.For directly — For
        // needs an order index this fixture has no reason to track.
        public string SourceFileFor(PluginKey plugin, FormKey formKey, string recordType, string? editorId) =>
            SourceUnitResolver.FlatSourcePath(
                plugin.Origin == TargetOrigin ? TargetModFolder : ReferencerModFolder,
                plugin.Name, recordType, formKey.ToString(), editorId, GameRelease.Fallout4);

        public void Dispose()
        {
            Mirror.Dispose();
            TryDelete(TargetModFolder);
            TryDelete(ReferencerModFolder);
            TryDelete(GameDirectory);
        }

        private static void TryDelete(string path)
        {
            try { Directory.Delete(path, recursive: true); }
            catch (IOException) { /* scratch directory, best effort */ }
            catch (UnauthorizedAccessException) { /* ditto */ }
        }
    }
}
