using MEditService.TestSupport;

namespace MEditService.Http.Tests.Architecture;

public class RecordTextCodecGeneratorSeedTests
{
    private const string CompileTimeSeedDoor = "RecordTextCodecGeneratorSeed.cs";
    private const string PluginBinaryAndTreeDoor = "PluginTrees.cs";
    private const string HeaderDocumentDoorBecauseModHeaderIsNoMajorRecordGetter = "HeaderDocument.cs";

    [Fact]
    public void CoreSources_NameTheWholeModMixinOnlyInTheDesignatedDoorFiles()
    {
        const string mixinTypeName = "MutagenJsonConverterFallout4ModMixIns";
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            CompileTimeSeedDoor,
            PluginBinaryAndTreeDoor,
        };

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => !designatedDoors.Contains(Path.GetFileName(f)))
            .Where(f => File.ReadAllText(f).Contains(mixinTypeName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    [Fact]
    public void CoreSources_CallSerializeWholeModOnlyFromDesignatedDoorFiles_ScannedByMethodNameSinceExtensionSyntaxDoesNotSpellTheStaticClass()
    {
        const string gatewayMethodName = "SerializeWholeMod";
        const string gatewayFile = CompileTimeSeedDoor;
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            PluginBinaryAndTreeDoor,
            HeaderDocumentDoorBecauseModHeaderIsNoMajorRecordGetter,
        };

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => Path.GetFileName(f) != gatewayFile && !designatedDoors.Contains(Path.GetFileName(f)))
            .Where(f => File.ReadAllText(f).Contains(gatewayMethodName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    [Fact]
    public void CoreSources_CallDeserializeWholeModOnlyFromDesignatedDoorFiles_ASeparateScanBecauseTheCaseSensitiveSerializeSearchMissesIt()
    {
        const string gatewayMethodName = "DeserializeWholeMod";
        const string gatewayFile = CompileTimeSeedDoor;
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            PluginBinaryAndTreeDoor,
            HeaderDocumentDoorBecauseModHeaderIsNoMajorRecordGetter,
        };

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => Path.GetFileName(f) != gatewayFile && !designatedDoors.Contains(Path.GetFileName(f)))
            .Where(f => File.ReadAllText(f).Contains(gatewayMethodName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    [Fact]
    public void CoreSources_NameTheBootstrapReceiverOnlyInTheGatewayFile()
    {
        const string bootstrapReceiver = "MutagenJsonConverter.Instance";
        const string gatewayFile = CompileTimeSeedDoor;

        var sourceFiles = ProductionSources();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => Path.GetFileName(f) != gatewayFile)
            .Where(f => File.ReadAllText(f).Contains(bootstrapReceiver, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    private static readonly IReadOnlyList<string> ProductionProjects =
        ServiceProjects.Production(ServiceProjects.SolutionDirectory());

    private static string[] ProductionSources() =>
        [.. ProductionProjects.SelectMany(project => SourceTree.CSharpFiles(
            ServiceProjects.Folder(ServiceProjects.SolutionDirectory(), project)))];
}
