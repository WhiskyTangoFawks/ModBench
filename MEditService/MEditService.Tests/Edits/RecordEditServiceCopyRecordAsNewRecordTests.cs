using MEditService.Core.Edits;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// ADR-0041 restoration: xEdit's "Copy as New Record Into…" — a deep copy under a fresh
/// FormKey via Mutagen's own record-level <c>Duplicate</c>, reusing <see cref="RecordEditService.CreateRecord"/>'s
/// own target-FormKey resolution rather than re-implementing its collision posture.
/// </summary>
public sealed class RecordEditServiceCopyRecordAsNewRecordTests
{
    private static RecordEditService ServiceFor(ILoadOrderMirror mirror) =>
        new(mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void CopyRecordAsNewRecord_AllocatesAFreeFormKey_AndLandsAsAWorkingTreeRecordInTheDestination()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        Assert.NotNull(result.NewFormKey);
        Assert.NotEqual(mod.SourceNpc.ToString(), result.NewFormKey);
        Assert.EndsWith(":" + CopyFixture.DestinationPluginName, result.NewFormKey, StringComparison.Ordinal);

        var doc = mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(result.NewFormKey!, mod.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Equal(CopyFixture.SourceNpcEditorId, doc!.EditorId);

        // The source's own copy is untouched — this is a copy, not a move.
        Assert.NotNull(mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(mod.SourceNpc.ToString(), mod.SourcePlugin));
    }

    [Fact]
    public void CopyRecordAsNewRecord_WithARequestedFormKey_UsesItExactly()
    {
        using var mod = CopyFixture.Create();
        const string requested = "900000:Destination.esp";

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, requested);

        Assert.True(result.Applied, result.Message);
        Assert.Equal(requested, result.NewFormKey);
    }

    [Fact]
    public void CopyRecordAsNewRecord_IsAbsentAtHead_UntilCommittedAndCompiled()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.Null(mod.Mirror.Index!.At(RecordRef.Head).GetDocument(result.NewFormKey!, mod.DestinationPlugin));
    }

    // "Internal self-references follow the duplicate, not the
    // original" — RemapLinks fired right after Duplicate, on a record whose own FormLink field can
    // validly target its own record type (a Faction related to itself).
    [Fact]
    public void CopyRecordAsNewRecord_RemapsASelfReference_OntoTheNewFormKey_NotTheOriginal()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SelfLinkingFaction.ToString(), mod.DestinationPlugin);

        Assert.True(result.Applied, result.Message);
        var doc = mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(result.NewFormKey!, mod.DestinationPlugin);
        Assert.NotNull(doc);
        Assert.Contains(result.NewFormKey!, doc!.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(mod.SelfLinkingFaction.ToString(), doc.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheDestinationIsUntracked_NamingTheTrackCommand()
    {
        using var mod = CopyFixture.Create();
        Directory.Delete(Path.Combine(mod.DestinationModFolder, ".git"), recursive: true);

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.PluginNotTracked, result.Refusal);
        Assert.Contains("Modbench: Track…", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WithARequestedFormKey_Refuses_WhenItCollides()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, mod.DestinationNpc.ToString());

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeyCollision, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_WithARequestedFormKey_Refuses_WhenItBelongsToADifferentPlugin()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, "900000:SomeOtherPlugin.esp");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.NotNativeRecord, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheFormKeySpaceIsExhausted()
    {
        using var mod = CopyFixture.Create();
        var seeded = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(
            mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin, "FFFFFF:Destination.esp");
        Assert.True(seeded.Applied, seeded.Message);

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(mod.SourcePlugin, mod.SourceNpc.ToString(), mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FormKeySpaceExhausted, result.Refusal);
    }

    // A Cell is on xEdit's own permanent blacklist (CELL/WRLD/LAND/NAVM/PGRD/ROAD/NAVI) —
    // refused forever, not "not yet built" — distinct from the Quest/DialogTopic/INFO family below.
    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsACell_PermanentlyDisallowed()
    {
        using var fixture = new ContainerModFixture();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsNewRecord(fixture.Plugin, fixture.Cell.ToString(), fixture.Plugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, result.Refusal);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsAWorldspace_PermanentlyDisallowed()
    {
        using var fixture = new ContainerModFixture();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsNewRecord(fixture.Plugin, fixture.Worldspace.ToString(), fixture.Plugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.CopyAsNewRecordDisallowedForType, result.Refusal);
    }

    // A Quest is not on xEdit's permanent blacklist — DIAL/INFO/QUST allow a fresh
    // FormKey per xEdit itself — but that allowance is not built yet, so it still refuses.
    // The distinct "not yet" flavor is the point of this test: a caller sees a
    // different refusal here than for the permanently-disallowed types above.
    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourceIsAQuest_NotYetSupported()
    {
        using var fixture = new ContainerModFixture();

        var result = ServiceFor(fixture.Mirror).CopyRecordAsNewRecord(fixture.Plugin, fixture.Quest.ToString(), fixture.Plugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.ContainerRecordNotYetSupported, result.Refusal);
        Assert.Contains("not yet", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void CopyRecordAsNewRecord_Refuses_WhenTheSourcePluginDoesNotHoldTheRecord()
    {
        using var mod = CopyFixture.Create();

        var result = ServiceFor(mod.Mirror).CopyRecordAsNewRecord(mod.SourcePlugin, "ABCDEF:Source.esm", mod.DestinationPlugin);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
    }
}
