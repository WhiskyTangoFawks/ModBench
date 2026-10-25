using System.Text.RegularExpressions;

namespace MEditService.Architecture.Tests;

public class GameCodecSeedTests
{
    private const string CompileTimeSeedDoor = "GameCodec.cs";
    private const string GameInterface = "IGameCodec.cs";
    private const string PluginBinaryAndTreeDoor = "PluginTrees.cs";
    private const string HeaderDocumentDoorBecauseModHeaderIsNoMajorRecordGetter = "HeaderDocument.cs";

    private static readonly Regex AnyGamesWholeModMixin = new(@"MutagenJsonConverter\w+ModMixIns", RegexOptions.Compiled);

    [Fact]
    public void CoreSources_NameNoGamesWholeModMixin()
    {
        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => AnyGamesWholeModMixin.IsMatch(File.ReadAllText(f)))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    public static TheoryData<string, string[]> WholeModDoorsAndTheFilesThatMayNameThem => new()
    {
        { "SerializeWholeMod", [CompileTimeSeedDoor, GameInterface, PluginBinaryAndTreeDoor, HeaderDocumentDoorBecauseModHeaderIsNoMajorRecordGetter] },
        { "DeserializeWholeMod", [CompileTimeSeedDoor, GameInterface, PluginBinaryAndTreeDoor, HeaderDocumentDoorBecauseModHeaderIsNoMajorRecordGetter] },
        { "MutagenJsonConverter.Instance", [CompileTimeSeedDoor] },
    };

    [Theory]
    [MemberData(nameof(WholeModDoorsAndTheFilesThatMayNameThem))]
    public void TheWholeModSerializer_IsReachedOnlyThroughTheGameCodecsDoors(string name, string[] doorFiles)
    {
        var offendingFiles = ProductionSources()
            .Where(f => !doorFiles.Contains(Path.GetFileName(f), StringComparer.Ordinal))
            .Where(f => File.ReadAllText(f).Contains(name, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    private static List<string> ProductionSources() =>
        ServiceProjects.ProductionFiles(ServiceProjects.SolutionDirectory());
}
