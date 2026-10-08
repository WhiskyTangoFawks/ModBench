using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Indexing;

public sealed class MissingReferencePlacementTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("missing-ref-placement")
        .WithPlugin("Tracked.esp", mod => mod.Npcs.AddNew("Referrer").Race.SetTo(FormKey.Factory("000ABC:Absent.esp")), origin: "TrackedMod")
        .BuildScattered()
        .Tracked();

    private readonly OpenedIndex _index;
    private readonly LoadOrderEntry _tracked;

    public MissingReferencePlacementTests()
    {
        _tracked = _fixture.Plugins.Single();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private PluginProblems Problems() =>
        Assert.Single(_index.Problems.GetProblems() ?? throw new InvalidOperationException("Expected the index to be ready."));

    [Fact]
    public void ReportingMissingReferences_ATrackedReferrer_NamesItsDocumentRelativeToTheModFolder()
    {
        var problems = Problems();
        var problem = Assert.Single(problems.Problems);

        Assert.Null(problems.Failure);
        Assert.NotNull(problem.FormKey);
        Assert.Equal(
            _tracked.SourceFileOf(_index.DocumentOf(problem.FormKey, _tracked.KeyOf())),
            Path.Combine(_tracked.ModFolderOf(), problem.SourceRelativePath));
    }

    [Fact]
    public void ReportingMissingReferences_AReferrerWhoseDocumentWasDeletedOutsideModbench_IsAFailureNotAPath()
    {
        var problem = Assert.Single(Problems().Problems);
        Assert.NotNull(problem.FormKey);
        File.Delete(Path.Combine(_tracked.ModFolderOf(), problem.SourceRelativePath));

        var problems = Problems();

        Assert.Empty(problems.Problems);
        Assert.Contains(problem.FormKey, problems.Failure, StringComparison.Ordinal);
    }
}
