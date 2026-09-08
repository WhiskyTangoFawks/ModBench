using MEditService.Core.Edits;
using MEditService.Core.Source;

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

    // OMOD's document names its own concrete class, not the schema's table key. A referencer no
    // collector was run over is one whose link a renumber leaves dangling while reporting success.
    [Fact]
    public void RenumberRecord_RewritesALinkHeldByAPathAmbiguousGroupsDocument()
    {
        using var fixture = CascadeFixture.WithPathAmbiguousGroupReferencer();
        var oldFormKey = fixture.Target.ToString();

        var result = fixture.Edits.RenumberRecord(fixture.Plugin, oldFormKey);

        Assert.True(result.Applied, result.Message);
        var referencer = fixture.Document(fixture.Referencer.ToString())!;
        Assert.Contains(result.NewFormKey!, referencer.Body, StringComparison.Ordinal);
        Assert.DoesNotContain(oldFormKey, referencer.Body, StringComparison.Ordinal);
    }

    // What a link is, is a FormKey, not the text that spells it: a document something else edited may
    // hold the same key in a different case, and a text comparison reads that as a different record.
    [Fact]
    public void RenumberRecord_RewritesALinkWhoseDocumentSpellsTheFormKeyInAnotherCase()
    {
        using var fixture = CascadeFixture.WithFlatAndWorldspaceReferencers();
        var oldFormKey = fixture.Target.ToString();
        var referencerFile = fixture.SourceFileOf(fixture.Referencer, "acti", "FirstActivator");
        File.WriteAllText(
            referencerFile,
            File.ReadAllText(referencerFile).Replace(oldFormKey, oldFormKey.ToLowerInvariant(), StringComparison.Ordinal));

        var result = fixture.Edits.RenumberRecord(fixture.Plugin, oldFormKey);

        Assert.True(result.Applied, result.Message);
        var rewritten = File.ReadAllText(referencerFile);
        Assert.Contains(result.NewFormKey!, rewritten, StringComparison.Ordinal);
        Assert.DoesNotContain(oldFormKey, rewritten, StringComparison.OrdinalIgnoreCase);
    }

    // A record type the schema excludes (land, navm) is one the collector cannot be run over, and a
    // guard that cannot run has cleared nothing: the gesture refuses rather than skipping the
    // document and leaving whatever it holds behind.
    [Fact]
    public void RenumberRecord_Refuses_WhenADocumentTheCollectorCannotReadMentionsTheTarget()
    {
        using var fixture = CascadeFixture.WithSelfReferencingTarget();
        var oldFormKey = fixture.Target.ToString();
        var strays = Directory.CreateDirectory(Path.Combine(
            fixture.ModFolder, SourceRepository.RootFor(CascadeFixture.PluginName), "Strays")).FullName;
        File.WriteAllText(
            Path.Combine(strays, "Stray - 000F00_Cascade.esp.json"),
            "{\n  \"MutagenObjectType\": \"Landscape\",\n  \"FormKey\": \"000F00:Cascade.esp\",\n" +
            $"  \"EditorID\": \"{oldFormKey}\"\n}}");

        var result = fixture.Edits.RenumberRecord(fixture.Plugin, oldFormKey);

        Assert.False(result.Applied, result.Message);
        Assert.Equal(RecordEditRefusal.ReferenceRemapIncomplete, result.Refusal);
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
