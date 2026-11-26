using System.Globalization;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;

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

        using var index = Indexes.Reconciled(_fixture.DataFolder, [_fixture.Entry]);

        var problem = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(file), _fixture.Npc.ToString()), (problem.SourceRelativePath, problem.FormKey));
        Assert.Contains("NoSuchField", problem.Message, StringComparison.Ordinal);
        Assert.True(index.ReadFromItsPluginSource(_fixture.Plugin));
    }

    [Theory]
    [InlineData("Renamed.json")]
    [InlineData("../Globals/{0}")]
    public void AFileMisplacedOutsideModbench_IsAProblemOnItsNewPath_AtTheNextCheck_AndPutBackClearsIt(string movedTo)
    {
        using var index = Indexes.Reconciled(_fixture.DataFolder, [_fixture.Entry]);
        var file = NpcFile;
        var moved = Path.GetFullPath(Path.Combine(
            Path.GetDirectoryName(file).Require(), string.Format(CultureInfo.InvariantCulture, movedTo, Path.GetFileName(file))));
        _ = Directory.CreateDirectory(Path.GetDirectoryName(moved).Require());

        File.Move(file, moved);
        index.NextCheckUntil(() => index.SourceProblems().Count > 0, "the problem on the new path");

        Assert.Equal(Relative(moved), Assert.Single(index.SourceProblems()).SourceRelativePath);

        File.Move(moved, file);
        index.NextCheckUntil(() => index.SourceProblems().Count == 0, "the problem cleared");
    }
}
