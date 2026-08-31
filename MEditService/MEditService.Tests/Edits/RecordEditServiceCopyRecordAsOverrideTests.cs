using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// #436 (ADR-0041 restoration): xEdit's "Copy as Override Into…" — #281 shipped this, ADR-0041's
/// sweep tore it out along with the storage layer it happened to sit on, and #426/#427's
/// re-implementation wave never carried it forward. This suite is the entry point's own contract:
/// same-FormKey landing in the destination's own working tree, the collision/container/untracked
/// refusals every gesture on this write path either inherits or reuses, and the two read postures
/// (tracked source's own file, untracked source's indexed body) #453/#452 already established for
/// <see cref="RecordEditService.EditField"/>.
/// </summary>
public sealed class RecordEditServiceCopyRecordAsOverrideTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void CopyRecordAsOverride_FromAnUntrackedSource_LandsUnderTheSameFormKey_AndAnswersAtEffective()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        // Not NewFormKey: an override echoes the caller's own FormKey rather than minting one
        // (RecordEditResult's own doc comment), so success here carries no new FormKey at all —
        // the same "success, nothing new" shape DeleteRecord's own result uses.
        Assert.Null(result.NewFormKey);

        var sourceFile = mod.SourceFileFor(mod.DestinationPlugin, mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId);
        Assert.True(File.Exists(sourceFile));

        var doc = mod.Mirror.Index!.GetDocument(mod.SourceNpc.ToString(), mod.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(CopyFixture.SourceNpcEditorId, doc!.EditorId);

        // The source plugin's own copy is untouched — this is a copy, not a move.
        Assert.NotNull(mod.Mirror.Index!.GetDocument(mod.SourceNpc.ToString(), mod.SourcePlugin));
    }

    [Fact]
    public void CopyRecordAsOverride_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.Null(mod.Mirror.Index!.At(RecordRef.Head).GetDocument(mod.SourceNpc.ToString(), mod.DestinationPlugin));
    }

    // #452/#453's own read posture: a tracked source reads its current file, not a stale index
    // snapshot — proven by mutating the file on disk directly (never-assume-exclusive-ownership) after
    // the load order has already indexed it, then observing the copy carries the mutated bytes forward.
    [Fact]
    public void CopyRecordAsOverride_FromATrackedSource_ReadsItsCurrentFileBytes_NotAStaleIndexSnapshot()
    {
        using var mod = CopyFixture.Create(trackSource: true);
        var sourceFile = mod.SourceFileFor(mod.SourcePlugin, mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId);
        var mutatedText = File.ReadAllText(sourceFile).Replace(CopyFixture.SourceNpcEditorId, "MutatedOnDisk");
        File.WriteAllText(sourceFile, mutatedText);

        var result = ServiceFor(mod.Mirror).CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var destinationFile = mod.SourceFileFor(mod.DestinationPlugin, mod.SourceNpc, "npc_", "MutatedOnDisk");
        Assert.True(File.Exists(destinationFile));
        Assert.Contains("MutatedOnDisk", File.ReadAllText(destinationFile), StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheDestinationIsUntracked_NamingTheTrackCommand()
    {
        using var mod = CopyFixture.Create();
        // The destination fixture always tracks; simulate an untracked destination the same way
        // TrackedModFixture.Untracked() does — no .git in the folder at all.
        Directory.Delete(Path.Combine(mod.DestinationModFolder, ".git"), recursive: true);

        var result = ServiceFor(mod.Mirror).CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheDestinationAlreadyHoldsTheFormKey()
    {
        using var mod = CopyFixture.Create();
        // Seeded directly at the index layer (bypassing the service), the same way
        // RecordEditServiceCreateRecordTests seeds a both-refs collision fixture — this is what "the
        // destination already carries this FormKey at some ref" looks like in the index.
        var seedBody = mod.Mirror.Index!.GetDocument(mod.SourceNpc.ToString(), mod.SourcePlugin)!.Body!;
        mod.Mirror.Index!.CreateWorkingTreeRecord(mod.DestinationPlugin, mod.SourceNpc.ToString(), "npc_", seedBody);

        var result = ServiceFor(mod.Mirror).CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    // #440 Slice 1: a container's own top-level record (Cell/Worldspace/Quest) is no longer refused
    // here — see RecordEditServiceContainerCopyTests. What still refuses is a record with no top-level
    // group of its own at all — a DialogTopic has no independent existence outside its owning Quest
    // (Fallout4Mod carries no top-level DialogTopics property; ContainerChildFields' own doc comment),
    // unlike a placed reference (RecordEditServiceContainerCopyTests covers that narrower, deliberately
    // still-refused-until-Slice-6 shape).
    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheSourceHasNoContainerOfItsOwnAnywhere()
    {
        using var fixture = new ContainerModFixture();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsOverride(fixture.Plugin, fixture.DialogTopic.ToString(), fixture.Plugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsOverride_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsOverride(mod.SourcePlugin, "ABCDEF:Source.esm", mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }

    // #422: a brand-new row was never evaluated against an active filter's snapshot.
    [Fact]
    public void CopyRecordAsOverride_MakesTheCopyAppearInAnActiveFilteredListing()
    {
        using var mod = CopyFixture.Create();
        mod.Mirror.SetFilter("SELECT form_key FROM npc_");
        var query = new RecordQuery(RecordTypes: ["npc_"], Plugin: mod.DestinationPlugin, Limit: 50, Offset: 0);
        var before = mod.Mirror.Reads!.Search(query).Total;

        var result = ServiceFor(mod.Mirror).CopyRecordAsOverride(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var after = mod.Mirror.Reads!.Search(query);
        Assert.Equal(before + 1, after.Total);
    }
}
