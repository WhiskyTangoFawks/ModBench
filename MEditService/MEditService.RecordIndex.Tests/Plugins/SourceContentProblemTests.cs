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

        using var index = Indexes.Reconciled(_fixture.DataFolder, [_fixture.Entry]);

        var problem = Assert.Single(index.SourceProblems());
        Assert.Equal((Relative(file), _fixture.Npc.ToString()), (problem.SourceRelativePath, problem.FormKey));
        Assert.Contains("NoSuchField", problem.Message, StringComparison.Ordinal);
        Assert.True(index.ReadFromItsPluginSource(_fixture.Plugin));
    }

    [Fact]
    public void AFileRenamedOutsideModbench_MovesItsProblemToTheNewPath_AtTheNextCheck_AndBackClearsIt()
    {
        using var index = Indexes.Reconciled(_fixture.DataFolder, [_fixture.Entry]);
        Assert.Empty(index.SourceProblems());
        var file = NpcFile;
        var renamed = Path.Combine(Path.GetDirectoryName(file) ?? "", "Renamed.json");

        File.Move(file, renamed);
        index.NextCheckUntil(() => index.SourceProblems().Count > 0, "the problem on the new path");

        Assert.Equal(Relative(renamed), Assert.Single(index.SourceProblems()).SourceRelativePath);

        File.Move(renamed, file);
        index.NextCheckUntil(() => index.SourceProblems().Count == 0, "the problem cleared");

        Assert.Empty(index.SourceProblems());
    }

    [Fact]
    public void AFileMovedOutsideModbenchIntoAnotherTypesFolder_IsAProblemOnItsNewPath_AndMovedBackClearsIt()
    {
        using var index = Indexes.Reconciled(_fixture.DataFolder, [_fixture.Entry]);
        var file = NpcFile;
        var misfiled = Path.Combine(Path.GetDirectoryName(Path.GetDirectoryName(file)) ?? "", "Globals", Path.GetFileName(file));
        _ = Directory.CreateDirectory(Path.GetDirectoryName(misfiled) ?? "");

        File.Move(file, misfiled);
        index.NextCheckUntil(() => index.SourceProblems().Count > 0, "the problem on the new path");

        Assert.Equal(Relative(misfiled), Assert.Single(index.SourceProblems()).SourceRelativePath);

        File.Move(misfiled, file);
        index.NextCheckUntil(() => index.SourceProblems().Count == 0, "the problem cleared");
    }
}
