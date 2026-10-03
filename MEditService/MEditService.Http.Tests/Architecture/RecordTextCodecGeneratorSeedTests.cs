using System.Runtime.CompilerServices;

namespace MEditService.Http.Tests.Architecture;

public class RecordTextCodecGeneratorSeedTests
{
    private const string CompileTimeSeedDoor = "RecordTextCodecGeneratorSeed.cs";
    private const string PluginBinaryAndTreeDoor = "PluginTrees.cs";
    private const string PluginHeaderDocumentDoor = "HeaderDocument.cs";

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
    public void CoreSources_CallSerializeWholeModOnlyFromDesignatedDoorFiles()
    {
        const string gatewayMethodName = "SerializeWholeMod";
        const string gatewayFile = CompileTimeSeedDoor;
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            PluginBinaryAndTreeDoor,
            PluginHeaderDocumentDoor,
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
    public void CoreSources_CallDeserializeWholeModOnlyFromDesignatedDoorFiles()
    {
        const string gatewayMethodName = "DeserializeWholeMod";
        const string gatewayFile = CompileTimeSeedDoor;
        var designatedDoors = new HashSet<string>(StringComparer.Ordinal)
        {
            PluginBinaryAndTreeDoor,
            PluginHeaderDocumentDoor,
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

    [Fact]
    public void DoorFiles_NeverNameTheParallelWorkDropoffThatRacesInMajorRecordListParallelHelper()
    {
        const string parallelDropoffName = "ParallelWorkDropoff";
        var doorFiles = new[] { "TrackService.cs", PluginBinaryAndTreeDoor, PluginHeaderDocumentDoor };

        var sourceFiles = ProductionSources()
            .Where(f => doorFiles.Contains(Path.GetFileName(f)))
            .ToList();
        Assert.NotEmpty(sourceFiles);

        var offendingFiles = sourceFiles
            .Where(f => File.ReadAllText(f).Contains(parallelDropoffName, StringComparison.Ordinal))
            .Select(Path.GetFileName)
            .ToList();

        Assert.Empty(offendingFiles);
    }

    private static readonly string[] ProductionProjects =
    [
        "MEditService.Codec", "MEditService.Commands", "MEditService.Http", "MEditService.Index",
        "MEditService.LoadOrder", "MEditService.PluginAdapter", "MEditService.Ports",
        "MEditService.Queries", "MEditService.SourceAdapter",
    ];

    private static string[] ProductionSources([CallerFilePath] string here = "")
    {
        var hereDirectory = Path.GetDirectoryName(here)
            ?? throw new InvalidOperationException($"Expected '{here}' to have a directory.");
        var solution = Path.GetFullPath(Path.Combine(hereDirectory, "..", ".."));
        return [.. ProductionProjects.SelectMany(
            project => Directory.GetFiles(Path.Combine(solution, project), "*.cs", SearchOption.AllDirectories))];
    }
}
