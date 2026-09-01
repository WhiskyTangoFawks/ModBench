using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>
/// Git-mediated source changes are
/// caught at <b>read time</b> by comparing what the file holds against what the index stored — no
/// watcher, because Modbench owns the <c>.git</c> folder and cannot be told when git moves under it.
///
/// <para>Every case here changes the working tree the way a <i>user</i> would — <c>git restore</c>,
/// a hand edit, <c>git commit</c> from a terminal — and then simply reads again. Nothing is told
/// that anything happened, which is the whole point: the read has to notice.</para>
///
/// <para>Both refs are re-derived, not just the working-tree side. After an external commit
/// "committed" itself has moved, so a freshness pass that only refreshed Effective would leave Head
/// serving bytes no ref holds any more.</para>
/// </summary>
public sealed class ReadTimeFreshnessTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService EditService() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_mod.Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcRelativePath => _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId);

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);

    private object? HeightMaxFromRecordEditor() =>
        Reads().GetRecord(_mod.Npc.ToString())!.Fields.Single(f => f.Metadata.Name == "height_max").Value;

    private object? HeightMaxFromCompareGrid() =>
        Reads().GetCompare(_mod.Npc.ToString())!.Overrides.Single()
            .Fields.Single(f => f.Metadata.Name == "height_max").Value;

    /// <summary>
    /// <b>Reading a tracked plugin's header must not destroy it.</b> #631 gave the header a real
    /// <c>body</c>, which put it inside this pass's reach for the first time — and the pass resolves
    /// a record's file through <c>SourceUnitResolver</c>, which cannot locate the root
    /// <c>RecordData.json</c> (no group folder, not a placement, and no FormKey in its filename for
    /// the fallback scan). An unguarded pass therefore reads "no file on disk holds this record",
    /// concludes the user deleted it, and folds a working-tree <i>deletion</i> of the header into the
    /// index — on an ordinary read, with nothing edited.
    ///
    /// <para>Read twice deliberately: the first read is what would do the damage, the second is what
    /// observes it. A single read would pass even against the broken behaviour, because
    /// <c>GetRecord</c> returns the document it fetched before the pass rewrote anything.</para>
    ///
    /// <para>Making the header a first-class source unit — so this pass can genuinely validate it
    /// against its own file — is separate work. Until then the honest behaviour is the one the header
    /// had before it carried a body: the pass leaves it alone.</para>
    /// </summary>
    [Fact]
    public void ReadingATrackedPluginsHeader_DoesNotFoldADeletionIntoTheIndex()
    {
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(_mod.ActualPluginName));

        var first = Reads().GetRecord(headerFormKey);
        Assert.NotNull(first);
        Assert.NotEmpty(first.Fields);

        var second = Reads().GetRecord(headerFormKey);
        Assert.NotNull(second);
        Assert.Equal(
            first.Fields.Select(f => (f.Metadata.Name, f.Value?.ToString())),
            second.Fields.Select(f => (f.Metadata.Name, f.Value?.ToString())));

        // The row is still there at both refs, and the working tree is still clean — a folded-in
        // deletion would show as a missing document, a dirtied tree, or both.
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, _mod.Plugin));
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Head).GetDocument(headerFormKey, _mod.Plugin));
        Assert.Empty(_mod.GitStatus());

        // ...and it reads as clean, not merely as present. This is the pinned statement of a
        // deliberate limit: giving the header a `ref` dimension made a dirty/diverged indicator
        // *representable* for the first time, and no path in this change can actually produce one —
        // SourceFreshness skips it, EditField refuses it at SourceUnitNotFound, and
        // SourceIngest.ReconcileHeadStructurally diffs through EnumerateMajorRecords, which a
        // ModHeader is not in. So the record editor renders exactly what it rendered before. When
        // the header does become a source unit, this assertion is the one that should be revisited
        // deliberately rather than discovered.
        var entry = Assert.Single(_mod.Mirror.Index!.At(RecordRef.Effective).GetOverrideStack(headerFormKey)!.Entries);
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(entry.Effective.Body, entry.Head.Body);
    }

    /// <summary>
    /// <b>Where the header's read-only-ness actually comes from</b> — recorded because it is easy to
    /// believe otherwise. #335/ADR-0038 keeps <c>masters</c> unwritable, and the header schema's
    /// <c>masters</c> column duly carries <c>Apply: null</c>
    /// (<c>HeaderIndexingTests.HeaderSchema_MastersColumn_CarriesNoWriteDelegate</c>) — but that
    /// column is not what refuses an edit today, and a reader who assumes it is would draw the wrong
    /// conclusion from removing it.
    ///
    /// <para>The refusal is <c>SourceUnitNotFound</c>, not <c>FieldNotWritable</c>: an edit is turned
    /// away at the gate, before any column is consulted, because no source unit resolves for a header
    /// FormKey. The column-level guard is therefore currently unreachable — kept as the leaf answer
    /// for when the header becomes a source unit, not because it is doing work now. This test is what
    /// makes that distinction checkable rather than a claim in a comment; when the header does become
    /// a source unit, this is the assertion that should flip to <c>FieldNotWritable</c>.</para>
    /// </summary>
    [Fact]
    public void EditingAHeaderField_IsRefusedAtTheGate_NotByTheColumnsMissingWriteDelegate()
    {
        var headerFormKey = HeaderIndexer.FormKeyFor(ModKey.FromFileName(_mod.ActualPluginName));

        var masters = EditService().EditField(
            _mod.Plugin, headerFormKey, HeaderIndexer.MastersFieldName, Json("[\"Other.esm\"]"));
        var author = EditService().EditField(
            _mod.Plugin, headerFormKey, "author", Json("\"Someone Else\""));

        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, masters.Refusal);
        // The writable-looking sibling refuses identically, which is the evidence that the refusal is
        // about the record, not about this one field's missing delegate.
        Assert.Equal(RecordEditRefusal.SourceUnitNotFound, author.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void RestoringASourceFileThroughGit_PutsTheCommittedValueBackInTheRecordEditor()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        Assert.Equal(0.75f, HeightMaxFromRecordEditor());

        // The gesture a user makes in the Source Control panel's "Discard Changes".
        Git("restore", "--", NpcRelativePath.Replace('\\', '/'));
        Assert.Empty(_mod.GitStatus());

        Assert.NotEqual(0.75f, HeightMaxFromRecordEditor());
    }

    [Fact]
    public void RestoringASourceFileThroughGit_PutsTheCommittedValueBackInTheCompareGrid()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        Assert.Equal(0.75f, HeightMaxFromCompareGrid());

        Git("restore", "--", NpcRelativePath.Replace('\\', '/'));

        Assert.NotEqual(0.75f, HeightMaxFromCompareGrid());
    }

    [Fact]
    public void RestoringASourceFileThroughGit_LeavesTheRecordCleanAgain_NotDirtyWithIdenticalBytes()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        Git("restore", "--", NpcRelativePath.Replace('\\', '/'));

        Reads().GetCompare(_mod.Npc.ToString());

        var entry = _mod.Mirror.Index!.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(entry.Effective.Body, entry.Head.Body);
    }

    [Fact]
    public void AHandEditToASourceFileOutsideModbench_IsPickedUpAtTheNextRead()
    {
        // Not through the edit path at all — a text editor, an agent's `sed`, another git client.
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        Assert.Equal("RenamedByHand", Reads().GetRecord(_mod.Npc.ToString())!.EditorId);
    }

    /// <summary>
    /// A source file rewritten with a leading UTF-8 BOM — content otherwise byte-for-byte
    /// identical, the way some external editors write UTF-8 by default (root CLAUDE.md's
    /// never-assume-exclusive-ownership rule) — must not read as a working-tree change. The
    /// flat case reads through <c>File.ReadAllText</c>, which strips a BOM via
    /// <c>StreamReader</c>'s own byte-order-mark detection; the general resolver's own read has to
    /// strip it the same way, or a BOM-carrying file mismatches the codec's own BOM-free body on
    /// <i>every</i> read — a self-heal that writes the BOM'd text in as Effective, which still
    /// mismatches Head, forever, rather than a one-time convergence.
    /// </summary>
    [Fact]
    public void ASourceFileRewrittenWithAUtf8Bom_DoesNotReadAsPerpetualDirt()
    {
        var original = File.ReadAllBytes(_mod.NpcSourceFile);
        var bomPrefixed = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(original).ToArray();
        File.WriteAllBytes(_mod.NpcSourceFile, bomPrefixed);

        Reads().GetRecord(_mod.Npc.ToString());

        var entry = _mod.Mirror.Index!.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(entry.Head.Body, entry.Effective.Body);
    }

    /// <summary>
    /// The path a user actually walks: the hand edit above, then <b>read again</b>.
    ///
    /// <para>The first read folds the new EditorID in from the file's content, so the index now says
    /// "RenamedByHand" while the file on disk is still named after "FixtureNpc" — nothing renames a
    /// file when its content is edited by a text editor. A second read that computed the source path
    /// from the <i>indexed</i> EditorID would find nothing at that name, conclude the file had been
    /// deleted, and mark a live record gone at Effective. One hand edit,
    /// two reads, and the record vanishes.</para>
    ///
    /// <para>Resolution leans on the FormKey suffix instead, which the rename never touches, so
    /// "genuinely absent" stays distinguishable from "present under a different name".</para>
    /// </summary>
    [Fact]
    public void AHandEditToEditorId_SurvivesASecondRead_RatherThanReadingAsDeleted()
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        // First read: the index still holds the old EditorID, so the computed path is the file's own
        // name and the new content is folded in. This much always worked.
        Assert.Equal("RenamedByHand", Reads().GetRecord(_mod.Npc.ToString())!.EditorId);

        // Second read: the index now holds the *new* EditorID and the file is still under the old one.
        var again = Reads().GetRecord(_mod.Npc.ToString());

        Assert.NotNull(again);
        Assert.Equal("RenamedByHand", again!.EditorId);
        // Still live at Effective, and still resolvable — a record marked deleted loses both.
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin));
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Effective).Resolve(_mod.Npc.ToString()));
    }

    /// <summary>
    /// The same divergence reached the other way — a file renamed on disk with its content left alone,
    /// which is what an interrupted <c>RecordEditService</c> rename leaves behind (it moves the file
    /// before writing the new bytes, deliberately). The record must still be found and editable, not
    /// read as deleted and not duplicated by a second file written at the stale path.
    /// </summary>
    [Fact]
    public void AFileRenamedOnDiskWithItsContentUnchanged_IsStillFoundAndEditable()
    {
        // NpcSourceFile resolves the record's real *current* file (SourceUnitResolver, live
        // off disk) rather than a fixed computed path, so it must be captured before the hand-rename
        // below — otherwise every later read of it would just re-find the file at its new location and
        // this test would stop testing anything.
        var originalPath = _mod.NpcSourceFile;
        var renamed = Path.Combine(
            Path.GetDirectoryName(originalPath)!,
            $"SomeOtherName - {_mod.Npc.ID:X6}_{_mod.Npc.ModKey.FileName}.json");
        File.Move(originalPath, renamed);

        var result = EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.6"));

        Assert.True(result.Applied, result.Message);
        // Written into the file that actually holds the record, not recreated at the stale computed
        // path — two files claiming one FormKey is the corruption AmbiguousSourceUnitException exists
        // for.
        Assert.False(File.Exists(originalPath));
        Assert.Contains("0.6", File.ReadAllText(renamed), StringComparison.Ordinal);
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin));
    }

    // The self-heal above folds an externally-changed source file into the read model as a
    // side effect of a *read* — still a mutation as far as _filter's one-shot snapshot is concerned,
    // so a record that only now matches an active filter must not stay hidden just because nothing
    // went through the explicit edit path.
    [Fact]
    public void AHandEditToASourceFileOutsideModbench_MakesTheRecordNewlyMatchAnActiveFilter_FilteredListingIncludesIt()
    {
        _mod.Mirror.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'RenamedByHand'");
        Assert.Equal(0, _mod.Mirror.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        Reads().GetRecord(_mod.Npc.ToString()); // triggers SourceFreshness.Validate's self-heal

        var result = _mod.Mirror.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
        Assert.Equal(1, result.Total);
        Assert.Equal(_mod.Npc.ToString(), result.Items[0].FormKey);
    }

    [Fact]
    public void CommittingAWorkingTreeChangeOutsideModbench_RebaselinesHeadOntoTheNewCommit()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        // A terminal commit. Modbench is not told, and nothing about the file changes — only HEAD.
        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");
        Assert.Empty(_mod.GitStatus());

        Reads().GetCompare(_mod.Npc.ToString());

        // "Committed" has moved, so the record is clean and *both* refs serve the new bytes. A pass
        // that refreshed only the working-tree side would still report this as dirt against a
        // baseline no ref holds any more.
        var entry = _mod.Mirror.Index!.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Contains("0.75", entry.Head.Body!, StringComparison.Ordinal);
        Assert.Equal(_mod.GitShowHead(NpcRelativePath), entry.Head.Body);
    }

    [Fact]
    public void CommittingThenEditingAgainOutsideModbench_LeavesHeadOnTheNewCommit_NotThePristineOne()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");

        // Dirty again, against the *new* HEAD, with no read in between the commit and this edit —
        // the one case where a naive "refresh the file side only" pass leaves Head permanently
        // pinned to the pristine baseline.
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.25"));

        Reads().GetCompare(_mod.Npc.ToString());

        var entry = _mod.Mirror.Index!.At(RecordRef.Effective).GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
        Assert.True(entry.HasWorkingTreeChange);
        Assert.Contains("0.25", entry.Effective.Body!, StringComparison.Ordinal);
        Assert.Equal(_mod.GitShowHead(NpcRelativePath), entry.Head.Body);
        Assert.Contains("0.75", entry.Head.Body!, StringComparison.Ordinal);
    }

    [Fact]
    public void AnUntrackedPluginIsNeverValidated_SoOrdinaryReadsStayUntouched()
    {
        // Positive control for the whole mechanism: freshness is a tracked-mod concern, and an
        // untracked plugin has no source text to be fresh against. The read must still work.
        using var untracked = TrackedModFixture.Untracked();
        var reads = new RecordQueryService(untracked.Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());

        Assert.Equal("FixtureNpc", reads.GetRecord(untracked.Npc.ToString())!.EditorId);
    }
}
