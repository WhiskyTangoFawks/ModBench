using MEditService.Core.Edits;

namespace MEditService.Tests.Edits;

/// <summary>The renumber cascade computes every affected record's new content before it writes
/// anything; a computation failure is a typed refusal with the tree untouched.</summary>
public sealed class RecordEditServiceRenumberCascadeTests
{
    [Fact]
    public void RenumberRecord_Refuses_WhenAReferencersOnlyLinkIsAStructListScriptProperty_NamingIt()
    {
        using var fixture = CascadeFixture.WithStructListReferencer();
        var referencerFile = fixture.SourceFileOf(fixture.Referencer, "npc_", "StructListNpc");
        var referencerBefore = File.ReadAllText(referencerFile);

        var result = fixture.Edits.RenumberRecord(fixture.Plugin, fixture.Target.ToString());

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.ReferenceRemapIncomplete, result.Refusal);
        Assert.Contains(fixture.Referencer.ToString(), result.Message, StringComparison.Ordinal);
        // The known-defect row is what names the member Mutagen's generated remap skips.
        Assert.Contains("IScriptStructListPropertyGetter.Structs", result.Message, StringComparison.Ordinal);

        // Refused before any write, on both sides of the cascade.
        Assert.Equal(referencerBefore, File.ReadAllText(referencerFile));
        Assert.True(File.Exists(fixture.SourceFileOf(fixture.Target, "race", "CascadeTargetRace")));
        Assert.NotNull(fixture.Document(fixture.Target.ToString()));
    }

    [Fact]
    public void RenumberRecord_Refuses_WhenTheTargetsOwnSelfLinkIsAStructListScriptProperty()
    {
        using var fixture = CascadeFixture.WithStructListSelfReferencingTarget();
        var targetFile = fixture.SourceFileOf(fixture.Target, "npc_", "SelfStructListNpc");
        var before = File.ReadAllText(targetFile);

        var result = fixture.Edits.RenumberRecord(fixture.Plugin, fixture.Target.ToString());

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.ReferenceRemapIncomplete, result.Refusal);
        Assert.Contains(fixture.Target.ToString(), result.Message, StringComparison.Ordinal);
        Assert.Equal(before, File.ReadAllText(targetFile));
    }

    [Fact]
    public void RenumberRecord_LeavesAnIncidentalFormKeyInAStringField_Alone()
    {
        using var fixture = CascadeFixture.WithSelfReferencingTarget();
        var oldFormKey = fixture.Target.ToString();

        var result = fixture.Edits.RenumberRecord(fixture.Plugin, oldFormKey);

        Assert.True(result.Applied, result.Message);
        var moved = fixture.Document(result.NewFormKey!)!;

        // The Name field says the old FormKey and always did — it is text, not a link, and nothing
        // in this gesture has any business touching it.
        Assert.Contains($"\"{oldFormKey}\"", moved.Body, StringComparison.Ordinal);
        // The self-link, by contrast, moved: it is the only *link* the record holds.
        Assert.Contains($"\"MorphRace\": \"{result.NewFormKey}\"", moved.Body, StringComparison.Ordinal);
    }

    // The tree is what a referencer is, so a document something else took out of it references
    // nothing: the cascade rewrites what is there and refuses over nothing that is not.
    [Fact]
    public void RenumberRecord_WhenAReferencersDirectoryHasGoneFromTheTree_RewritesWhatTheTreeStillHolds()
    {
        using var fixture = CascadeFixture.WithFlatAndWorldspaceReferencers();
        var survivingFile = fixture.SourceFileOf(fixture.Referencer, "acti", "FirstActivator");

        // A Worldspace is a directory-per-record container with no containment parent, so removing its
        // directory is the one shape that takes a whole referencer out of the tree.
        Directory.Delete(fixture.DirectoryOf(fixture.SecondReferencer), recursive: true);

        var result = fixture.Edits.RenumberRecord(fixture.Plugin, fixture.Target.ToString());

        Assert.True(result.Applied, result.Message);
        var surviving = File.ReadAllText(survivingFile);
        Assert.Contains(result.NewFormKey!, surviving, StringComparison.Ordinal);
        Assert.DoesNotContain(fixture.Target.ToString(), surviving, StringComparison.Ordinal);
    }
}
