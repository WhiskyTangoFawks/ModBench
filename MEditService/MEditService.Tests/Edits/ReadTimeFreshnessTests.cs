using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #415 AC2, and the mechanism the issue comment pinned for it: git-mediated source changes are
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
        new(_mod.Sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_mod.Sessions, SharedSchemaReflector.Instance, new ConflictClassifier());

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private string NpcRelativePath => TrackedModFixture.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId);

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);

    private object? HeightMaxFromRecordEditor() =>
        Reads().GetRecord(_mod.Npc.ToString())!.Fields.Single(f => f.Metadata.Name == "height_max").Value;

    private object? HeightMaxFromCompareGrid() =>
        Reads().GetCompare(_mod.Npc.ToString())!.Overrides.Single()
            .Fields.Single(f => f.Metadata.Name == "height_max").Value;

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

        var entry = _mod.Sessions.Index!.GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
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
    /// #453 review finding 1, the path a user actually walks: the hand edit above, then <b>read
    /// again</b>.
    ///
    /// <para>The first read folds the new EditorID in from the file's content, so the index now says
    /// "RenamedByHand" while the file on disk is still named after "FixtureNpc" — nothing renames a
    /// file when its content is edited by a text editor. The second read then computes the source path
    /// from the <i>indexed</i> EditorID, finds nothing at that name, and — before this was fixed —
    /// concluded the file had been deleted and marked a live record gone at Effective. One hand edit,
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
        Assert.NotNull(_mod.Sessions.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin));
        Assert.NotNull(_mod.Sessions.Index!.Resolve(_mod.Npc.ToString()));
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
        var renamed = Path.Combine(
            Path.GetDirectoryName(_mod.NpcSourceFile)!,
            $"SomeOtherName - {_mod.Npc.ID:X6}_{_mod.Npc.ModKey.FileName}.json");
        File.Move(_mod.NpcSourceFile, renamed);

        var result = EditService().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.6"));

        Assert.True(result.Applied, result.Message);
        // Written into the file that actually holds the record, not recreated at the stale computed
        // path — two files claiming one FormKey is the corruption AmbiguousSourceUnitException exists
        // for, and the flat path is the one that used never to look.
        Assert.False(File.Exists(_mod.NpcSourceFile));
        Assert.Contains("0.6", File.ReadAllText(renamed), StringComparison.Ordinal);
        Assert.NotNull(_mod.Sessions.Index!.GetDocument(_mod.Npc.ToString(), _mod.Plugin));
    }

    // #422: the self-heal above folds an externally-changed source file into the read model as a
    // side effect of a *read* — still a mutation as far as _filter's one-shot snapshot is concerned,
    // so a record that only now matches an active filter must not stay hidden just because nothing
    // went through the explicit edit path.
    [Fact]
    public void AHandEditToASourceFileOutsideModbench_MakesTheRecordNewlyMatchAnActiveFilter_FilteredListingIncludesIt()
    {
        _mod.Sessions.SetFilter("SELECT form_key FROM npc_ WHERE editor_id = 'RenamedByHand'");
        Assert.Equal(0, _mod.Sessions.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        Reads().GetRecord(_mod.Npc.ToString()); // triggers SourceFreshness.Validate's self-heal

        var result = _mod.Sessions.Repository!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
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
        var entry = _mod.Sessions.Index!.GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
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

        var entry = _mod.Sessions.Index!.GetOverrideStack(_mod.Npc.ToString())!.Entries.Single();
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
        var reads = new RecordQueryService(untracked.Sessions, SharedSchemaReflector.Instance, new ConflictClassifier());

        Assert.Equal("FixtureNpc", reads.GetRecord(untracked.Npc.ToString())!.EditorId);
    }
}
