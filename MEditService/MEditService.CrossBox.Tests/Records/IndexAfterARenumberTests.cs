using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.Index;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.Queries;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda;

namespace MEditService.Tests.Records;

/// <summary>ADR-0014: a renumber writes trees and nothing else, so what the Index serves afterwards
/// is what a projection of those trees made of it. Read here, never in the renumber suites.</summary>
public sealed class IndexAfterARenumberTests
{
    // Free at both refs in each fixture's target plugin, and requested rather than allocated so the
    // renumbered file's leaf name is nameable before the write.
    private const string NewRaceFormKey = "000F00:Target.esp";

    private static IndexProjector MirrorOver(LoadOrderHolder holder, string gameDirectory, IReadOnlyList<LoadOrderEntry> entries)
    {
        var index = new IndexProjector(
            holder,
            MutagenPluginAdapter.Instance,
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        index.Reconcile(holder, gameDirectory, entries, GameRelease.Fallout4);
        return index;
    }

    [Fact]
    public void ARenumberedRecord_IsGoneAtEffective_StillAtHead_AndItsNewKeyIsAbsentAtHead()
    {
        var holder = new LoadOrderHolder();
        using var two = RenumberTwoModFixture.Create(trackReferencer: true);
        using var index = MirrorOver(holder, two.GameDirectory, two.Entries);
        var oldFormKey = two.TargetRace.ToString();

        var result = two.RenumberHandler.RenumberRecord(two.TargetPlugin, oldFormKey);
        Assert.True(result.Applied, result.Message);

        Assert.Null(index.Projected().GetDocument(oldFormKey, two.TargetPlugin));
        Assert.NotNull(index.Projected(RecordRef.Head).GetDocument(oldFormKey, two.TargetPlugin));
        Assert.NotNull(index.Projected().GetDocument(result.NewFormKey!, two.TargetPlugin));
        Assert.Null(index.Projected(RecordRef.Head).GetDocument(result.NewFormKey!, two.TargetPlugin));
    }

    // A row under a brand-new FormKey the filter's one-shot snapshot never evaluated, with the old
    // one gone: without re-materializing, the record vanishes from a filtered listing.
    [Fact]
    public void ARenumberedRecord_AppearsUnderItsNewFormKeyInAnActiveFilteredListing()
    {
        var holder = new LoadOrderHolder();
        using var two = RenumberTwoModFixture.Create(trackReferencer: true);
        using var index = MirrorOver(holder, two.GameDirectory, two.Entries);
        index.SetFilter($"SELECT form_key FROM race WHERE editor_id = '{RenumberTwoModFixture.TargetRaceEditorId}'");
        var query = new RecordQuery(RecordTypes: ["race"], Limit: 10, Offset: 0);
        Assert.Equal(1, index.SettledReads().Search(query).Total);

        var result = two.RenumberHandler.RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());
        Assert.True(result.Applied, result.Message);

        var after = index.SettledReads().Search(query);
        Assert.Equal(1, after.Total);
        Assert.Equal(result.NewFormKey, after.Items[0].FormKey);
    }

    [Fact]
    public void ARenumberedReferencersRewrittenLink_ShowsInTheReferenceGraphUnderTheNewFormKey()
    {
        var holder = new LoadOrderHolder();
        using var two = RenumberTwoModFixture.Create(trackReferencer: true);
        using var index = MirrorOver(holder, two.GameDirectory, two.Entries);

        var result = two.RenumberHandler.RenumberRecord(two.TargetPlugin, two.TargetRace.ToString());
        Assert.True(result.Applied, result.Message);

        var reads = index.Projected();
        Assert.Contains(reads.GetReferencedBy(result.NewFormKey!), r => r.FormKey == two.ReferencerNpc.ToString());
        Assert.Empty(reads.GetReferencedBy(two.TargetRace.ToString()));
    }

    [Fact]
    public void ANeverCommittedRecordsRenumber_DropsItsOldFormKeyAtTheQueryLayer()
    {
        var holder = new LoadOrderHolder();
        using var mod = SourceEditFixture.Tracked();
        using var index = MirrorOver(holder, mod.GameDirectory, mod.Entries);
        const string oldFormKey = "800000:Fixture.esp";
        var seeded = mod.CreateHandler.CreateRecord(mod.Plugin, "npc_", "BrandNew", oldFormKey);
        Assert.True(seeded.Applied, seeded.Message);

        var result = mod.RenumberHandler.RenumberRecord(mod.Plugin, oldFormKey);
        Assert.True(result.Applied, result.Message);

        var reads = index.SettledReads();
        Assert.Null(reads.GetDocument(oldFormKey));
        Assert.NotNull(reads.GetDocument(result.NewFormKey!));
        var listing = reads.Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: mod.Plugin, Limit: 50, Offset: 0));
        Assert.DoesNotContain(listing.Items, r => r.FormKey == oldFormKey);
        Assert.Contains(listing.Items, r => r.FormKey == result.NewFormKey);
    }

    // ADR-0007: the referencer's rewrite is rolled back with everything else, so a filter
    // re-materialized after the failure shows the restored tree.
    [Fact]
    public void AfterARolledBackRenumber_AFilterOverTheReferenceGraphStillMatchesNothing()
    {
        var holder = new LoadOrderHolder();
        using var two = RenumberTwoModFixture.Create(trackReferencer: true);
        using var index = MirrorOver(holder, two.GameDirectory, two.Entries);
        const string requestedTarget = "900000:Base.esm";

        // Matches nothing yet: form_references still points every source at TargetRace's *old*
        // FormKey, not the one this renumber is about to move it to.
        index.SetFilter(
            "SELECT source_form_key AS form_key FROM form_references " +
            $"WHERE target_form_key = '{requestedTarget}' AND field_path = 'race'");
        var query = new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0);
        Assert.Equal(0, index.SettledReads().Search(query).Total);

        Chmod(two.TargetModFolder, "500"); // read+execute only — the new race source file can't be created
        try
        {
            var ex = Assert.Throws<IOException>(() =>
                two.RenumberHandler.RenumberRecord(two.TargetPlugin, two.TargetRace.ToString(), requestedTarget));
            // No repository is named as holding partial damage, because none does.
            Assert.Contains("back as it was", ex.Message, StringComparison.Ordinal);
            Assert.DoesNotContain(RenumberTwoModFixture.ReferencerPluginName, ex.Message, StringComparison.Ordinal);

            // ADR-0007's path rule, asked of the one fault here that is a genuine OS error: the message
            // names the path it failed on, and no absolute path reaches the author.
            Assert.DoesNotContain(two.TargetModFolder, ex.Message, StringComparison.Ordinal);
            Assert.Contains(
                SourceRepository.RootFor(RenumberTwoModFixture.TargetPluginName), ex.Message, StringComparison.Ordinal);
        }
        finally
        {
            Chmod(two.TargetModFolder, "700"); // restored before Dispose() needs to clean up
        }

        // The referencer's rewrite came back off disk and its rows were re-derived from the restored
        // file, so the filter matches nothing, exactly as it did before the gesture ran.
        Assert.Equal(0, index.SettledReads().Search(query).Total);
        var referencer = index.Projected().GetDocument(two.ReferencerNpc.ToString(), two.ReferencerPlugin)!;
        Assert.Contains(two.TargetRace.ToString(), referencer.Body!, StringComparison.Ordinal);
        Assert.DoesNotContain(requestedTarget, referencer.Body!, StringComparison.Ordinal);
    }

    [Fact]
    public void AfterARolledBackCascade_TheReferenceGraphStillNamesTheOldFormKey()
    {
        var holder = new LoadOrderHolder();
        using var fixture = new CascadeRollbackFixture();
        using var index = MirrorOver(holder, fixture.GameDirectory, fixture.Entries);
        var race = fixture.Race.ToString();

        // The renumbered record's own destination, which no document occupies yet: blocking a
        // referencer's file would take that referencer out of the tree.
        Directory.CreateDirectory(fixture.RenumberedRacePath(NewRaceFormKey) + ".tmp");

        Assert.Throws<IOException>(() =>
            fixture.RenumberHandler.RenumberRecord(fixture.TargetPlugin, race, NewRaceFormKey));

        var reads = index.Projected();
        Assert.Equal(3, reads.GetReferencedBy(race).Select(r => r.FormKey).Distinct().Count());

        // And nothing at the identity the renumber was reaching for.
        Assert.Null(reads.GetDocument(NewRaceFormKey, fixture.TargetPlugin));
        Assert.Empty(reads.GetReferencedBy(NewRaceFormKey));
    }

    [Fact]
    public void AfterARolledBackContainerRenumber_TheIndexAnswersTheOldIdentityAndNothingAtTheNewOne()
    {
        var holder = new LoadOrderHolder();
        using var fixture = new SourceContainerFixture();
        using var index = MirrorOver(holder, fixture.GameDirectory, fixture.Entries);
        var worldspace = fixture.Worldspace.ToString();
        const string newWorldspaceFormKey = "000F00:SourceContainer.esp";

        // Put a placeholder at the renumber's own target and read back where the repository landed it,
        // so the collision this plants sits at the tree's own answer, not a name recomputed here.
        var repository = SourceRepository.Over(fixture.ModFolder, GameRelease.Fallout4);
        var newWorldspace = new RecordIdentity(newWorldspaceFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId);
        repository.Put(fixture.Plugin, new SourceDocument(
            newWorldspaceFormKey, "wrld", SourceContainerFixture.WorldspaceEditorId, "{}"));
        var relocated = Path.GetDirectoryName(SourceDocumentPath.Of(
            fixture.ModFolder, fixture.Plugin.Name, "wrld", newWorldspaceFormKey,
            SourceContainerFixture.WorldspaceEditorId, GameRelease.Fallout4))!;
        repository.Remove(fixture.Plugin, newWorldspace);
        Directory.CreateDirectory(relocated);
        File.WriteAllText(Path.Combine(relocated, "occupied.txt"), "something else is here");

        Assert.Throws<IOException>(() =>
            fixture.RenumberHandler.RenumberRecord(fixture.Plugin, worldspace, newWorldspaceFormKey));

        // The projector re-read the restored tree, so the old identity is what answers: the
        // rollback put the files back and nothing else had to unwind an index.
        var reads = index.Projected();
        Assert.NotNull(reads.GetDocument(worldspace, fixture.Plugin));
        Assert.Null(reads.GetDocument(newWorldspaceFormKey, fixture.Plugin));
        Assert.Equal(worldspace, reads.GetCellLocation(fixture.Plugin, fixture.TopCell.ToString())?.ParentWorldspace);
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
}
