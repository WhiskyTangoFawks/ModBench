using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using static MEditService.Commands.Tests.TestSupport.Envelopes;

namespace MEditService.Commands.Tests.Edits;

public sealed class EmbeddedChildEditTests : IDisposable
{
    private readonly ContainerModFixture _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private TestEditor EditService() => _fixture.EditHandler;

    private string ChildBody() => _fixture.Document(_fixture.TemporaryRef.ToString()).Require().Body;

    private string WorkingTreeCell() => _fixture.Document(_fixture.EmbedCell.ToString()).Require().Body;

    [Fact]
    public void EditingAnEmbeddedChild_RewritesItsOwnersDocument_ThatDivergesFromHead_AndTheChildReadsItBack()
    {
        Assert.Empty(_fixture.ChangedFormKeys());
        var (cellBefore, childBefore) = (WorkingTreeCell(), ChildBody());

        var result = EditService().Set(_fixture.Plugin, _fixture.TemporaryRef.ToString(), "Scale", Json("2.5"));

        Assert.True(result.Applied, result.Message);
        Assert.Equal([_fixture.TemporaryRef.ToString()], _fixture.ChangedFormKeys());
        Assert.Equal(["Temporary[0].Scale: 1.0 -> 2.5"], DocumentDiffs.Of(cellBefore, WorkingTreeCell()));
        Assert.Equal(["Scale: 1.0 -> 2.5"], DocumentDiffs.Of(childBefore, ChildBody()));
    }

    [Fact]
    public void AnExteriorTemporaryRefMovedOutsideItsCellsGrid_StaysInItsOwnCellsDocument()
    {
        var outsideGrid = "\"90000, -90000, 0\"";
        var before = _fixture.DocumentCarrying("ExteriorCell").Body;

        var result = EditService().Set(_fixture.Plugin, _fixture.ExteriorRef.ToString(), "Position", Json(outsideGrid));

        Assert.True(result.Applied, result.Message);
        Assert.Equal(["""Temporary[0].Position: "100, 100, 0" -> "90000, -90000, 0" """.TrimEnd()], DocumentDiffs.Of(before, _fixture.DocumentCarrying("ExteriorCell").Body));
        Assert.Equal([_fixture.ExteriorRef.ToString()], _fixture.ChangedFormKeys());
    }

    [Fact]
    public void EditingAQuestsEditorId_RenamesItsDirectory_AndItsChildrensFilesMoveWithIt()
    {
        Assert.True(EditService().Set(_fixture.Plugin, _fixture.Quest.ToString(), "EditorID", Json("\"RenamedQuest\"")).Applied);

        var directory = Path.GetDirectoryName(_fixture.DocumentFile(_fixture.Quest.ToString())).Require();
        Assert.StartsWith("RenamedQuest - ", Path.GetFileName(directory), StringComparison.Ordinal);
        Assert.All(
            new[] { _fixture.DialogTopic, _fixture.Response, _fixture.DialogBranch, _fixture.Scene },
            child => Assert.StartsWith(directory + Path.DirectorySeparatorChar, _fixture.DocumentFile(child.ToString()), StringComparison.Ordinal));
    }
}
