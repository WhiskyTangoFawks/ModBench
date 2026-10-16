using MEditService.RecordIndex.Tests.TestSupport;

namespace MEditService.RecordIndex.Tests.Plugins;

public sealed class SourceContentProblemTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string NpcFile => _fixture.SourceFileContaining(ContainerMod.NpcEditorId);

    private string Relative(string path) => Path.GetRelativePath(_fixture.Entry.ModFolderOf(), path);

    [Fact]
    public void ASavedFileWithAnUnknownField_IsAProblemOnItsFile_AndThePluginStaysItsSource()
    {
        var file = NpcFile;
        File.WriteAllText(file, File.ReadAllText(file).Replace("\"FormKey\"", "\"NoSuchField\": 1,\n  \"FormKey\"", StringComparison.Ordinal));

        using var index = Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

        var problem = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(file), _fixture.Npc.ToString()), (problem.SourceRelativePath, problem.FormKey));
        Assert.Contains("NoSuchField", problem.Message, StringComparison.Ordinal);
        Assert.True(index.ReadFromItsPluginSource(_fixture.Plugin));
    }
}
