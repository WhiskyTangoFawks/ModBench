using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// The container/embedded-child counterpart to <see cref="ReadTimeFreshnessTests"/>: the same
/// "git-mediated revert must be picked up at the next read" behaviour that suite pins for a
/// flat record (an Npc), pinned here for a directory-per-record container (a Quest) and for an
/// embedded child (a placed reference) — the two shapes a <c>SourceFreshness.ValidateOne</c> that
/// resolved a record's source through the flat-only
/// <c>SourceUnitResolver.FlatSourcePath</c> (which throws <c>NotSupportedException</c> for both)
/// skipped entirely: the caller's own catch turned that into "serve the indexed state", so a git
/// revert of either shape's source file never reached the record editor.
///
/// <para>Runs against <see cref="ContainerModFixture"/> rather than <see cref="TrackedModFixture"/>,
/// which holds only flat records and structurally cannot exercise either shape.</para>
/// </summary>
public sealed class ReadTimeFreshnessContainerTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_fixture.Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, args);

    private string RelativePath(string absolutePath) => Path.GetRelativePath(_fixture.ModFolder, absolutePath);

    /// <summary>
    /// The container case: a Quest's own <c>RecordData.json</c> — no flat path
    /// <c>SourceRecordPath.For</c> can compute, only found on disk.
    ///
    /// <para><c>filter</c> rather than <c>editor_id</c> deliberately: an EditorID edit renames the
    /// Quest's own directory, which would entangle the git-restore step below with a
    /// rename instead of a pure content revert. <c>filter</c> is an ordinary scalar field with no such
    /// side effect.</para>
    /// </summary>
    [Fact]
    public void RevertingAQuestsSourceFile_PutsTheCommittedValueBackInTheRecordEditor()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);

        var applied = EditService().EditField(_fixture.Plugin, _fixture.Quest.ToString(), "filter", Json("\"EditedFilter\""));
        Assert.True(applied.Applied, applied.Message);
        Assert.Equal(
            "EditedFilter",
            Reads().GetRecord(_fixture.Quest.ToString())!.Fields.Single(f => f.Metadata.Name == "filter").Value);

        // The gesture a user makes in the Source Control panel's "Discard Changes".
        Git("restore", "--", RelativePath(file).Replace('\\', '/'));
        Assert.Empty(_fixture.GitStatus());

        Assert.NotEqual(
            "EditedFilter",
            Reads().GetRecord(_fixture.Quest.ToString())!.Fields.Single(f => f.Metadata.Name == "filter").Value);
    }

    /// <summary>
    /// "The record editor <b>and compare grid</b>": the flat-record precedent
    /// (<c>ReadTimeFreshnessTests.RestoringASourceFileThroughGit_PutsTheCommittedValueBackInTheCompareGrid</c>)
    /// has a dedicated <c>GetCompare</c> assertion alongside its <c>GetRecord</c> one; this is that
    /// same coverage for a container, reusing the Quest case above rather than asserting only through
    /// the record editor and assuming the compare grid follows because the plumbing is shared.
    /// </summary>
    [Fact]
    public void RevertingAQuestsSourceFile_PutsTheCommittedValueBackInTheCompareGrid()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);

        var applied = EditService().EditField(_fixture.Plugin, _fixture.Quest.ToString(), "filter", Json("\"EditedFilter\""));
        Assert.True(applied.Applied, applied.Message);
        Assert.Equal(
            "EditedFilter",
            Reads().GetCompare(_fixture.Quest.ToString())!.Overrides.Single()
                .Fields.Single(f => f.Metadata.Name == "filter").Value);

        Git("restore", "--", RelativePath(file).Replace('\\', '/'));
        Assert.Empty(_fixture.GitStatus());

        Assert.NotEqual(
            "EditedFilter",
            Reads().GetCompare(_fixture.Quest.ToString())!.Overrides.Single()
                .Fields.Single(f => f.Metadata.Name == "filter").Value);
    }

    /// <summary>
    /// The embedded-child case: a placed reference, which has no source file of its own at all — its
    /// text lives inline inside its owning Cell's <c>RecordData.json</c> (one of the five slots
    /// Spriggit serializes this way). Reverting the <i>owner's</i> file — the only file git
    /// tracks for this record — must still restore the committed value for the child.
    /// </summary>
    [Fact]
    public void RevertingAPlacedRefsOwningCellFile_PutsTheCommittedValueBackInTheRecordEditor()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);

        var applied = EditService().EditField(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "scale", Json("2.5"));
        Assert.True(applied.Applied, applied.Message);
        Assert.Equal(
            2.5f,
            Reads().GetRecord(_fixture.TemporaryRef.ToString())!.Fields.Single(f => f.Metadata.Name == "scale").Value);

        Git("restore", "--", RelativePath(file).Replace('\\', '/'));
        Assert.Empty(_fixture.GitStatus());

        Assert.NotEqual(
            2.5f,
            Reads().GetRecord(_fixture.TemporaryRef.ToString())!.Fields.Single(f => f.Metadata.Name == "scale").Value);
    }
}
