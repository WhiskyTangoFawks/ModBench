using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>Runs against <see cref="ContainerModFixture"/>: a git-mediated revert of a container
/// or embedded child must reach the record editor, and the flat fixture cannot ask.</summary>
public sealed class ReadTimeFreshnessContainerTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private ProjectingEditService EditService() =>
        ProjectingEditService.Over(_fixture.Mirror);

    private IRecordQueryService Reads() =>
        new RecordQueryService(_fixture.Mirror, SharedSchemaReflector.Instance, new ConflictClassifier());

    private static JsonElement Json(string raw) => JsonDocument.Parse(raw).RootElement;

    private void Git(params string[] args) =>
        GitCli.Run(Path.Combine(_fixture.ModFolder, ".git"), _fixture.ModFolder, args);

    private string RelativePath(string absolutePath) => Path.GetRelativePath(_fixture.ModFolder, absolutePath);

    [Fact]
    public void ReadingAQuestWithChildren_LeavesItsIndexedBodyClean()
    {
        Assert.NotNull(Reads().GetRecord(_fixture.Quest.ToString()));

        _fixture.Mirror.Settle();

        var index = _fixture.Mirror.Index!;
        var effective = index.At(Core.Records.RecordRef.Effective).GetDocument(_fixture.Quest.ToString(), _fixture.Plugin)!.Body;
        var head = index.At(Core.Records.RecordRef.Head).GetDocument(_fixture.Quest.ToString(), _fixture.Plugin)!.Body;

        Assert.Equal(head, effective);
    }

    [Fact]
    public void RevertingAQuestsSourceFile_PutsTheCommittedValueBackInTheRecordEditor()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);

        var applied = EditService().Set(_fixture.Plugin, _fixture.Quest.ToString(), "Filter", Json("\"EditedFilter\""));
        Assert.True(applied.Applied, applied.Message);
        Assert.Equal(
            "EditedFilter",
            Reads().GetRecord(_fixture.Quest.ToString())!.Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());

        // The gesture a user makes in the Source Control panel's "Discard Changes".
        Git("restore", "--", RelativePath(file).Replace('\\', '/'));
        Assert.Empty(_fixture.GitStatus());

        Assert.NotEqual(
            "EditedFilter",
            Reads().GetRecord(_fixture.Quest.ToString())!.Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());
    }

    [Fact]
    public void RevertingAQuestsSourceFile_PutsTheCommittedValueBackInTheCompareGrid()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.QuestEditorId);

        var applied = EditService().Set(_fixture.Plugin, _fixture.Quest.ToString(), "Filter", Json("\"EditedFilter\""));
        Assert.True(applied.Applied, applied.Message);
        Assert.Equal(
            "EditedFilter",
            Reads().GetCompare(_fixture.Quest.ToString())!.Overrides.Single()
                .Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());

        Git("restore", "--", RelativePath(file).Replace('\\', '/'));
        Assert.Empty(_fixture.GitStatus());

        Assert.NotEqual(
            "EditedFilter",
            Reads().GetCompare(_fixture.Quest.ToString())!.Overrides.Single()
                .Fields.Single(f => f.Metadata.Name == "Filter").Value?.ToString());
    }

    [Fact]
    public void RevertingAPlacedRefsOwningCellFile_PutsTheCommittedValueBackInTheRecordEditor()
    {
        var file = _fixture.SourceFileContaining(ContainerModFixture.EmbedCellEditorId);

        var applied = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));
        Assert.True(applied.Applied, applied.Message);
        Assert.Equal(
            2.5f,
            Assert.IsType<JsonElement>(Reads().GetRecord(_fixture.TemporaryRef.ToString())!.Fields.Single(f => f.Metadata.Name == "Scale").Value).GetSingle());

        Git("restore", "--", RelativePath(file).Replace('\\', '/'));
        Assert.Empty(_fixture.GitStatus());

        Assert.NotEqual(
            2.5f,
            (Reads().GetRecord(_fixture.TemporaryRef.ToString())!.Fields.Single(f => f.Metadata.Name == "Scale").Value as JsonElement?)?.GetSingle());
    }
}
