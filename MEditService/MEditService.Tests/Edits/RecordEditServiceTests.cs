using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.Edits;

/// <summary>
/// Editing a field on a tracked plugin produces working-tree dirt on that record's source
/// file — the single write path (ADR-0041). Asserted against a real git repo through the real CLI,
/// because "visible and diffable in the native Source Control panel" is a claim about what
/// <c>git status</c> says, and nothing else can answer it.
/// </summary>
public sealed class RecordEditServiceTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private RecordEditService Service() =>
        new(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    // ---- an editor_id edit is a rename as well as a content change ----

    /// <summary>
    /// The source unit's file name carries the EditorID, so writing a new one has to move the file as
    /// well as rewrite it — otherwise path and content disagree, and the tree claims a record still has
    /// the name it no longer has.
    ///
    /// <para><c>SchemaReflector.BaseSkip</c> excludes <c>EditorID</c> from the reflected
    /// columns (it is a row identity column, carried separately), so <c>RecordFieldWriter</c> alone
    /// would answer <c>FieldNotFound</c> — this edit needs its own dedicated path.</para>
    /// </summary>
    [Fact]
    public void EditingEditorId_MovesTheSourceFileToItsNewName()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId);
        var oldPrefix = SourceUnitResolver.TryGetOrderIndex(Path.GetFileName(oldRelative));
        Assert.True(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "editor_id", Json("\"RenamedNpc\""));

        Assert.True(result.Applied, result.Message);
        Assert.False(File.Exists(Path.Combine(_mod.ModFolder, oldRelative)));
        // Resolved *after* the rename, not before — RelativeSourcePath answers where the record
        // actually is right now (SourceUnitResolver, live off disk), and before the rename that is
        // still the old file (FormKey-suffix matching finds it under either EditorID).
        //
        // That same disk-live resolution is also why "the file is findable at its expected new name"
        // alone would NOT catch a rename that drops the "[N] " order prefix: FormKey-suffix matching
        // is deliberately blind to it and would still find the (wrongly unprefixed) file. The prefix
        // check right below is the assertion that actually rules that out — verified against the real
        // rival (RenameSourceUnit with prefix-preservation removed): it passes the File.Exists checks
        // here unchanged and only this one goes red.
        var newRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", "RenamedNpc");
        var moved = Path.Combine(_mod.ModFolder, newRelative);
        Assert.True(File.Exists(moved));
        Assert.Equal(oldPrefix, SourceUnitResolver.TryGetOrderIndex(Path.GetFileName(newRelative)));
        Assert.Contains("\"EditorID\": \"RenamedNpc\"", File.ReadAllText(moved), StringComparison.Ordinal);
        Assert.Equal("RenamedNpc", _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.EditorId);
    }

    /// <summary>
    /// The rename, asserted in the form git can actually produce.
    ///
    /// <para><b>Unstaged, git reports a rename as delete + untracked add, always</b> — measured on real
    /// git: <c>git status --porcelain</c> gives <c>" D &lt;old&gt;"</c> plus
    /// <c>"?? &lt;new&gt;"</c>, and <c>git diff -M</c> agrees, because git does no rename detection
    /// against untracked paths. That is git's design and not a deficiency in this write path — "git
    /// status shows a rename" is not satisfiable by any
    /// implementation. Rename detection is a diff-time inference from content similarity, so it appears
    /// the moment the change is staged — the gesture that precedes every commit.</para>
    ///
    /// <para><b>The similarity margin is real but thin at the bottom end.</b> Measured on the same
    /// pass: <c>R099</c> for a container's <c>RecordData.json</c>, <c>R067</c> for a four-line flat
    /// record, and <c>R050</c> for the pathological minimum (a document holding nothing but FormKey and
    /// EditorID, renamed from a 1-character EditorID to a 10-character one) — exactly git's default 50%
    /// threshold. If the document shape ever shrinks, R050 is the number that says this is at risk.</para>
    /// </summary>
    [Fact]
    public void EditingEditorId_ShowsAsARenameOnceStaged_NotADeleteAndAdd()
    {
        var oldRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId)
            .Replace('\\', '/');

        Assert.True(Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "editor_id", Json("\"RenamedNpc\"")).Applied);

        // Resolved *after* the rename — see the sibling test's own comment. Resolving both paths
        // up front would have them collide on the same (still-old) file and make the assertions below
        // pass without checking anything.
        var newRelative = _mod.RelativeSourcePath(_mod.Npc, "npc_", "RenamedNpc").Replace('\\', '/');

        // The unstaged reality, asserted rather than glossed, so a future reader does not mistake it
        // for a bug in the write path.
        Assert.Contains($"D {oldRelative}", _mod.GitStatus());

        var git = Path.Combine(_mod.ModFolder, ".git");
        GitCli.Run(git, _mod.ModFolder, "add", "-A");
        var staged = GitCli.Run(git, _mod.ModFolder, "diff", "--cached", "-M", "--name-status")
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(l => l.Trim())
            .ToList();

        var rename = Assert.Single(staged, l => l.StartsWith('R'));
        Assert.Contains(oldRelative, rename, StringComparison.Ordinal);
        Assert.Contains(newRelative, rename, StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_OnATrackedPlugin_LeavesTheRecordsSourceFileDirtyInTheSourceControlPanel()
    {
        // Track has just committed the complete pristine state, so anything git reports afterwards
        // is this edit's own doing — the positive control for every status assertion below.
        Assert.Empty(_mod.GitStatus());

        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        Assert.True(result.Applied, result.Message);
        var relative = _mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId).Replace('\\', '/');
        Assert.Equal([$"M {relative}"], _mod.GitStatus());
    }

    [Fact]
    public async Task EditField_WritesTheNewValueIntoTheSourceFile_AsRealCodecText()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        // Re-parsed through the codec rather than string-matched: the file has to remain a document
        // the source can round-trip, not merely text that happens to contain the right number.
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var reparsed = await codec.DeserializeAsync(_mod.NpcSourceFile, GameRelease.Fallout4, "npc_");
        Assert.Equal(_mod.Npc, reparsed.FormKey);

        // ...and the value is read back through the same typed extraction the record editor renders
        // from, not by reaching into the Mutagen object a second way.
        var field = _mod.Mirror.Index!.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!
            .Fields.Single(f => f.Metadata.Name == "height_max");
        Assert.Equal(0.75f, Assert.IsType<float>(field.Value));
    }

    [Fact]
    public void EditField_ChangesOnlyTheEditedRecordsFile()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        var status = _mod.GitStatus();
        Assert.Single(status);
        Assert.DoesNotContain(_mod.RelativeSourcePath(_mod.OtherNpc, "npc_", TrackedModFixture.OtherNpcEditorId).Replace('\\', '/'), status[0], StringComparison.Ordinal);
    }

    [Fact]
    public void EditField_MakesTheReadModelServeTheNewValueAtEffective_AndTheCommittedOneAtHead()
    {
        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        // The file write and the index update are one gesture: a write path that produced dirt on
        // disk but left the editor showing the old value, or vice versa, is half a write path.
        var index = _mod.Mirror.Index!;
        var effective = index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!;
        Assert.Contains("0.75", effective.Body!, StringComparison.Ordinal);

        var head = index.At(RecordRef.Head).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!;
        Assert.DoesNotContain("0.75", head.Body!, StringComparison.Ordinal);
        Assert.Equal(_mod.GitShowHead(_mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId)), head.Body);
    }

    [Fact]
    public void EditField_TwiceOnTheSameRecord_KeepsTheCommittedStateAsTheBaseline()
    {
        var service = Service();
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));
        service.EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.5"));

        // The second edit must not re-baseline against the first: Head is what the last commit
        // holds, not "the value before the most recent keystroke".
        var index = _mod.Mirror.Index!;
        Assert.Contains("0.5", index.At(RecordRef.Effective).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body!, StringComparison.Ordinal);
        Assert.Equal(
            _mod.GitShowHead(_mod.RelativeSourcePath(_mod.Npc, "npc_", TrackedModFixture.NpcEditorId)),
            index.At(RecordRef.Head).GetDocument(_mod.Npc.ToString(), _mod.Plugin)!.Body);
    }

    [Fact]
    public void EditField_WithAnUnknownFieldName_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "NoSuchField", Json("1"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    [Fact]
    public void EditField_ForAFormKeyThePluginDoesNotHold_RefusesAndLeavesTheWorkingTreeClean()
    {
        var result = Service().EditField(_mod.Plugin, "ABCDEF:NotHere.esp", "height_max", Json("0.75"));

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordNotFound, result.Refusal);
        Assert.Empty(_mod.GitStatus());
    }

    // _filter is a one-shot snapshot of whatever matched when SetFilter ran — a field edit that
    // changes the value a filter predicate reads can flip that record's membership, and nothing but
    // the edit path itself is positioned to re-materialize it afterward.
    [Fact]
    public void EditField_MakesTheRecordNewlyMatchAnActiveFilter_FilteredListingIncludesIt()
    {
        _mod.Mirror.SetFilter("SELECT form_key FROM npc_ WHERE height_max = 0.75");
        Assert.Equal(0, _mod.Mirror.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0)).Total);

        Service().EditField(_mod.Plugin, _mod.Npc.ToString(), "height_max", Json("0.75"));

        var result = _mod.Mirror.Reads!.Search(new RecordQuery(RecordTypes: ["npc_"], Limit: 10, Offset: 0));
        Assert.Equal(1, result.Total);
        Assert.Equal(_mod.Npc.ToString(), result.Items[0].FormKey);
    }
}
