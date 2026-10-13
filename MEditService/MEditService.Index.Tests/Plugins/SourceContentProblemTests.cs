using System.Text.RegularExpressions;
using MEditService.Index.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Index.Tests.Plugins;

public sealed class SourceContentProblemTests : IDisposable
{
    private readonly ContainerMod _fixture = new();

    public void Dispose() => _fixture.Dispose();

    private string NpcFile => _fixture.SourceFileContaining(ContainerMod.NpcEditorId);

    private string Relative(string path) => Path.GetRelativePath(_fixture.Entry.ModFolderOf(), path);

    [Fact]
    public void AFileWithAnUnknownField_IsNamed_WithTheField()
    {
        var file = NpcFile;
        File.WriteAllText(file, File.ReadAllText(file).Replace("\"FormKey\"", "\"NoSuchField\": 1,\n  \"FormKey\"", StringComparison.Ordinal));

        using var index = Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

        var problem = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(file), _fixture.Npc.ToString()), (problem.SourceRelativePath, problem.FormKey));
        Assert.Contains("NoSuchField", problem.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void AFlatRecordFiledUnderAnotherLeafName_IsAProblemOnItsFile_NamingWhereItBelongs()
    {
        var file = NpcFile;
        var misplaced = Path.Combine(Path.GetDirectoryName(file).Require(), "Renamed.json");
        File.Move(file, misplaced);

        using var index = Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

        var problem = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(misplaced), _fixture.Npc.ToString()), (problem.SourceRelativePath, problem.FormKey));
        Assert.Contains($"belongs at {Relative(file)}", problem.Message, StringComparison.Ordinal);
        Assert.NotNull(index.CopyIn(_fixture.Npc.ToString(), _fixture.Plugin));
    }

    [Fact]
    public void ABlockLevelDocumentWithAValueOfTheWrongType_IsAProblemOnItsFile()
    {
        var level = Directory.EnumerateFiles(_fixture.Entry.ModFolderOf(), "GroupRecordData.json", SearchOption.AllDirectories)
            .First(file => File.ReadAllText(file).Contains("BlockNumber", StringComparison.Ordinal));
        File.WriteAllText(level, Regex.Replace(File.ReadAllText(level), "\"BlockNumber\": -?\\d+", "\"BlockNumber\": \"text\""));

        using var index = Indexes.Reconciled(_fixture.GameDirectory, [_fixture.Entry]);

        var problem = Assert.Single(index.SourceProblems());
        Assert.Equal(Relative(level), problem.SourceRelativePath);
        Assert.Contains("BlockNumber", problem.Message, StringComparison.Ordinal);
    }
}
