using System.Diagnostics;
using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #566's own acceptance criterion, asserted where the maintainer saw the defect: the Source Control
/// panel. Deleting one child of an ordered folder-split container is <b>one file deletion plus one
/// changed parent document</b>, and no renames at all.
///
/// <para><b>Why this asserts on real <c>git status</c> rather than on the tree.</b> The original
/// report was not "the files are wrong" — the files were right under the numbering scheme too. It was
/// that a single-record delete showed up as 25 changed entries, because renaming every later sibling
/// to keep <c>[N]</c> prefixes contiguous is a content-identical rename that unstaged
/// <c>git status</c> cannot pair up and collapse (verified then, and not fixable by git config).
/// Asserting the porcelain is asserting the thing that was actually broken; a tree-shape assertion
/// would have passed before the change as happily as after it.</para>
/// </summary>
public sealed class MidListDeleteStagesWithoutRenamesTests : IClassFixture<ContainerModFixture>, IDisposable
{
    private readonly ContainerModFixture _fixture;

    public MidListDeleteStagesWithoutRenamesTests(ContainerModFixture fixture)
    {
        _fixture = fixture;
        // Track leaves the tree committed and clean; anything this test then sees is its own doing.
        Assert.Equal(string.Empty, GitStatus());
    }

    public void Dispose() => Git("checkout", "--", ".");

    [Fact]
    public void DeletingOneOfThreeDialogTopics_StagesOneDeletionAndOneChangedParent_WithNoRenames()
    {
        var topicFile = _fixture.SourceFileContaining(ContainerModFixture.DialogTopic2EditorId);
        var questDirectory = Path.GetDirectoryName(Path.GetDirectoryName(Path.GetDirectoryName(topicFile)!)!)!;
        var carrier = SourceChildOrder.CarrierFor(questDirectory, parentIsRecord: true);

        var before = SourceChildOrder.ListAt(carrier, "DialogTopics");
        Assert.Equal(3, before.Count);

        var result = EditService().DeleteRecord(_fixture.Plugin, _fixture.DialogTopic2.ToString());
        Assert.True(result.Applied, result.Message);

        // The parent's list closed up: the deleted child is gone, the other two keep their order.
        Assert.Equal(
            [_fixture.DialogTopic.ToString(), _fixture.DialogTopic3.ToString()],
            SourceChildOrder.ListAt(carrier, "DialogTopics"));

        var entries = GitStatus()
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            // git quotes a path containing spaces, which every EditorID-bearing name has.
            .Select(line => (Code: line[..2].Trim(), Path: line[3..].Trim('"')))
            .ToList();

        // Exactly two entries, and neither is a rename. Under the superseded numbering scheme this
        // was one deletion plus a rename for every sibling after the deleted one.
        Assert.All(entries, e => Assert.DoesNotContain("R", e.Code, StringComparison.Ordinal));

        var deletions = entries.Where(e => e.Code.Contains('D')).ToList();
        var modifications = entries.Where(e => e.Code.Contains('M')).ToList();

        var deleted = Assert.Single(deletions);
        Assert.Contains(ContainerModFixture.DialogTopic2EditorId, deleted.Path, StringComparison.Ordinal);

        var modified = Assert.Single(modifications);
        Assert.EndsWith("RecordData.json", modified.Path, StringComparison.Ordinal);

        Assert.Equal(2, entries.Count);
    }

    private RecordEditService EditService() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private string GitStatus() => Git("status", "--porcelain");

    private string Git(params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = _fixture.ModFolder, RedirectStandardOutput = true };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);

        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit();
        return output;
    }
}
