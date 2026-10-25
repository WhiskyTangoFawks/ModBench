using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Indexing;

public sealed class MissingReferencePlacementTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture = new PluginFixtureBuilder("missing-ref-placement")
        .WithPlugin("CompiledPlugin.esp", mod => mod.Npcs.AddNew("Referrer").Race.SetTo(FormKey.Factory("000ABC:Absent.esp")), origin: "SourceMod")
        .BuildScattered()
        .CompiledPlugin();

    private readonly OpenedIndex _index;
    private readonly LoadOrderEntry _compiledPlugin;

    public MissingReferencePlacementTests()
    {
        _compiledPlugin = _fixture.Plugins.Single();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private PluginProblems Problems() =>
        Assert.Single(_index.Queries.GetProblems().Value() ?? throw new InvalidOperationException("Expected the record index to be ready."));

    [Fact]
    public void ReportingMissingReferences_ACompiledPluginReferrer_NamesItsDocumentRelativeToTheModFolder()
    {
        var problems = Problems();
        var problem = Assert.Single(problems.Problems);

        Assert.Null(problems.Failure);
        Assert.NotNull(problem.FormKey);
        Assert.Equal(
            _compiledPlugin.SourceFileOf(_index.DocumentOf(problem.FormKey, _compiledPlugin.Key)),
            Path.Combine(_compiledPlugin.ModFolderOf(), problem.SourceRelativePath));
    }

    [Fact]
    public void ReportingMissingReferences_AReferrerWhoseDocumentWasDeletedOutsideModbench_IsAFailureNotAPath()
    {
        var problem = Assert.Single(Problems().Problems);
        Assert.NotNull(problem.FormKey);
        File.Delete(Path.Combine(_compiledPlugin.ModFolderOf(), problem.SourceRelativePath));

        var problems = Problems();

        Assert.Empty(problems.Problems);
        Assert.Contains(problem.FormKey, problems.Failure, StringComparison.Ordinal);
    }
}
