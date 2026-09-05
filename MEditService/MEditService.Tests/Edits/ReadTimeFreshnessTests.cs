using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Edits;

/// <summary>No watcher: Modbench owns the <c>.git</c> folder and cannot be told when git moves
/// under it, so every case changes the tree as a user would and reads again.</summary>
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

    private string HeaderFormKey => HeaderIndexer.FormKeyFor(ModKey.FromFileName(_mod.ActualPluginName));

    private string HeaderSourceFile => Path.Combine(_mod.ModFolder, "source", _mod.ActualPluginName, "RecordData.json");

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);

    private object? HeightMaxFromRecordEditor() =>
        Reads().GetRecord(_mod.Npc.ToString())!.Fields.Single(f => f.Metadata.Name == "HeightMax").Value;

    private object? HeightMaxFromCompareGrid() =>
        Reads().GetCompare(_mod.Npc.ToString())!.Overrides.Single()
            .Fields.Single(f => f.Metadata.Name == "HeightMax").Value;

    [Fact]
    public void ReadingATrackedPluginsHeader_DoesNotFoldADeletionIntoTheIndex()
    {
        var headerFormKey = HeaderFormKey;

        var text = File.ReadAllText(HeaderSourceFile);
        File.WriteAllText(HeaderSourceFile, text.Replace(
            "\"ModHeader\": {", "\"ModHeader\": {\n    \"Author\": \"RenamedByHand\",", StringComparison.Ordinal));

        var first = Reads().GetRecord(headerFormKey);
        Assert.NotNull(first);
        Assert.NotEmpty(first.Fields);

        var second = Reads().GetRecord(headerFormKey);
        Assert.NotNull(second);
        Assert.Equal(
            first.Fields.Select(f => (f.Metadata.Name, f.Value?.ToString())),
            second.Fields.Select(f => (f.Metadata.Name, f.Value?.ToString())));

        // The row is still there at both refs — a folded-in deletion would show as a missing
        // document, at one ref or both.
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(headerFormKey, _mod.Plugin));
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Head).GetDocument(headerFormKey, _mod.Plugin));
        Assert.NotEmpty(_mod.GitStatus());

        // ...and it reads as genuinely dirty, not merely as present. A dirty header became representable
        // only once SourceFreshness stopped skipping it, EditField stopped refusing it at the gate, and
        // the structural Head reconcile stopped diffing through EnumerateMajorRecords.
        var entry = Assert.Single(_mod.Mirror.Index!.At(RecordRef.Effective).GetOverrideStack(headerFormKey)!.Entries);
        Assert.True(entry.HasWorkingTreeChange);
        Assert.NotEqual(entry.Effective.Body, entry.Head.Body);
    }

    [Fact]
    public void AHandEditToTheHeaderFileOutsideModbench_IsPickedUpAtTheNextRead()
    {
        var text = File.ReadAllText(HeaderSourceFile);
        File.WriteAllText(HeaderSourceFile, text.Replace(
            "\"ModHeader\": {", "\"ModHeader\": {\n    \"Author\": \"RenamedByHand\",", StringComparison.Ordinal));

        var author = Reads().GetRecord(HeaderFormKey)!.Fields.Single(f => f.Metadata.Name == "author").Value;

        Assert.Equal("RenamedByHand", author);
    }

    [Fact]
    public void EditingAHeaderField_IsRefusedByTheColumnsMissingWriteDelegate_NowThatTheGateDoesNotBlockIt()
    {
        var masters = EditService().EditField(
            _mod.Plugin, HeaderFormKey, HeaderIndexer.MastersFieldName, Json("[\"Other.esm\"]"));
        var author = EditService().EditField(
            _mod.Plugin, HeaderFormKey, "author", Json("\"Someone Else\""));

        Assert.Equal(RecordEditRefusal.FieldReadOnly, masters.Refusal);
        // The writable-looking sibling refuses identically, which is the evidence that no
        // masters-specific mechanism exists — every header column is equally unwritten today.
        Assert.Equal(RecordEditRefusal.FieldReadOnly, author.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void RestoringASourceFileThroughGit_PutsTheCommittedValueBackInTheRecordEditor()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        Assert.Equal(0.75f, HeightMaxFromRecordEditor());

        // The gesture a user makes in the Source Control panel's "Discard Changes".
        Git("restore", "--", NpcRelativePath.Replace('\\', '/'));
        Assert.Empty(_mod.GitStatus());

        Assert.NotEqual(0.75f, HeightMaxFromRecordEditor());
    }

    [Fact]
    public void RestoringASourceFileThroughGit_PutsTheCommittedValueBackInTheCompareGrid()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        Assert.Equal(0.75f, HeightMaxFromCompareGrid());

        Git("restore", "--", NpcRelativePath.Replace('\\', '/'));

        Assert.NotEqual(0.75f, HeightMaxFromCompareGrid());
    }

    [Fact]
    public void RestoringASourceFileThroughGit_LeavesTheRecordCleanAgain_NotDirtyWithIdenticalBytes()
    {
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
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

    [Fact]
    public void AFileRenamedOnDiskWithItsContentUnchanged_IsStillFoundAndEditable()
    {
        // NpcSourceFile resolves the record's real current file live off disk, so it must be captured
        // before the hand-rename below, or every later read would just re-find the file at its new spot.
        var originalPath = _mod.NpcSourceFile;
        var renamed = Path.Combine(
            Path.GetDirectoryName(originalPath)!,
            $"SomeOtherName - {_mod.Npc.ID:X6}_{_mod.Npc.ModKey.FileName}.json");
        File.Move(originalPath, renamed);

        var result = EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.6"));

        Assert.True(result.Applied, result.Message);
        // Written into the file that actually holds the record, not recreated at the stale computed
        // path — two files claiming one FormKey is the corruption AmbiguousSourceUnitException exists
        // for.
        Assert.False(File.Exists(originalPath));
        Assert.Contains("0.6", File.ReadAllText(renamed), StringComparison.Ordinal);
        Assert.NotNull(_mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin));
    }

    // The self-heal folds an externally-changed source file into the read model as a side effect of a
    // read, which is still a mutation as far as _filter's one-shot snapshot is concerned.
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
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));

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
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.75"));
        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");

        // Dirty again, against the *new* HEAD, with no read in between the commit and this edit —
        // the one case where a naive "refresh the file side only" pass leaves Head permanently
        // pinned to the pristine baseline.
        EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", Json("0.25"));

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
